-- Mom's app is in Arabic, so the notifications she gets (in the app and as
-- push notifications) are written in Arabic too. Everyone else's stay as they
-- were. Only momexpress.notify changes; every action already goes through it,
-- after the request has been updated, so it can describe the new state.

-- 15 → ١٥
create or replace function momexpress.ar_digits(p integer) returns text
language sql immutable set search_path = '' as $$
  select translate(p::text, '0123456789', '٠١٢٣٤٥٦٧٨٩')
$$;

-- Arabic changes the word with the number: دقيقة، دقيقتين، ٣ دقائق، ١٥ دقيقة.
create or replace function momexpress.ar_minutes(p integer) returns text
language sql immutable set search_path = '' as $$
  select case
    when p <= 1 then 'دقيقة'
    when p = 2 then 'دقيقتين'
    when p <= 10 then momexpress.ar_digits(p) || ' دقائق'
    else momexpress.ar_digits(p) || ' دقيقة' end
$$;

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
      else p_title end;
    v_body := '«' || r.title || '»' || case
      when p_type in ('accepted', 'started', 'eta_updated') and mins is not null then ' · يصل خلال حوالي ' || momexpress.ar_minutes(mins)
      when p_type = 'declined' and r.decline_reason is not null then ' · ' || r.decline_reason
      when p_type = 'cancelled' and r.cancel_reason is not null then ' · ' || r.cancel_reason
      else '' end;
  end if;

  wants_push := coalesce((m.prefs -> 'push' ->> p_type)::boolean, (momexpress.default_prefs(m.role) -> 'push' ->> p_type)::boolean, true)
    and exists (select 1 from momexpress.push_subscriptions s where s.user_id = p_user);
  insert into momexpress.notifications (user_id, type, request_id, title, body, priority, push_state)
  values (p_user, p_type, p_request, v_title, v_body, p_priority, case when wants_push then 'pending' else 'none' end);
end $$;

-- Helpers are internal, like everything else in this schema.
revoke execute on function momexpress.ar_digits(integer), momexpress.ar_minutes(integer) from public;
