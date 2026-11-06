-- New in this version:
--   * Reminders: a request nobody has accepted is pushed to the runner again
--     (after 3 minutes, then every 10, up to 3 times; urgent ones every 2
--     minutes for half an hour). Runs every minute with pg_cron.
--   * Voice requests: Mom can record what she needs instead of typing. Clips
--     live in a private storage bucket that only she and the runner can read.
--   * Thanks: once something arrives, Mom can send a "thank you".
--   * Short messages on a request, both ways (e.g. "دقيقة وأجي", "نعم").
--   * Every ETA change is now sent to Mom, not only changes of 2+ minutes.
--   * mx_ping: a harmless call a scheduled job makes so the project stays awake.

create extension if not exists pg_cron with schema pg_catalog;

alter table momexpress.requests
  add column if not exists voice_path text,
  add column if not exists voice_seconds integer,
  add column if not exists reminded_at timestamptz,
  add column if not exists reminder_count integer not null default 0;

-- ---------------------------------------------------------------------------
-- The request as the app sees it, now with the voice clip, thanks and the
-- latest message.
-- ---------------------------------------------------------------------------

create or replace function momexpress.request_json(p_id bigint) returns jsonb
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
    'voice', case when r.voice_path is null then null
      else jsonb_build_object('path', r.voice_path, 'seconds', r.voice_seconds) end,
    'thankedAt', (select momexpress.ms(min(e.created_at)) from momexpress.request_events e
                  where e.request_id = r.id and e.type = 'thanked'),
    'lastMessage', (select jsonb_build_object('text', e.data ->> 'text', 'from', e.actor_id, 'at', momexpress.ms(e.created_at))
                    from momexpress.request_events e
                    where e.request_id = r.id and e.type = 'message'
                    order by e.id desc limit 1),
    'version', r.version)
  from momexpress.requests r
  join momexpress.members rq on rq.user_id = r.requester_id
  left join momexpress.members rn on rn.user_id = r.runner_id
  left join momexpress.members cb on cb.user_id = r.cancelled_by
  where r.id = p_id
$$;

-- ---------------------------------------------------------------------------
-- Notifications: Mom's are in Arabic (see 20261027130000_arabic_for_mom.sql);
-- messages now show who wrote them and what they said.
-- ---------------------------------------------------------------------------

create or replace function momexpress.notify(p_user uuid, p_type text, p_request bigint, p_title text, p_body text, p_priority text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m momexpress.members;
  r momexpress.requests;
  who text;
  mins integer;
  v_title text := p_title;
  v_body text := p_body;
  wants_push boolean;
begin
  select * into m from momexpress.members where user_id = p_user;

  if m.role = 'mom' and p_request is not null then
    select * into r from momexpress.requests where id = p_request;
    select display_name into who from momexpress.members where user_id = coalesce(r.runner_id, r.cancelled_by);
    who := coalesce(who, 'ابنك');
    mins := case when r.eta_at > clock_timestamp()
      then greatest(1, ceil(extract(epoch from (r.eta_at - clock_timestamp())) / 60))::integer end;
    v_title := case p_type
      when 'submitted' then 'تم إرسال طلبك'
      when 'accepted' then who || ' وافق على طلبك'
      when 'started' then 'طلبك في الطريق إليك'
      when 'eta_updated' then 'تغيّر وقت الوصول'
      when 'delivered' then 'وصل طلبك ✓'
      when 'declined' then who || ' لا يستطيع إحضاره الآن'
      when 'cancelled' then who || ' ألغى الطلب'
      -- For messages the caller passes the sender's name as the title.
      when 'message' then 'رسالة من ' || p_title
      else p_title end;
    v_body := case when p_type = 'message' then p_body else '«' || r.title || '»' || case
      when p_type in ('accepted', 'started', 'eta_updated') and mins is not null then ' · يصل خلال حوالي ' || momexpress.ar_minutes(mins)
      when p_type = 'declined' and r.decline_reason is not null then ' · ' || r.decline_reason
      when p_type = 'cancelled' and r.cancel_reason is not null then ' · ' || r.cancel_reason
      else '' end end;
  end if;

  wants_push := coalesce((m.prefs -> 'push' ->> p_type)::boolean, (momexpress.default_prefs(m.role) -> 'push' ->> p_type)::boolean, true)
    and exists (select 1 from momexpress.push_subscriptions s where s.user_id = p_user);
  insert into momexpress.notifications (user_id, type, request_id, title, body, priority, push_state)
  values (p_user, p_type, p_request, v_title, v_body, p_priority, case when wants_push then 'pending' else 'none' end);
end $$;

-- ---------------------------------------------------------------------------
-- Voice requests
-- ---------------------------------------------------------------------------

-- Clips are stored as <mom's user id>/<random id>.<ext>. The person who
-- recorded a clip and the runners can read it; nobody else can.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mx-voice', 'mx-voice', false, 5242880, array['audio/mp4', 'audio/aac', 'audio/x-m4a', 'audio/mpeg', 'audio/webm', 'audio/ogg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists momexpress_voice_upload on storage.objects;
create policy momexpress_voice_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'mx-voice'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and momexpress.can_view_request((select auth.uid())));

