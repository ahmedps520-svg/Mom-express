-- MomExpress database.
--
-- Everything lives in its own "momexpress" schema, which is not exposed through
-- the Supabase REST API. The app talks to it only through the public.mx_*
-- functions at the end of this file. They check who is calling, enforce the
-- request lifecycle and return JSON in the shape the app expects. Realtime reads
-- the request history and notifications tables directly, limited by row-level
-- security to what each person may see.

create schema if not exists momexpress;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Nothing in this schema is usable by default; access is granted explicitly below.
revoke all on schema momexpress from public;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table momexpress.members (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9._-]{2,32}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  role         text not null check (role in ('mom', 'runner')),
  prefs        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  disabled_at  timestamptz
);

create table momexpress.requests (
  id                 bigint generated always as identity primary key,
  requester_id       uuid not null references momexpress.members (user_id),
  runner_id          uuid references momexpress.members (user_id),
  client_request_id  text not null,
  title              text not null,
  description        text not null default '',
  location           text not null,
  priority           text not null check (priority in ('normal', 'high', 'urgent')),
  notes              text not null default '',
  quick_type         text check (quick_type in ('water', 'snack', 'help', 'medicine')),
  status             text not null check (status in ('pending', 'accepted', 'in_progress', 'delivered', 'declined', 'cancelled')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  accepted_at        timestamptz,
  started_at         timestamptz,
  delivered_at       timestamptz,
  declined_at        timestamptz,
  cancelled_at       timestamptz,
  eta_at             timestamptz,
  eta_set_at         timestamptz,
  decline_reason     text,
  cancel_reason      text,
  cancelled_by       uuid references momexpress.members (user_id),
  details_updated_at timestamptz,
  version            integer not null default 1,
  unique (requester_id, client_request_id)
);
create index requests_status_idx on momexpress.requests (status);
create index requests_requester_idx on momexpress.requests (requester_id, id);

create table momexpress.request_events (
  id         bigint generated always as identity primary key,
  request_id bigint not null references momexpress.requests (id) on delete cascade,
  actor_id   uuid references momexpress.members (user_id),
  type       text not null,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index request_events_request_idx on momexpress.request_events (request_id, id);

create table momexpress.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references momexpress.members (user_id) on delete cascade,
  request_id bigint references momexpress.requests (id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text not null,
  priority   text,
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  -- 'pending' while a push is waiting to go out; each is sent at most once.
  push_state text not null default 'none' check (push_state in ('none', 'pending', 'sent'))
);
create index notifications_user_idx on momexpress.notifications (user_id, id);
create index notifications_unread_idx on momexpress.notifications (user_id) where read_at is null;

-- A device's push subscription belongs to the sign-in session that created it,
-- so signing out stops that device getting the previous person's notifications.
create table momexpress.push_subscriptions (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references momexpress.members (user_id) on delete cascade,
  session_id      uuid,
  endpoint        text not null unique,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count   integer not null default 0
);
create index push_subscriptions_user_idx on momexpress.push_subscriptions (user_id);

-- Private settings: the push function's address and its VAPID keys.
create table momexpress.settings (
  key   text primary key,
  value text not null
);

alter table momexpress.members enable row level security;
alter table momexpress.requests enable row level security;
alter table momexpress.request_events enable row level security;
alter table momexpress.notifications enable row level security;
alter table momexpress.push_subscriptions enable row level security;
alter table momexpress.settings enable row level security;

-- ---------------------------------------------------------------------------
-- Delivery records are permanent: finished requests can't change, history is
-- append-only, and nothing can be deleted except by the database owner doing
-- maintenance in the SQL editor.
-- ---------------------------------------------------------------------------

create function momexpress.protect_requests() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if current_user not in ('postgres', 'supabase_admin') then
      raise exception 'delivery records cannot be deleted';
    end if;
    return old;
  end if;
  if old.status in ('delivered', 'declined', 'cancelled') then
    raise exception 'finished requests cannot be changed';
  end if;
  return new;
end $$;

create trigger requests_protect before update or delete on momexpress.requests
  for each row execute function momexpress.protect_requests();

create function momexpress.protect_events() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and current_user in ('postgres', 'supabase_admin') then
    return old;
  end if;
  raise exception 'request history is append-only';
end $$;

create trigger request_events_protect before update or delete on momexpress.request_events
  for each row execute function momexpress.protect_events();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create function momexpress.ms(ts timestamptz) returns bigint
language sql immutable set search_path = '' as $$
  select (extract(epoch from ts) * 1000)::bigint
$$;

create function momexpress.now_ms() returns bigint
language sql stable set search_path = '' as $$
  select momexpress.ms(clock_timestamp())
$$;

-- Raises an error the app understands. PostgREST turns SQLSTATE "PTnnn" into
-- HTTP status nnn; the hint carries a short code and the detail carries JSON.
create function momexpress.fail(p_status integer, p_code text, p_message text, p_detail jsonb default null)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception using
    errcode = 'PT' || p_status::text,
    message = p_message,
    hint = p_code,
    detail = coalesce(p_detail::text, '');
end $$;

create function momexpress.collapse(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')
$$;

create function momexpress.tidy(p text) returns text
language sql immutable set search_path = '' as $$
  select btrim(replace(coalesce(p, ''), E'\r\n', E'\n'))
$$;

create function momexpress.default_prefs(p_role text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'push', case when p_role = 'mom'
      then '{"accepted":true,"started":true,"eta_updated":true,"delivered":true,"declined":true,"cancelled":true,"submitted":false}'::jsonb
      else '{"new_request":true,"cancelled":true,"details_updated":true}'::jsonb end,
    'sound', true,
    'theme', 'system')
$$;

create function momexpress.member_json(m momexpress.members) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', m.user_id,
    'username', m.username,
    'displayName', m.display_name,
    'role', m.role,
    'prefs', momexpress.default_prefs(m.role) || m.prefs
      || jsonb_build_object('push', (momexpress.default_prefs(m.role) -> 'push') || coalesce(m.prefs -> 'push', '{}'::jsonb)))
$$;

-- The signed-in member, or an error if the caller isn't an active member.
create function momexpress.require_member() returns momexpress.members
language plpgsql stable security definer set search_path = '' as $$
declare
  me momexpress.members;
begin
  select * into me from momexpress.members where user_id = auth.uid() and disabled_at is null;
  if not found then
    if auth.uid() is null then
      perform momexpress.fail(401, 'unauthenticated', 'Please sign in to continue.');
    end if;
    perform momexpress.fail(403, 'not_a_member', 'This account isn’t part of MomExpress.');
  end if;
  return me;
end $$;

-- Row-level security check: runners see every request, requesters only their own.
create function momexpress.can_view_request(p_requester uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from momexpress.members m
    where m.user_id = auth.uid() and m.disabled_at is null
      and (m.role = 'runner' or m.user_id = p_requester))
$$;

create function momexpress.request_json(p_id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id,
    'title', r.title,
    'description', r.description,
    'location', r.location,
    'priority', r.priority,
    'notes', r.notes,
    'quickType', r.quick_type,
    'status', r.status,
    'requester', jsonb_build_object('id', r.requester_id, 'displayName', rq.display_name),
    'runner', case when r.runner_id is null then null
      else jsonb_build_object('id', r.runner_id, 'displayName', rn.display_name) end,
    'createdAt', momexpress.ms(r.created_at),
    'updatedAt', momexpress.ms(r.updated_at),
    'acceptedAt', momexpress.ms(r.accepted_at),
    'startedAt', momexpress.ms(r.started_at),
    'deliveredAt', momexpress.ms(r.delivered_at),
    'declinedAt', momexpress.ms(r.declined_at),
    'cancelledAt', momexpress.ms(r.cancelled_at),
    'etaAt', momexpress.ms(r.eta_at),
    'etaSetAt', momexpress.ms(r.eta_set_at),
    'declineReason', r.decline_reason,
    'cancelReason', r.cancel_reason,
    'cancelledBy', case when r.cancelled_by is null then null
      else jsonb_build_object('id', r.cancelled_by, 'displayName', cb.display_name) end,
    'detailsUpdatedAt', momexpress.ms(r.details_updated_at),
    'clientRequestId', r.client_request_id,
    'version', r.version)
  from momexpress.requests r
  join momexpress.members rq on rq.user_id = r.requester_id
  left join momexpress.members rn on rn.user_id = r.runner_id
  left join momexpress.members cb on cb.user_id = r.cancelled_by
  where r.id = p_id
$$;

create function momexpress.event_json(p_id bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', e.id,
    'requestId', e.request_id,
    'requestTitle', r.title,
    'type', e.type,
    'actor', case when e.actor_id is null then null
      else jsonb_build_object('id', e.actor_id, 'displayName', m.display_name) end,
    'data', e.data,
    'createdAt', momexpress.ms(e.created_at))
  from momexpress.request_events e
  join momexpress.requests r on r.id = e.request_id
  left join momexpress.members m on m.user_id = e.actor_id
  where e.id = p_id
$$;

create function momexpress.notification_json(n momexpress.notifications) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', n.id,
    'type', n.type,
    'requestId', n.request_id,
    'title', n.title,
    'body', n.body,
    'createdAt', momexpress.ms(n.created_at),
    'readAt', momexpress.ms(n.read_at))
$$;

create function momexpress.add_event(p_request bigint, p_actor uuid, p_type text, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  new_id bigint;
begin
  insert into momexpress.request_events (request_id, actor_id, type, data)
  values (p_request, p_actor, p_type, coalesce(p_data, '{}'::jsonb))
  returning id into new_id;
  return momexpress.event_json(new_id);
end $$;

-- Records an in-app notification. Whether it also goes out as a push is
-- decided here, from the person's preferences and registered devices.
create function momexpress.notify(p_user uuid, p_type text, p_request bigint, p_title text, p_body text, p_priority text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m momexpress.members;
  wants_push boolean;
begin
  select * into m from momexpress.members where user_id = p_user;
  wants_push := coalesce((m.prefs -> 'push' ->> p_type)::boolean, (momexpress.default_prefs(m.role) -> 'push' ->> p_type)::boolean, true)
    and exists (select 1 from momexpress.push_subscriptions s where s.user_id = p_user);
  insert into momexpress.notifications (user_id, type, request_id, title, body, priority, push_state)
  values (p_user, p_type, p_request, p_title, p_body, p_priority, case when wants_push then 'pending' else 'none' end);
end $$;

create function momexpress.quote(p text) returns text
language sql immutable set search_path = '' as $$
  select '“' || p || '”'
$$;

create function momexpress.mutation(p_request bigint, p_event jsonb, p_already boolean default false)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'request', momexpress.request_json(p_request),
    'event', p_event,
    'alreadyApplied', p_already,
    'serverTime', momexpress.now_ms())
$$;

-- Locks a request the caller may see. Other people's requests look like they
-- don't exist. The row lock makes concurrent actions on one request take turns.
create function momexpress.lock_request(p_id bigint, me momexpress.members) returns momexpress.requests
language plpgsql security definer set search_path = '' as $$
declare
  r momexpress.requests;
begin
  select * into r from momexpress.requests where id = p_id for update;
  if not found or (me.role = 'mom' and r.requester_id <> me.user_id) then
    perform momexpress.fail(404, 'not_found', 'We couldn’t find that request.');
  end if;
  return r;
end $$;

-- The request lifecycle (mirrors shared/lifecycle.ts, which the app uses to
-- decide which buttons to show):
--   pending → accepted → in_progress → delivered, plus declined and cancelled.
-- Mom can cancel her request any time before it's delivered. The runner
-- declines pending requests and can cancel one they accepted, with a reason.
create function momexpress.check_action(p_action text, r momexpress.requests, me momexpress.members)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  runner_name text;
  is_owner boolean := me.role = 'mom' and r.requester_id = me.user_id;
  is_assigned boolean := me.role = 'runner' and r.runner_id = me.user_id;
  latest jsonb := jsonb_build_object('request', momexpress.request_json(r.id));
begin
  select display_name into runner_name from momexpress.members where user_id = r.runner_id;

  if me.role = 'mom' and not is_owner then
    perform momexpress.fail(403, 'forbidden', 'This request belongs to someone else.', latest);
  end if;

  if r.status in ('delivered', 'declined', 'cancelled') then
    perform momexpress.fail(409, 'invalid_state', case r.status
      when 'delivered' then 'This request has already been delivered.'
      when 'declined' then 'This request was declined.'
      else 'This request was cancelled.' end, latest);
  end if;

  case p_action
    when 'accept', 'decline' then
      if me.role <> 'runner' then perform momexpress.fail(403, 'forbidden', 'Only the runner can do that.', latest); end if;
      if r.status <> 'pending' then
        perform momexpress.fail(409, 'invalid_state',
          coalesce('Already accepted by ' || runner_name || '.', 'This request has already been accepted.'), latest);
      end if;
    when 'start' then
      if me.role <> 'runner' then perform momexpress.fail(403, 'forbidden', 'Only the runner can start a delivery.', latest); end if;
      if r.status = 'pending' then perform momexpress.fail(409, 'invalid_state', 'Accept the request before starting the delivery.', latest); end if;
      if not is_assigned then perform momexpress.fail(403, 'forbidden', coalesce(runner_name, 'Another runner') || ' is handling this request.', latest); end if;
      if r.status <> 'accepted' then perform momexpress.fail(409, 'invalid_state', 'This delivery is already on the way.', latest); end if;
    when 'set_eta' then
      if me.role <> 'runner' then perform momexpress.fail(403, 'forbidden', 'Only the runner can set the ETA.', latest); end if;
      if r.status = 'pending' then perform momexpress.fail(409, 'invalid_state', 'Accept the request before setting an ETA.', latest); end if;
      if not is_assigned then perform momexpress.fail(403, 'forbidden', coalesce(runner_name, 'Another runner') || ' is handling this request.', latest); end if;
    when 'deliver' then
      if me.role <> 'runner' then perform momexpress.fail(403, 'forbidden', 'Only the runner can mark a request as delivered.', latest); end if;
      if r.status = 'pending' then perform momexpress.fail(409, 'invalid_state', 'Accept and start the delivery before marking it delivered.', latest); end if;
      if not is_assigned then perform momexpress.fail(403, 'forbidden', coalesce(runner_name, 'Another runner') || ' is handling this request.', latest); end if;
      if r.status = 'accepted' then perform momexpress.fail(409, 'invalid_state', 'Start the delivery before marking it delivered.', latest); end if;
    when 'cancel' then
      if me.role = 'runner' then
        if r.status = 'pending' then perform momexpress.fail(409, 'invalid_state', 'Decline the request instead of cancelling it.', latest); end if;
        if not is_assigned then perform momexpress.fail(403, 'forbidden', coalesce(runner_name, 'Another runner') || ' is handling this request.', latest); end if;
      end if;
    when 'edit' then
      if me.role <> 'mom' then perform momexpress.fail(403, 'forbidden', 'Only the person who asked can edit a request.', latest); end if;
    else
      perform momexpress.fail(400, 'bad_action', 'Unknown action.');
  end case;
end $$;

-- Refuses an action if the request's details changed after the person last saw
-- them (e.g. the runner is about to deliver "Water" but Mom just changed it).
create function momexpress.check_seen_details(r momexpress.requests, p_seen_details_at bigint)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  mom_name text;
begin
  if p_seen_details_at is null then return; end if;
  if coalesce(momexpress.ms(r.details_updated_at), 0) > p_seen_details_at then
    select display_name into mom_name from momexpress.members where user_id = r.requester_id;
    perform momexpress.fail(409, 'details_changed',
      coalesce(mom_name, 'Someone') || ' just changed this request. Take a look before you continue.',
      jsonb_build_object('request', momexpress.request_json(r.id)));
  end if;
end $$;

create function momexpress.check_eta(p_minutes integer) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_minutes is not null and (p_minutes < 1 or p_minutes > 180) then
    perform momexpress.fail(400, 'validation_failed', 'The ETA must be between 1 and 180 minutes.',
      jsonb_build_object('fields', jsonb_build_object('etaMinutes', 'The ETA must be between 1 and 180 minutes.')));
  end if;
end $$;

create function momexpress.check_reason(p_reason text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  cleaned text := momexpress.collapse(p_reason);
begin
  if char_length(cleaned) > 200 then
    perform momexpress.fail(400, 'validation_failed', 'Keep the reason under 200 characters.',
      jsonb_build_object('fields', jsonb_build_object('reason', 'Keep the reason under 200 characters.')));
  end if;
  return nullif(cleaned, '');
end $$;

-- Validates request details, returning field messages (empty when all is well).
create function momexpress.detail_errors(p_title text, p_location text, p_priority text, p_description text, p_notes text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  errs jsonb := '{}'::jsonb;
begin
  if p_title is not null then
    if p_title = '' then errs := errs || '{"title":"Tell us what you need."}';
    elsif char_length(p_title) > 80 then errs := errs || '{"title":"Keep the title under 80 characters."}'; end if;
  end if;
  if p_location is not null then
    if p_location = '' then errs := errs || '{"location":"Choose where it should go."}';
    elsif char_length(p_location) > 40 then errs := errs || '{"location":"Keep the location under 40 characters."}'; end if;
  end if;
  if p_priority is not null and p_priority not in ('normal', 'high', 'urgent') then
    errs := errs || '{"priority":"Choose a priority."}';
  end if;
  if p_description is not null and char_length(p_description) > 500 then
    errs := errs || '{"description":"Keep the description under 500 characters."}';
  end if;
  if p_notes is not null and char_length(p_notes) > 500 then
    errs := errs || '{"notes":"Keep the notes under 500 characters."}';
  end if;
  return errs;
end $$;

create function momexpress.fail_fields(p_errors jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  first_message text;
begin
  if p_errors = '{}'::jsonb then return; end if;
  select value into first_message from jsonb_each_text(p_errors) limit 1;
  perform momexpress.fail(400, 'validation_failed', first_message, jsonb_build_object('fields', p_errors));
end $$;

-- ---------------------------------------------------------------------------
-- The app's API: reading
-- ---------------------------------------------------------------------------

create function public.mx_me() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
begin
  return jsonb_build_object(
    'user', momexpress.member_json(me),
    'serverTime', momexpress.now_ms(),
    'push', jsonb_build_object('publicKey', (select value from momexpress.settings where key = 'vapid_public_key')));
end $$;

create function public.mx_list_active() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
begin
  return jsonb_build_object(
    'requests', coalesce((
      select jsonb_agg(momexpress.request_json(r.id) order by r.id)
      from momexpress.requests r
      where r.status in ('pending', 'accepted', 'in_progress')
        and (me.role = 'runner' or r.requester_id = me.user_id)), '[]'::jsonb),
    'nextCursor', null,
    'serverTime', momexpress.now_ms());
end $$;

create function public.mx_list_history(p_status text default null, p_before bigint default null, p_limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  lim integer := least(greatest(coalesce(p_limit, 30), 1), 100);
  ids bigint[];
begin
  select array_agg(id order by id desc) into ids from (
    select r.id from momexpress.requests r
    where r.status in ('delivered', 'declined', 'cancelled')
      and (p_status is null or r.status = p_status)
      and r.id < coalesce(p_before, 9223372036854775807)
      and (me.role = 'runner' or r.requester_id = me.user_id)
    order by r.id desc
    limit lim + 1) page;
  ids := coalesce(ids, '{}');
  return jsonb_build_object(
    'requests', coalesce((select jsonb_agg(momexpress.request_json(i) order by i desc) from unnest(ids[1:lim]) i), '[]'::jsonb),
    'nextCursor', case when cardinality(ids) > lim then ids[lim] else null end,
    'serverTime', momexpress.now_ms());
end $$;

create function public.mx_get_request(p_id bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  r momexpress.requests;
begin
  select * into r from momexpress.requests where id = p_id;
  if not found or (me.role = 'mom' and r.requester_id <> me.user_id) then
    perform momexpress.fail(404, 'not_found', 'We couldn’t find that request.');
  end if;
  return jsonb_build_object(
    'request', momexpress.request_json(r.id),
    'events', coalesce((select jsonb_agg(momexpress.event_json(e.id) order by e.id)
                        from momexpress.request_events e where e.request_id = r.id), '[]'::jsonb),
    'serverTime', momexpress.now_ms());
end $$;

create function public.mx_activity(p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
begin
  return jsonb_build_object('events', coalesce((
    select jsonb_agg(momexpress.event_json(x.id) order by x.id desc) from (
      select e.id from momexpress.request_events e
      join momexpress.requests r on r.id = e.request_id
      where me.role = 'runner' or r.requester_id = me.user_id
      order by e.id desc
      limit least(greatest(coalesce(p_limit, 20), 1), 50)) x), '[]'::jsonb));
end $$;

create function public.mx_stats(p_since bigint) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  n integer;
  avg_ms double precision;
begin
  select count(*), avg(extract(epoch from (delivered_at - created_at)) * 1000)
    into n, avg_ms
  from momexpress.requests
  where status = 'delivered'
    and delivered_at >= to_timestamp(coalesce(p_since, 0) / 1000.0)
    and case when me.role = 'mom' then requester_id = me.user_id else runner_id = me.user_id end;
  return jsonb_build_object('deliveredToday', n, 'averageMinutesToday', case when avg_ms is null then null else round(avg_ms / 60000) end);
end $$;

create function public.mx_unread_count() returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::integer from momexpress.notifications
  where user_id = (momexpress.require_member()).user_id and read_at is null
$$;

create function public.mx_notifications(p_before bigint default null, p_limit integer default 40)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  lim integer := least(greatest(coalesce(p_limit, 40), 1), 100);
  rows jsonb[];
begin
  select array_agg(momexpress.notification_json(n) order by n.id desc) into rows
  from momexpress.notifications n
  where n.id in (
    select id from momexpress.notifications
    where user_id = me.user_id and id < coalesce(p_before, 9223372036854775807)
    order by id desc limit lim + 1);
  rows := coalesce(rows, '{}');
  return jsonb_build_object(
    'notifications', coalesce(to_jsonb(rows[1:lim]), '[]'::jsonb),
    'unreadCount', (select count(*) from momexpress.notifications where user_id = me.user_id and read_at is null),
    'nextCursor', case when cardinality(rows) > lim then (rows[lim] ->> 'id')::bigint else null end);
end $$;

-- ---------------------------------------------------------------------------
-- The app's API: changes
-- ---------------------------------------------------------------------------

create function public.mx_create_request(
  p_client_request_id text,
  p_title text,
  p_location text,
  p_priority text,
  p_description text default '',
  p_notes text default '',
  p_quick_type text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  v_title text := momexpress.collapse(p_title);
  v_location text := momexpress.collapse(p_location);
  v_description text := momexpress.tidy(p_description);
  v_notes text := momexpress.tidy(p_notes);
  errs jsonb;
  new_id bigint;
  ev jsonb;
  runner record;
  runner_count integer;
  only_runner text;
begin
  if me.role <> 'mom' then
    perform momexpress.fail(403, 'forbidden', 'Only Mom can send requests.');
  end if;
  if p_client_request_id is null or p_client_request_id !~ '^[A-Za-z0-9_-]{8,64}$' then
    perform momexpress.fail(400, 'validation_failed', 'Invalid request id.');
  end if;
  errs := momexpress.detail_errors(v_title, v_location, coalesce(p_priority, ''), v_description, v_notes);
  if p_quick_type is not null and p_quick_type not in ('water', 'snack', 'help', 'medicine') then
    errs := errs || '{"quickType":"Unknown shortcut."}';
  end if;
  perform momexpress.fail_fields(errs);

  -- The same submission arriving twice (a double tap, or a retry after a
  -- dropped connection) returns the request that was already created.
  insert into momexpress.requests (requester_id, client_request_id, title, description, location, priority, notes, quick_type, status)
  values (me.user_id, p_client_request_id, v_title, v_description, v_location, p_priority, v_notes, p_quick_type, 'pending')
  on conflict (requester_id, client_request_id) do nothing
  returning id into new_id;
  if new_id is null then
    select id into new_id from momexpress.requests where requester_id = me.user_id and client_request_id = p_client_request_id;
    return momexpress.mutation(new_id, null, true) || '{"created":false}';
  end if;

  ev := momexpress.add_event(new_id, me.user_id, 'created', jsonb_build_object('priority', p_priority, 'location', v_location));
  -- Remember where Mom usually wants things, to pre-select it next time.
  update momexpress.members set prefs = prefs || jsonb_build_object('lastLocation', v_location) where user_id = me.user_id;

  select count(*), min(display_name) into runner_count, only_runner
  from momexpress.members where role = 'runner' and disabled_at is null;
  for runner in select user_id from momexpress.members where role = 'runner' and disabled_at is null loop
    perform momexpress.notify(runner.user_id, 'new_request', new_id,
      case p_priority
        when 'urgent' then 'Urgent request from ' || me.display_name
        when 'high' then 'High-priority request from ' || me.display_name
        else 'New request from ' || me.display_name end,
      v_title || ' · ' || v_location, p_priority);
  end loop;
  perform momexpress.notify(me.user_id, 'submitted', new_id, 'Request sent',
    case
      when runner_count = 1 then only_runner || ' has been notified about ' || momexpress.quote(v_title) || '.'
      when runner_count > 1 then 'Your runners have been notified about ' || momexpress.quote(v_title) || '.'
      else momexpress.quote(v_title) || ' is saved, but no runner account has been set up yet.' end);

  return momexpress.mutation(new_id, ev) || '{"created":true}';
end $$;

create function public.mx_edit_request(
  p_id bigint,
  p_title text default null,
  p_description text default null,
  p_location text default null,
  p_priority text default null,
  p_notes text default null,
  p_seen_details_at bigint default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  r momexpress.requests := momexpress.lock_request(p_id, me);
  v_title text := case when p_title is null then null else momexpress.collapse(p_title) end;
  v_location text := case when p_location is null then null else momexpress.collapse(p_location) end;
  v_description text := case when p_description is null then null else momexpress.tidy(p_description) end;
  v_notes text := case when p_notes is null then null else momexpress.tidy(p_notes) end;
  changed jsonb := '{}'::jsonb;
  parts text[] := '{}';
  ev jsonb;
  recipient record;
begin
  perform momexpress.check_action('edit', r, me);
  perform momexpress.check_seen_details(r, p_seen_details_at);
  perform momexpress.fail_fields(momexpress.detail_errors(v_title, v_location, p_priority, v_description, v_notes));

  if v_title is not null and v_title <> r.title then
    changed := changed || jsonb_build_object('title', jsonb_build_object('from', r.title, 'to', v_title));
    parts := parts || ('now ' || momexpress.quote(v_title));
  end if;
  if v_location is not null and v_location <> r.location then
    changed := changed || jsonb_build_object('location', jsonb_build_object('from', r.location, 'to', v_location));
    parts := parts || ('deliver to ' || v_location);
  end if;
  if p_priority is not null and p_priority <> r.priority then
    changed := changed || jsonb_build_object('priority', jsonb_build_object('from', r.priority, 'to', p_priority));
    parts := parts || ('priority ' || initcap(p_priority));
  end if;
  if v_description is not null and v_description <> r.description then
    changed := changed || jsonb_build_object('description', jsonb_build_object('from', r.description, 'to', v_description));
    parts := parts || 'description changed'::text;
  end if;
  if v_notes is not null and v_notes <> r.notes then
    changed := changed || jsonb_build_object('notes', jsonb_build_object('from', r.notes, 'to', v_notes));
    parts := parts || 'notes changed'::text;
  end if;
  if changed = '{}'::jsonb then
    return momexpress.mutation(r.id, null, true);
  end if;

  update momexpress.requests set
    title = coalesce(v_title, title),
    description = coalesce(v_description, description),
    location = coalesce(v_location, location),
    priority = coalesce(p_priority, priority),
    notes = coalesce(v_notes, notes),
    details_updated_at = clock_timestamp(),
    updated_at = clock_timestamp(),
    version = version + 1
  where id = r.id;
  ev := momexpress.add_event(r.id, me.user_id, 'edited', jsonb_build_object('changes', changed));

  for recipient in
    select user_id from momexpress.members
    where disabled_at is null and ((r.runner_id is not null and user_id = r.runner_id) or (r.runner_id is null and role = 'runner'))
  loop
    perform momexpress.notify(recipient.user_id, 'details_updated', r.id, me.display_name || ' updated a request',
      momexpress.quote(coalesce(v_title, r.title)) || ': ' || array_to_string(parts, ' · '), coalesce(p_priority, r.priority));
  end loop;
  return momexpress.mutation(r.id, ev);
end $$;

create function public.mx_accept(p_id bigint, p_eta_minutes integer default null, p_seen_details_at bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  r momexpress.requests := momexpress.lock_request(p_id, me);
  eta timestamptz;
  ev jsonb;
begin
  -- Pressing the same button twice (or a retry) is fine.
  if r.status = 'accepted' and r.runner_id = me.user_id then return momexpress.mutation(r.id, null, true); end if;
  perform momexpress.check_action('accept', r, me);
  perform momexpress.check_seen_details(r, p_seen_details_at);
  perform momexpress.check_eta(p_eta_minutes);
  eta := case when p_eta_minutes is null then null else clock_timestamp() + make_interval(mins => p_eta_minutes) end;
  update momexpress.requests set
    status = 'accepted', runner_id = me.user_id, accepted_at = clock_timestamp(),
    eta_at = eta, eta_set_at = case when eta is null then null else clock_timestamp() end,
    updated_at = clock_timestamp(), version = version + 1
  where id = r.id;
  ev := momexpress.add_event(r.id, me.user_id, 'accepted',
    case when eta is null then '{}'::jsonb else jsonb_build_object('etaAt', momexpress.ms(eta)) end);
  perform momexpress.notify(r.requester_id, 'accepted', r.id, me.display_name || ' accepted your request',
    momexpress.quote(r.title) || ' · ' || case when eta is null then 'ETA coming soon' else 'ETA about ' || p_eta_minutes || ' min' end,
    r.priority);
  return momexpress.mutation(r.id, ev);
end $$;

create function public.mx_decline(p_id bigint, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  r momexpress.requests := momexpress.lock_request(p_id, me);
  reason text;
  ev jsonb;
begin
  if r.status = 'declined' and r.runner_id = me.user_id then return momexpress.mutation(r.id, null, true); end if;
  perform momexpress.check_action('decline', r, me);
  reason := momexpress.check_reason(p_reason);
  update momexpress.requests set
    status = 'declined', runner_id = me.user_id, declined_at = clock_timestamp(), decline_reason = reason,
    updated_at = clock_timestamp(), version = version + 1
  where id = r.id;
  ev := momexpress.add_event(r.id, me.user_id, 'declined',
    case when reason is null then '{}'::jsonb else jsonb_build_object('reason', reason) end);
  perform momexpress.notify(r.requester_id, 'declined', r.id, 'Request declined',
    me.display_name || ' can’t take ' || momexpress.quote(r.title) || ' right now' || coalesce(': ' || reason, '.'), r.priority);
  return momexpress.mutation(r.id, ev);
end $$;

create function public.mx_start(p_id bigint, p_eta_minutes integer default null, p_seen_details_at bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  r momexpress.requests := momexpress.lock_request(p_id, me);
  eta timestamptz;
  ev jsonb;
  mins integer;
begin
  if r.status = 'in_progress' and r.runner_id = me.user_id then return momexpress.mutation(r.id, null, true); end if;
  perform momexpress.check_action('start', r, me);
  perform momexpress.check_seen_details(r, p_seen_details_at);
  perform momexpress.check_eta(p_eta_minutes);
  eta := case when p_eta_minutes is null then r.eta_at else clock_timestamp() + make_interval(mins => p_eta_minutes) end;
  update momexpress.requests set
    status = 'in_progress', started_at = clock_timestamp(),
    eta_at = eta, eta_set_at = case when p_eta_minutes is null then eta_set_at else clock_timestamp() end,
    updated_at = clock_timestamp(), version = version + 1
  where id = r.id;
  ev := momexpress.add_event(r.id, me.user_id, 'started',
    case when p_eta_minutes is null then '{}'::jsonb else jsonb_build_object('etaAt', momexpress.ms(eta)) end);
  mins := case when eta is not null and eta > clock_timestamp()
    then greatest(1, round(extract(epoch from (eta - clock_timestamp())) / 60))::integer end;
  perform momexpress.notify(r.requester_id, 'started', r.id, 'Your delivery is on the way',
    momexpress.quote(r.title) || ' → ' || r.location || coalesce(' · about ' || mins || ' min', ''), r.priority);
  return momexpress.mutation(r.id, ev);
end $$;

create function public.mx_set_eta(p_id bigint, p_eta_minutes integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  r momexpress.requests := momexpress.lock_request(p_id, me);
  eta timestamptz;
  ev jsonb;
begin
  perform momexpress.check_action('set_eta', r, me);
  if p_eta_minutes is null then
    perform momexpress.fail(400, 'validation_failed', 'Choose an ETA in minutes.');
  end if;
  perform momexpress.check_eta(p_eta_minutes);
  eta := clock_timestamp() + make_interval(mins => p_eta_minutes);
  update momexpress.requests set eta_at = eta, eta_set_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
  where id = r.id;
  ev := momexpress.add_event(r.id, me.user_id, 'eta_updated',
    jsonb_build_object('etaAt', momexpress.ms(eta), 'previousEtaAt', momexpress.ms(r.eta_at)));
  -- Small nudges aren't worth interrupting Mom for; her screen still updates live.
  if r.eta_at is null or abs(extract(epoch from (eta - r.eta_at))) >= 120 then
    perform momexpress.notify(r.requester_id, 'eta_updated', r.id, 'New ETA: about ' || p_eta_minutes || ' min',
      me.display_name || ' updated the estimate for ' || momexpress.quote(r.title) || '.', r.priority);
  end if;
  return momexpress.mutation(r.id, ev);
end $$;

create function public.mx_deliver(p_id bigint, p_seen_details_at bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  r momexpress.requests := momexpress.lock_request(p_id, me);
  ev jsonb;
begin
  if r.status = 'delivered' and r.runner_id = me.user_id then return momexpress.mutation(r.id, null, true); end if;
  perform momexpress.check_action('deliver', r, me);
  perform momexpress.check_seen_details(r, p_seen_details_at);
  update momexpress.requests set status = 'delivered', delivered_at = clock_timestamp(), updated_at = clock_timestamp(), version = version + 1
  where id = r.id;
  ev := momexpress.add_event(r.id, me.user_id, 'delivered');
  perform momexpress.notify(r.requester_id, 'delivered', r.id, 'Delivered!',
    momexpress.quote(r.title) || ' was delivered to ' || r.location || '. Enjoy!', r.priority);
  return momexpress.mutation(r.id, ev);
end $$;

create function public.mx_cancel(p_id bigint, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  r momexpress.requests := momexpress.lock_request(p_id, me);
  reason text;
  ev jsonb;
  recipient record;
begin
  if r.status = 'cancelled' and r.cancelled_by = me.user_id then return momexpress.mutation(r.id, null, true); end if;
  perform momexpress.check_action('cancel', r, me);
  reason := momexpress.check_reason(p_reason);
  update momexpress.requests set
    status = 'cancelled', cancelled_at = clock_timestamp(), cancelled_by = me.user_id, cancel_reason = reason,
    updated_at = clock_timestamp(), version = version + 1
  where id = r.id;
  ev := momexpress.add_event(r.id, me.user_id, 'cancelled',
    jsonb_build_object('previousStatus', r.status) || case when reason is null then '{}'::jsonb else jsonb_build_object('reason', reason) end);
  if me.role = 'mom' then
    -- Whoever might be working on it needs to know it's off.
    for recipient in
      select user_id from momexpress.members
      where disabled_at is null and ((r.runner_id is not null and user_id = r.runner_id) or (r.runner_id is null and role = 'runner'))
    loop
      perform momexpress.notify(recipient.user_id, 'cancelled', r.id, me.display_name || ' cancelled a request',
        momexpress.quote(r.title) || ' is no longer needed' || coalesce(': ' || reason, '.'), r.priority);
    end loop;
  else
    perform momexpress.notify(r.requester_id, 'cancelled', r.id, 'Delivery cancelled',
      me.display_name || ' couldn’t finish ' || momexpress.quote(r.title) || coalesce(': ' || reason, '.'), r.priority);
  end if;
  return momexpress.mutation(r.id, ev);
end $$;

create function public.mx_mark_read(p_ids bigint[] default null, p_request_id bigint default null, p_all boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  marked bigint[];
begin
  if coalesce(p_all, false) then
    update momexpress.notifications set read_at = clock_timestamp() where user_id = me.user_id and read_at is null;
    return jsonb_build_object('ids', 'all', 'unreadCount', 0);
  end if;
  with updated as (
    update momexpress.notifications set read_at = clock_timestamp()
    where user_id = me.user_id and read_at is null
      and ((p_ids is not null and id = any (p_ids)) or (p_request_id is not null and request_id = p_request_id))
    returning id)
  select coalesce(array_agg(id), '{}') into marked from updated;
  return jsonb_build_object(
    'ids', to_jsonb(marked),
    'unreadCount', (select count(*) from momexpress.notifications where user_id = me.user_id and read_at is null));
end $$;

create function public.mx_update_me(p_display_name text default null, p_prefs jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  v_name text := case when p_display_name is null then null else momexpress.collapse(p_display_name) end;
  allowed_types text[] := case when me.role = 'mom'
    then array['accepted', 'started', 'eta_updated', 'delivered', 'declined', 'cancelled', 'submitted']
    else array['new_request', 'cancelled', 'details_updated'] end;
  push_in jsonb := coalesce(p_prefs -> 'push', '{}'::jsonb);
  push_clean jsonb := '{}'::jsonb;
  k text;
  v jsonb;
  updated momexpress.members;
begin
  if v_name is not null and (v_name = '' or char_length(v_name) > 40) then
    perform momexpress.fail(400, 'validation_failed', 'Use a name of 1 to 40 characters.',
      jsonb_build_object('fields', jsonb_build_object('displayName', 'Use a name of 1 to 40 characters.')));
  end if;
  if p_prefs is not null and jsonb_typeof(p_prefs) <> 'object' then
    perform momexpress.fail(400, 'validation_failed', 'Invalid settings.');
  end if;
  if jsonb_typeof(push_in) = 'object' then
    for k, v in select * from jsonb_each(push_in) loop
      if k = any (allowed_types) and jsonb_typeof(v) = 'boolean' then
        push_clean := push_clean || jsonb_build_object(k, v);
      end if;
    end loop;
  end if;
  update momexpress.members set
    display_name = coalesce(v_name, display_name),
    prefs = prefs
      || case when jsonb_typeof(p_prefs -> 'sound') = 'boolean' then jsonb_build_object('sound', p_prefs -> 'sound') else '{}'::jsonb end
      || case when p_prefs ->> 'theme' in ('system', 'light', 'dark') then jsonb_build_object('theme', p_prefs ->> 'theme') else '{}'::jsonb end
      || case when push_clean <> '{}'::jsonb then jsonb_build_object('push', coalesce(prefs -> 'push', '{}'::jsonb) || push_clean) else '{}'::jsonb end,
    updated_at = clock_timestamp()
  where user_id = me.user_id
  returning * into updated;
  return jsonb_build_object('user', momexpress.member_json(updated));
end $$;

-- ---------------------------------------------------------------------------
-- Push notifications
-- ---------------------------------------------------------------------------

create function public.mx_push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  session uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
begin
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 1000
     or coalesce(p_p256dh, '') = '' or char_length(p_p256dh) > 200 or coalesce(p_auth, '') = '' or char_length(p_auth) > 100 then
    perform momexpress.fail(400, 'validation_failed', 'That push subscription isn’t valid.');
  end if;
  -- The endpoint is unique per browser; re-subscribing (or someone else signing
  -- in on the same device) moves it to the current person and session.
  insert into momexpress.push_subscriptions (user_id, session_id, endpoint, p256dh, auth, user_agent)
  values (me.user_id, session, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update set
    user_id = excluded.user_id, session_id = excluded.session_id, p256dh = excluded.p256dh,
    auth = excluded.auth, user_agent = excluded.user_agent, failure_count = 0;
  return '{"ok":true}'::jsonb;
end $$;

create function public.mx_push_unsubscribe(p_endpoint text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
begin
  delete from momexpress.push_subscriptions where user_id = me.user_id and endpoint = p_endpoint;
  return '{"ok":true}'::jsonb;
end $$;

create function public.mx_push_status(p_endpoint text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
begin
  return jsonb_build_object('subscribed',
    exists (select 1 from momexpress.push_subscriptions where user_id = me.user_id and endpoint = p_endpoint));
end $$;

-- Devices that should get pushes for a person: only those whose sign-in
-- session still exists (signing out, or the session ending, stops them).
create function momexpress.live_subscriptions(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb)
  from momexpress.push_subscriptions s
  where s.user_id = p_user
    and (s.session_id is null or exists (
      select 1 from auth.sessions a where a.id = s.session_id and (a.not_after is null or a.not_after > now())))
$$;

-- Called by the push function: claims a pending notification (so it is only
-- ever sent once) and returns what to send and where.
create function public.mx_push_claim(p_notification_id bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  n momexpress.notifications;
begin
  update momexpress.notifications set push_state = 'sent'
  where id = p_notification_id and push_state = 'pending'
  returning * into n;
  if not found then return null; end if;
  return jsonb_build_object(
    'payload', jsonb_build_object(
      'title', n.title,
      'body', n.body,
      'url', case when n.request_id is null then '/notifications' else '/requests/' || n.request_id end,
      'tag', case when n.request_id is null then 'notification-' || n.id else 'request-' || n.request_id end,
      'type', n.type,
      'requestId', n.request_id,
      'notificationId', n.id,
      'priority', n.priority,
      'badgeCount', (select count(*) from momexpress.notifications where user_id = n.user_id and read_at is null)),
    'subscriptions', momexpress.live_subscriptions(n.user_id));
end $$;

-- Called by the push function for "Send test": the member's live devices.
create function public.mx_push_targets(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when exists (select 1 from momexpress.members where user_id = p_user and disabled_at is null)
    then jsonb_build_object(
      'subscriptions', momexpress.live_subscriptions(p_user),
      'role', (select role from momexpress.members where user_id = p_user),
      'badgeCount', (select count(*) from momexpress.notifications where user_id = p_user and read_at is null))
    else null end
$$;

-- Called by the push function with the outcome of each delivery.
create function public.mx_push_report(p_results jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  item jsonb;
begin
  for item in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    if (item ->> 'gone')::boolean then
      -- The browser dropped this subscription; it will never work again.
      delete from momexpress.push_subscriptions where id = (item ->> 'id')::bigint;
    elsif (item ->> 'ok')::boolean then
      update momexpress.push_subscriptions set last_success_at = now(), failure_count = 0 where id = (item ->> 'id')::bigint;
    else
      update momexpress.push_subscriptions set failure_count = failure_count + 1 where id = (item ->> 'id')::bigint;
    end if;
  end loop;
end $$;

-- VAPID keys are generated by the push function on first use and kept here, so
-- they never need to be copied around by hand.
create function public.mx_push_vapid() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'publicKey', (select value from momexpress.settings where key = 'vapid_public_key'),
    'privateKey', (select value from momexpress.settings where key = 'vapid_private_key'),
    'subject', (select value from momexpress.settings where key = 'vapid_subject'))
$$;

create function public.mx_push_store_vapid(p_public text, p_private text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  -- First writer wins, so two cold starts at once agree on one key pair.
  insert into momexpress.settings (key, value) values ('vapid_public_key', p_public), ('vapid_private_key', p_private)
  on conflict (key) do nothing;
  return public.mx_push_vapid();
end $$;

-- After a notification is recorded, ask the push function to deliver it. The
-- HTTP call is queued and sent by pg_net after the transaction commits.
create function momexpress.dispatch_push() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  url text;
begin
  if new.push_state <> 'pending' then return new; end if;
  select value into url from momexpress.settings where key = 'push_function_url';
  if url is null then return new; end if;
  perform net.http_post(
    url := url,
    body := jsonb_build_object('notificationId', new.id),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    timeout_milliseconds := 10000);
  return new;
end $$;

create trigger notifications_push after insert on momexpress.notifications
  for each row execute function momexpress.dispatch_push();

-- ---------------------------------------------------------------------------
-- Accounts. There is no public sign-up: whoever runs MomExpress adds the family
-- from the Supabase SQL editor, e.g.
--   select momexpress.create_member('mom', 'a-long-password', 'Mom', 'mom');
-- People sign in with their username; the email below is internal only and
-- never receives mail.
-- ---------------------------------------------------------------------------

create function momexpress.username_email(p_username text) returns text
language sql immutable set search_path = '' as $$
  select lower(p_username) || '@momexpress.invalid'
$$;

create function momexpress.create_member(p_username text, p_password text, p_display_name text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := gen_random_uuid();
  email text := momexpress.username_email(p_username);
begin
  if char_length(coalesce(p_password, '')) < 8 then
    raise exception 'Use a password of at least 8 characters.';
  end if;
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', email,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', jsonb_build_object('momexpress_username', lower(p_username)), now(), now(),
    '', '', '', '', '', '', '', '');
  insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid::text, uid,
    jsonb_build_object('sub', uid::text, 'email', email, 'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now());
  insert into momexpress.members (user_id, username, display_name, role, prefs)
  values (uid, lower(p_username), p_display_name, p_role, momexpress.default_prefs(p_role));
  return uid;
end $$;

create function momexpress.set_password(p_username text, p_password text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if char_length(coalesce(p_password, '')) < 8 then
    raise exception 'Use a password of at least 8 characters.';
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
  where id = (select user_id from momexpress.members where username = lower(p_username));
  -- Sign them out everywhere.
  delete from auth.sessions where user_id = (select user_id from momexpress.members where username = lower(p_username));
end $$;

create function momexpress.set_disabled(p_username text, p_disabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update momexpress.members set disabled_at = case when p_disabled then now() else null end, updated_at = now()
  where username = lower(p_username);
  if p_disabled then
    delete from auth.sessions where user_id = (select user_id from momexpress.members where username = lower(p_username));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

-- Realtime checks row-level security as the signed-in person, so they need to
-- be able to read these tables in principle; the policies limit which rows.
-- (The schema isn't exposed through the REST API, so this opens no other door.)
-- Postgres lets everyone execute new functions by default (and a per-schema
-- default can't take that away), so revoke it from the internal ones here.
revoke execute on all functions in schema momexpress from public;
grant usage on schema momexpress to authenticated;
grant select on momexpress.requests, momexpress.request_events, momexpress.notifications to authenticated;
grant execute on function momexpress.can_view_request(uuid) to authenticated;

create policy momexpress_requests_read on momexpress.requests
  for select to authenticated using (momexpress.can_view_request(requester_id));
create policy momexpress_events_read on momexpress.request_events
  for select to authenticated using (exists (
    select 1 from momexpress.requests r where r.id = request_id and momexpress.can_view_request(r.requester_id)));
create policy momexpress_notifications_read on momexpress.notifications
  for select to authenticated using (user_id = (select auth.uid()));

-- The app's functions: signed-in people only, never anonymous visitors.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig, p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'mx\_%'
  loop
    execute format('revoke all on function %s from public, anon', fn.sig);
    if fn.proname in ('mx_push_claim', 'mx_push_targets', 'mx_push_report', 'mx_push_vapid', 'mx_push_store_vapid') then
      execute format('revoke all on function %s from authenticated', fn.sig);
      execute format('grant execute on function %s to service_role', fn.sig);
    else
      execute format('grant execute on function %s to authenticated', fn.sig);
    end if;
  end loop;
end $$;

-- Live updates for request history and notifications.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'momexpress' and tablename = 'request_events') then
      alter publication supabase_realtime add table momexpress.request_events;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'momexpress' and tablename = 'notifications') then
      alter publication supabase_realtime add table momexpress.notifications;
    end if;
  end if;
end $$;
