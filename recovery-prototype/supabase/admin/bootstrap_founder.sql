-- ONE-TIME ADMINISTRATOR SCRIPT — run manually in the Supabase SQL Editor
-- (dashboard access required). Not a migration and not callable through the API.
-- Grants the founder role to exactly one, explicitly identified account.
--
-- 1. Invite the founder: Authentication → Users → Invite user.
-- 2. Open the invitation on the staging site, set a password, sign in.
--    The site then shows "Account not yet authorised" with your Email and User ID.
-- 3. Replace BOTH placeholders below with those two values, then run this once.
--
-- Refuses (and changes nothing) unless the email and user ID belong to the
-- same account, the email is confirmed, a password has been set, the account
-- has signed in, it is not a client member, and no other founder exists.

do $$
declare
  v_email text := 'REPLACE_WITH_FOUNDER_EMAIL';
  v_user_id text := 'REPLACE_WITH_FOUNDER_USER_ID';
  v_user record;
begin
  if v_email = 'REPLACE_WITH_FOUNDER_EMAIL' or v_user_id = 'REPLACE_WITH_FOUNDER_USER_ID' then
    raise exception 'Edit v_email and v_user_id before running this script';
  end if;
  if v_user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'v_user_id is not a valid user ID (copy it from the staging site)';
  end if;

  select u.id, u.email, u.email_confirmed_at, u.last_sign_in_at, coalesce(u.encrypted_password, '') <> '' as has_password
    into v_user
  from auth.users u
  where u.id = v_user_id::uuid and lower(u.email) = lower(btrim(v_email));
  if not found then
    raise exception 'No account has BOTH this email and this user ID. Nothing was changed.';
  end if;
  if v_user.email_confirmed_at is null then
    raise exception 'This account''s email is not confirmed yet. Open the invitation first. Nothing was changed.';
  end if;
  if not v_user.has_password then
    raise exception 'This account has not set a password yet. Finish the invitation first. Nothing was changed.';
  end if;
  if v_user.last_sign_in_at is null then
    raise exception 'This account has never signed in. Sign in on the staging site first. Nothing was changed.';
  end if;
  if exists (select 1 from public.business_members where user_id = v_user.id) then
    raise exception 'This account is a client member and cannot also be the founder. Nothing was changed.';
  end if;
  if exists (select 1 from public.founders where user_id = v_user.id) then
    raise notice 'This account is already the founder. Nothing was changed.';
    return;
  end if;
  if exists (select 1 from public.founders) then
    raise exception 'A different founder already exists. This one-time script will not add another. Nothing was changed.';
  end if;

  insert into public.founders (user_id) values (v_user.id);
  insert into public.audit_log (actor, actor_role, action, details)
  values (null, 'SYSTEM', 'FOUNDER_BOOTSTRAPPED', jsonb_build_object('user_id', v_user.id, 'method', 'admin/bootstrap_founder.sql'));
  raise notice 'Founder role granted to % (%)', v_user.email, v_user.id;
end $$;
