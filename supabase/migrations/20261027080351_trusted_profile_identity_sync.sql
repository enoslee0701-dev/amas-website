-- Freeze identity fields for direct Data API writes, including an administrator
-- editing their own profile. Preserve the existing Auth-owned SECURITY DEFINER
-- trigger chains (verified email / email changes) and whitelisted profile RPCs.
-- This trigger deliberately remains SECURITY INVOKER: current_user identifies
-- the SQL execution role; auth.uid() remains the original signed-in person.
create or replace function public.protect_profile_fields()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if auth.uid()=new.id and current_user in('anon','authenticated') then
  new.account_status:=old.account_status;
  new.email:=old.email;
 end if;
 return new;
end $$;