drop policy if exists momexpress_voice_read on storage.objects;
-- (A case, so the folder name is only read as an id once it's known to be one;
-- other buckets' files are never affected.)
create policy momexpress_voice_read on storage.objects for select to authenticated
  using (case
    when bucket_id = 'mx-voice' and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
      then momexpress.can_view_request(((storage.foldername(name))[1])::uuid)
    else false end);

-- The request function gains the optional voice clip, so its old form goes.
drop function if exists public.mx_create_request(text, text, text, text, text, text, text);

create function public.mx_create_request(
  p_client_request_id text,
  p_title text,
  p_location text,
  p_priority text,
  p_description text default '',
  p_notes text default '',
  p_quick_type text default null,
  p_voice_path text default null,
  p_voice_seconds integer default null
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
  if p_voice_path is not null then
    -- Only a clip she uploaded herself, and one that really is there.
    if p_voice_path !~ ('^' || me.user_id::text || '/[A-Za-z0-9_-]{8,64}\.(m4a|mp4|aac|mp3|webm|ogg)$')
       or not exists (select 1 from storage.objects o where o.bucket_id = 'mx-voice' and o.name = p_voice_path) then
      perform momexpress.fail(400, 'voice_missing', 'The voice message didn’t upload. Please record it again.');
    end if;
    if p_voice_seconds is null or p_voice_seconds < 1 or p_voice_seconds > 120 then
      perform momexpress.fail(400, 'validation_failed', 'Voice messages can be up to 2 minutes.');
    end if;
  end if;

  -- The same submission arriving twice (a double tap, or a retry after a
  -- dropped connection) returns the request that was already created.
  insert into momexpress.requests (requester_id, client_request_id, title, description, location, priority, notes, quick_type, status, voice_path, voice_seconds)
  values (me.user_id, p_client_request_id, v_title, v_description, v_location, p_priority, v_notes, p_quick_type, 'pending',
          p_voice_path, case when p_voice_path is null then null else p_voice_seconds end)
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
      case when p_voice_path is null then v_title else '🎤 Voice message' end || ' · ' || v_location, p_priority);
  end loop;
  perform momexpress.notify(me.user_id, 'submitted', new_id, 'Request sent',
    case
      when runner_count = 1 then only_runner || ' has been notified about ' || momexpress.quote(v_title) || '.'
      when runner_count > 1 then 'Your runners have been notified about ' || momexpress.quote(v_title) || '.'
      else momexpress.quote(v_title) || ' is saved, but no runner account has been set up yet.' end);

  return momexpress.mutation(new_id, ev) || '{"created":true}';
end $$;

-- ---------------------------------------------------------------------------
-- Every ETA change reaches Mom
-- ---------------------------------------------------------------------------

create or replace function public.mx_set_eta(p_id bigint, p_eta_minutes integer)
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
  perform momexpress.notify(r.requester_id, 'eta_updated', r.id, 'New ETA: about ' || p_eta_minutes || ' min',
    me.display_name || ' updated the estimate for ' || momexpress.quote(r.title) || '.', r.priority);
  return momexpress.mutation(r.id, ev);
end $$;

-- ---------------------------------------------------------------------------
-- Thanks
-- ---------------------------------------------------------------------------

create or replace function public.mx_thank(p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  r momexpress.requests := momexpress.lock_request(p_id, me);
  ev jsonb;
begin
  if me.role <> 'mom' or r.requester_id <> me.user_id then
    perform momexpress.fail(403, 'forbidden', 'Only the person who asked can say thanks.');
  end if;
  if r.status <> 'delivered' then
    perform momexpress.fail(409, 'invalid_state', 'Thanks can be sent once it has arrived.',
      jsonb_build_object('request', momexpress.request_json(r.id)));
  end if;
  if exists (select 1 from momexpress.request_events where request_id = r.id and type = 'thanked') then
    return momexpress.mutation(r.id, null, true);
  end if;
  -- History is append-only, so thanks is recorded as an event; the delivered
  -- request itself never changes.
  ev := momexpress.add_event(r.id, me.user_id, 'thanked');
  if r.runner_id is not null then
    perform momexpress.notify(r.runner_id, 'thanks', r.id, me.display_name || ' says thanks ❤️', momexpress.quote(r.title), r.priority);
  end if;
  return momexpress.mutation(r.id, ev);
end $$;

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

create or replace function public.mx_send_message(p_id bigint, p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me momexpress.members := momexpress.require_member();
  r momexpress.requests := momexpress.lock_request(p_id, me);
  v_text text := momexpress.collapse(p_text);
  ev jsonb;
  recipient record;
begin
  if v_text = '' or char_length(v_text) > 120 then
    perform momexpress.fail(400, 'validation_failed', 'Keep the message between 1 and 120 characters.',
      jsonb_build_object('fields', jsonb_build_object('text', 'Keep the message between 1 and 120 characters.')));
  end if;
  if r.status not in ('pending', 'accepted', 'in_progress') then
    perform momexpress.fail(409, 'invalid_state', 'This request is already finished.',
      jsonb_build_object('request', momexpress.request_json(r.id)));
  end if;
  if me.role = 'runner' and r.runner_id is not null and r.runner_id <> me.user_id then
    perform momexpress.fail(403, 'forbidden', 'Another runner is handling this request.');
  end if;
  ev := momexpress.add_event(r.id, me.user_id, 'message', jsonb_build_object('text', v_text));
  if me.role = 'mom' then
    for recipient in
      select user_id from momexpress.members
      where disabled_at is null and ((r.runner_id is not null and user_id = r.runner_id) or (r.runner_id is null and role = 'runner'))
    loop
      perform momexpress.notify(recipient.user_id, 'message', r.id, me.display_name || ': ' || v_text, momexpress.quote(r.title), r.priority);
    end loop;
  else
    perform momexpress.notify(r.requester_id, 'message', r.id, me.display_name, v_text, r.priority);
  end if;
  return momexpress.mutation(r.id, ev);
end $$;

-- ---------------------------------------------------------------------------
-- Reminders for requests nobody has accepted yet
-- ---------------------------------------------------------------------------

create or replace function momexpress.send_reminders() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  runner record;
  waited integer;
  reminded integer := 0;
begin
  for r in
    select q.id, q.title, q.location, q.priority, q.created_at, m.display_name as mom_name
    from momexpress.requests q
    join momexpress.members m on m.user_id = q.requester_id
    where q.status = 'pending'
      and q.reminder_count < case when q.priority = 'urgent' then 15 else 3 end
      and clock_timestamp() - coalesce(q.reminded_at, q.created_at) >= case
        when q.priority = 'urgent' then interval '2 minutes'
        when q.reminder_count = 0 then interval '3 minutes'
        else interval '10 minutes' end
    for update of q skip locked
  loop
    update momexpress.requests set reminded_at = clock_timestamp(), reminder_count = reminder_count + 1 where id = r.id;
    waited := floor(extract(epoch from (clock_timestamp() - r.created_at)) / 60)::integer;
    for runner in select user_id from momexpress.members where role = 'runner' and disabled_at is null loop
      perform momexpress.notify(runner.user_id, 'reminder', r.id,
        case when r.priority = 'urgent' then 'Still waiting (urgent): ' else 'Still waiting: ' end || r.title,
        r.mom_name || ' asked ' || waited || ' min ago · ' || r.location, r.priority);
    end loop;
    reminded := reminded + 1;
  end loop;
  return reminded;
end $$;

select cron.schedule('momexpress-reminders', '* * * * *', 'select momexpress.send_reminders()');

-- ---------------------------------------------------------------------------
-- Keep-awake ping (reveals nothing; see .github/workflows/keep-awake.yml)
-- ---------------------------------------------------------------------------

create or replace function public.mx_ping() returns text
language sql stable set search_path = '' as $$
  select 'ok'::text
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

revoke execute on function momexpress.send_reminders() from public;
revoke all on function public.mx_create_request(text, text, text, text, text, text, text, text, integer) from public, anon;
grant execute on function public.mx_create_request(text, text, text, text, text, text, text, text, integer) to authenticated;
revoke all on function public.mx_thank(bigint) from public, anon;
grant execute on function public.mx_thank(bigint) to authenticated;
revoke all on function public.mx_send_message(bigint, text) from public, anon;
grant execute on function public.mx_send_message(bigint, text) to authenticated;
revoke all on function public.mx_ping() from public;
grant execute on function public.mx_ping() to anon, authenticated;
