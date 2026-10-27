-- Role lifecycle: effective account status, least-privilege staff administration.
-- No accounts, credentials, academic records or role assignments are changed here.
create or replace function public.has_active_role(p_user uuid,p_role text)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.user_roles r join public.profiles p on p.id=r.user_id
 where r.user_id=p_user and r.role::text=p_role and r.revoked_at is null
 and (r.expires_at is null or r.expires_at>now()) and p.account_status='active');
$$;

create or replace function public.my_roles()
returns table(role text,scope_type text,scope_id uuid)
language sql stable security definer set search_path='' as $$
 select r.role::text,r.scope_type,r.scope_id from public.user_roles r join public.profiles p on p.id=r.user_id
 where r.user_id=auth.uid() and p.account_status='active' and r.revoked_at is null
 and (r.expires_at is null or r.expires_at>now()) and not amas_private.attendance_active(auth.uid())
 union all select 'attendance_clerk'::text,'october_cohort'::text,null::uuid
 where amas_private.attendance_active(auth.uid());
$$;

-- A reusable private core, also protecting the legacy service-only SIS RPC.
create or replace function amas_private.set_staff_role(
 p_actor uuid,p_user uuid,p_role text,p_grant boolean,p_reason text,p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_old jsonb; v_new jsonb; v_id uuid;
begin
 -- Lock both accounts in a consistent order, then recheck the actor inside the lock.
 perform 1 from public.profiles where id in(p_actor,p_user) order by id for update;
 if not public.has_active_role(p_actor,'super_admin') then raise exception using errcode='42501',message='forbidden';end if;
 if p_user=p_actor then return jsonb_build_object('ok',false,'error','cannot_change_self');end if;
 if p_role is null or p_role not in('registrar','academic_admin','mentor','finance','content_admin') or p_grant is null then
  return jsonb_build_object('ok',false,'error','role_not_manageable');end if;
 if coalesce(length(btrim(p_reason)),0) not between 1 and 1000 then return jsonb_build_object('ok',false,'error','reason_required');end if;
 if not exists(select 1 from public.profiles where id=p_user) then return jsonb_build_object('ok',false,'error','not_found');end if;
 if p_grant and not exists(select 1 from public.profiles where id=p_user and account_status='active') then
  return jsonb_build_object('ok',false,'error','inactive_account');end if;
 if p_grant and amas_private.attendance_active(p_user) then return jsonb_build_object('ok',false,'error','attendance_account');end if;
 if p_grant and p_expires_at is not null and (not isfinite(p_expires_at) or p_expires_at<=now()) then
  return jsonb_build_object('ok',false,'error','invalid_expiry');end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'expires_at',expires_at,'scope_type',scope_type,'scope_id',scope_id)),'[]'::jsonb)
 into v_old from public.user_roles where user_id=p_user and role::text=p_role and revoked_at is null;
 if p_grant then
  -- Expired but unrevoked rows still occupy the existing unique index. Retire them first.
  update public.user_roles set revoked_at=now() where user_id=p_user and role::text=p_role and revoked_at is null
   and expires_at is not null and expires_at<=now();
  select id into v_id from public.user_roles where user_id=p_user and role::text=p_role and revoked_at is null
   and scope_type is null and scope_id is null;
  if v_id is not null then
   if exists(select 1 from public.user_roles where id=v_id and expires_at is not distinct from p_expires_at) then
    return jsonb_build_object('ok',true,'unchanged',true);end if;
   update public.user_roles set expires_at=p_expires_at where id=v_id;
  else
   insert into public.user_roles(user_id,role,granted_by,expires_at) values(p_user,p_role::public.user_role,p_actor,p_expires_at);
  end if;
 else
  update public.user_roles set revoked_at=now() where user_id=p_user and role::text=p_role and revoked_at is null;
  if not found then return jsonb_build_object('ok',true,'unchanged',true);end if;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'expires_at',expires_at,'scope_type',scope_type,'scope_id',scope_id)),'[]'::jsonb)
 into v_new from public.user_roles where user_id=p_user and role::text=p_role and revoked_at is null;
 insert into public.audit_logs(actor_id,actor_role,event_type,target_type,target_id,category,old_value,new_value,reason)
 values(p_actor,'super_admin',case when p_grant then 'role_granted' else 'role_revoked' end,
 'user_roles',p_user::text,'security',jsonb_build_object('role',p_role,'grants',v_old),jsonb_build_object('role',p_role,'grants',v_new),btrim(p_reason));
 return jsonb_build_object('ok',true);
