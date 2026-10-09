-- ONE-TIME ADMINISTRATOR SCRIPT — run manually in the Supabase SQL editor
-- (dashboard access required). Not a migration and not callable through the API.
--
-- 1. Invite the founder from Authentication → Users → Invite user.
-- 2. Accept the invite and set a password.
-- 3. Replace the placeholder below with that email address and run this script.

do $$
declare
  v_email text := 'REPLACE_WITH_FOUNDER_EMAIL';
  v_user uuid;
begin
  if v_email = 'REPLACE_WITH_FOUNDER_EMAIL' then
    raise exception 'Edit v_email before running this script';
  end if;
  select id into v_user from auth.users where lower(email) = lower(v_email);
  if v_user is null then
    raise exception 'No invited user with email %', v_email;
  end if;
  if exists (select 1 from public.business_members where user_id = v_user) then
    raise exception 'This user is a client member and cannot also be the founder';
  end if;
  insert into public.founders (user_id) values (v_user) on conflict do nothing;
  insert into public.audit_log (actor, actor_role, action, details)
  values (null, 'SYSTEM', 'FOUNDER_BOOTSTRAPPED', jsonb_build_object('user_id', v_user));
  raise notice 'Founder role granted to %', v_user;
end $$;