end $$;
revoke all on function amas_private.set_staff_role(uuid,uuid,text,boolean,text,timestamptz) from public,anon,authenticated;

create or replace function public.admin_set_staff_role(
 p_user uuid,p_role text,p_grant boolean,p_reason text,p_expires_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.has_active_role(auth.uid(),'super_admin') or not public.request_is_aal2() then
  raise exception using errcode='42501',message='forbidden';end if;
 return amas_private.set_staff_role(auth.uid(),p_user,p_role,p_grant,p_reason,p_expires_at);
end $$;
revoke all on function public.admin_set_staff_role(uuid,text,boolean,text,timestamptz) from public,anon;
grant execute on function public.admin_set_staff_role(uuid,text,boolean,text,timestamptz) to authenticated;

create or replace function public.sis_set_staff_role(p_actor uuid,p_user uuid,p_role text,p_grant boolean,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.has_active_role(p_actor,'super_admin') then raise exception 'actor lacks admin role';end if;
 if p_user=p_actor then return jsonb_build_object('ok',false,'error','cannot_change_self');end if;
 if p_grant and public.has_active_role(p_user,p_role) then return jsonb_build_object('ok',false,'error','already_assigned');end if;
 if not p_grant and not exists(select 1 from public.user_roles where user_id=p_user and role::text=p_role and revoked_at is null) then
  return jsonb_build_object('ok',false,'error','not_assigned');end if;
 return amas_private.set_staff_role(p_actor,p_user,p_role,p_grant,p_reason,null);
end $$;
revoke all on function public.sis_set_staff_role(uuid,uuid,text,boolean,text) from public,anon,authenticated;
grant execute on function public.sis_set_staff_role(uuid,uuid,text,boolean,text) to service_role;

-- Exact identity lookup and bounded staff roster; only the effective super-admin can read.
-- The response contains operational status/expiry, no password or raw applications.
create or replace function public.admin_staff_accounts(p_identifier text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_q text:=nullif(btrim(p_identifier),'');
begin
 if auth.uid() is null or not public.has_active_role(auth.uid(),'super_admin') or not public.request_is_aal2() then
  raise exception using errcode='42501',message='forbidden';end if;
 if length(v_q)>254 then return jsonb_build_object('rows','[]'::jsonb,'truncated',false);end if;
 return (with candidates as (
  select p.id,p.display_name,p.email,p.account_status from public.profiles p
  where case when v_q is not null then lower(p.email)=lower(v_q) or p.display_name=v_q or exists(
   select 1 from public.login_aliases a where a.user_id=p.id and a.revoked_at is null and lower(a.alias_normalized)=lower(v_q))
  else exists(select 1 from public.user_roles r where r.user_id=p.id and r.revoked_at is null and
   r.role::text in('super_admin','academic_admin','registrar','finance','content_admin','teacher','mentor')) end
  order by p.display_name,p.id limit 101
 ), limited as(select * from candidates order by display_name,id limit 100)
 select jsonb_build_object('truncated',(select count(*)>100 from candidates),'rows',coalesce(jsonb_agg(
  jsonb_build_object('user_id',p.id,'display_name',p.display_name,'email',p.email,'account_status',p.account_status,
   'roles',coalesce((select jsonb_agg(r.role::text order by r.role::text) from public.user_roles r where r.user_id=p.id and r.revoked_at is null and (r.expires_at is null or r.expires_at>now())),'[]'::jsonb),
   'grants',coalesce((select jsonb_agg(jsonb_build_object('role',r.role::text,'expires_at',r.expires_at) order by r.role::text) from public.user_roles r where r.user_id=p.id and r.revoked_at is null),'[]'::jsonb),
   'attendance_only',amas_private.attendance_active(p.id)) order by p.display_name,p.id),'[]'::jsonb)) from limited p);
end $$;
revoke all on function public.admin_staff_accounts(text) from public,anon;
grant execute on function public.admin_staff_accounts(text) to authenticated;

-- Older directory endpoints must also honour the account state, expiry and MFA switch.
create or replace function public.admin_find_user(p_email text)
returns table(user_id uuid,display_name text,email text,roles text[])
language sql stable security definer set search_path='' as $$
 select p.id,p.display_name,p.email,array(select r.role::text from public.user_roles r where r.user_id=p.id
 and r.revoked_at is null and (r.expires_at is null or r.expires_at>now()) order by 1)
 from public.profiles p where lower(p.email)=lower(btrim(p_email))
 and public.has_active_role(auth.uid(),'super_admin') and public.request_is_aal2();
$$;
create or replace function public.admin_list_staff()
returns table(user_id uuid,display_name text,email text,roles text[])
language sql stable security definer set search_path='' as $$
 select p.id,p.display_name,p.email,array(select r.role::text from public.user_roles r where r.user_id=p.id
 and r.revoked_at is null and (r.expires_at is null or r.expires_at>now()) order by 1)
 from public.profiles p where public.has_active_role(auth.uid(),'super_admin') and public.request_is_aal2()
 and exists(select 1 from public.user_roles r where r.user_id=p.id and r.revoked_at is null
 and (r.expires_at is null or r.expires_at>now()) and r.role::text in('super_admin','academic_admin','registrar','finance','content_admin','teacher','mentor'))
 order by p.display_name,p.id limit 100;
$$;

create or replace function public.admin_set_account_access(p_user uuid,p_enabled boolean,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_status public.account_status; v_to public.account_status;
begin
 if auth.uid() is null or not public.request_is_aal2() then raise exception using errcode='42501',message='forbidden';end if;
 perform 1 from public.profiles where id in(auth.uid(),p_user) order by id for update;
 if not public.has_active_role(auth.uid(),'super_admin') then raise exception using errcode='42501',message='forbidden';end if;
 if p_user=auth.uid() then return jsonb_build_object('ok',false,'error','cannot_change_self');end if;
 -- Root-account recovery is outside the normal operational staff screen.
 if exists(select 1 from public.user_roles where user_id=p_user and role='super_admin' and revoked_at is null) then
  return jsonb_build_object('ok',false,'error','protected_account');end if;
 if p_enabled is null or coalesce(length(btrim(p_reason)),0) not between 1 and 1000 then
  return jsonb_build_object('ok',false,'error','reason_required');end if;
 select account_status into v_status from public.profiles where id=p_user;
 if not found then return jsonb_build_object('ok',false,'error','not_found');end if;
 if p_enabled and not exists(select 1 from auth.users where id=p_user and email_confirmed_at is not null) then
  return jsonb_build_object('ok',false,'error','email_not_verified');end if;
 v_to:=case when p_enabled then 'active'::public.account_status else 'disabled'::public.account_status end;
 if v_status=v_to then return jsonb_build_object('ok',true,'unchanged',true);end if;
 update public.profiles set account_status=v_to where id=p_user;
 insert into public.audit_logs(actor_id,actor_role,event_type,target_type,target_id,category,old_value,new_value,reason)
 values(auth.uid(),'super_admin','account_access_changed','profiles',p_user::text,'security',
 jsonb_build_object('account_status',v_status),jsonb_build_object('account_status',v_to),btrim(p_reason));
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.admin_set_account_access(uuid,boolean,text) from public,anon;
grant execute on function public.admin_set_account_access(uuid,boolean,text) to authenticated;

-- Direct profile updates must not let even an administrator bypass self-protection.
create or replace function public.protect_profile_fields()
returns trigger language plpgsql set search_path='' as $$
begin
 if auth.uid()=new.id then new.account_status:=old.account_status;new.email:=old.email;end if;
 return new;
end $$;
