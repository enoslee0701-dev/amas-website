-- Dedicated October-cohort attendance accounts. No general administrative role.
create schema if not exists amas_private;
revoke all on schema amas_private from public,anon,authenticated;
create table amas_private.attendance_operators (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 cohort text not null default '10月班' references public.submission_cohorts(name) on update restrict on delete restrict,
 granted_by uuid references public.profiles(id) on delete set null,
 granted_at timestamptz not null default now(), expires_at timestamptz, revoked_at timestamptz,
 check (cohort='10月班')
);
alter table amas_private.attendance_operators enable row level security;
revoke all on amas_private.attendance_operators from public,anon,authenticated;
create or replace function amas_private.attendance_active(p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from amas_private.attendance_operators a join public.profiles p on p.id=a.user_id
 where a.user_id=p_user and a.revoked_at is null and (a.expires_at is null or a.expires_at>now()) and p.account_status='active');
$$;
revoke all on function amas_private.attendance_active(uuid) from public,anon,authenticated;
create or replace function amas_private.attendance_scope()
returns text language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not amas_private.attendance_active(auth.uid()) then
  raise exception using errcode='42501',message='attendance_forbidden';end if;
 if not public.request_is_aal2() then raise exception using errcode='42501',message='mfa_required';end if;
 return '10月班';
end $$;
revoke all on function amas_private.attendance_scope() from public,anon,authenticated;

-- A separate capability, not an enum administrative role. Read from the DB each request.
create or replace function public.my_roles()
returns table(role text,scope_type text,scope_id uuid)
language sql stable security definer set search_path='' as $$
 select r.role::text,r.scope_type,r.scope_id from public.user_roles r
 where r.user_id=auth.uid() and r.revoked_at is null and (r.expires_at is null or r.expires_at>now())
 and not amas_private.attendance_active(auth.uid())
 union all select 'attendance_clerk'::text,'october_cohort'::text,null::uuid
 where amas_private.attendance_active(auth.uid());
$$;
revoke all on function public.my_roles() from public,anon;
grant execute on function public.my_roles() to authenticated;

-- Do not accidentally turn the limited account into a general staff/student account.
create or replace function amas_private.attendance_role_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.profiles where id=new.user_id for update;
 if new.revoked_at is null and (new.expires_at is null or new.expires_at>now())
 and exists(select 1 from amas_private.attendance_operators a where a.user_id=new.user_id and a.revoked_at is null) then
  if tg_op='INSERT' then
   raise exception using errcode='42501',message='attendance_account_exclusive';
  elsif new.user_id is distinct from old.user_id or new.role is distinct from old.role
   or old.revoked_at is not null or old.expires_at<=now() then
   raise exception using errcode='42501',message='attendance_account_exclusive';
  end if;
 end if;
 return new;
end $$;
revoke all on function amas_private.attendance_role_guard() from public,anon,authenticated;
create trigger attendance_account_role_guard before insert or update on public.user_roles
 for each row execute function amas_private.attendance_role_guard();

-- Super-admin setup only: exact existing account, no passwords, no account creation.
create or replace function public.admin_set_attendance_operator(p_user uuid,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.has_active_role(auth.uid(),'super_admin') or not public.request_is_aal2() then
  raise exception using errcode='42501',message='forbidden';end if;
 if p_user is null or p_user=auth.uid() or p_enabled is null then return jsonb_build_object('ok',false,'error','invalid_account');end if;
 perform 1 from public.profiles where id=p_user for update;
 if not found then return jsonb_build_object('ok',false,'error','not_found');end if;
 if p_enabled then
  if exists(select 1 from public.user_roles where user_id=p_user and role not in ('applicant','student') and revoked_at is null and (expires_at is null or expires_at>now())) then
   return jsonb_build_object('ok',false,'error','privileged_account');end if;
  if exists(select 1 from public.student_records where user_id=p_user)
    and not exists(select 1 from public.submissions where student_user_id=p_user and type='application' and cohort='10月班') then
   return jsonb_build_object('ok',false,'error','outside_cohort');end if;
  -- Keep the student's academic identity and history. my_roles exposes only the
  -- attendance workspace while assigned; stopping restores the original workspace.
  insert into amas_private.attendance_operators(user_id,granted_by) values(p_user,auth.uid())
   on conflict(user_id) do update set revoked_at=null,expires_at=null,granted_by=auth.uid(),granted_at=now();
 else
  update amas_private.attendance_operators set revoked_at=now() where user_id=p_user and revoked_at is null;
 end if;
 insert into public.audit_logs(actor_id,event_type,target_type,target_id,category,new_value)
 values(auth.uid(),'attendance.operator_changed','profiles',p_user::text,'academic',jsonb_build_object('enabled',p_enabled,'cohort','10月班'));
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.admin_set_attendance_operator(uuid,boolean) from public,anon;
grant execute on function public.admin_set_attendance_operator(uuid,boolean) to authenticated;

alter table public.cohort_sessions add column attendance_version bigint not null default 0;
alter table public.cohort_marks add column attendance_note text not null default '' check(length(attendance_note)<=500);
alter table public.cohort_marks add column attendance_recorded_by uuid references public.profiles(id) on delete set null;
create or replace function amas_private.attendance_mark_version()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.cohort_sessions set attendance_version=attendance_version+1 where id=coalesce(new.session_id,old.session_id);
 return coalesce(new,old);
end $$;
revoke all on function amas_private.attendance_mark_version() from public,anon,authenticated;
create trigger attendance_mark_version after insert or update or delete on public.cohort_marks
 for each row execute function amas_private.attendance_mark_version();

create or replace function public.attendance_day(p_day date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare scope text;result jsonb;
begin
 scope:=amas_private.attendance_scope();
 if p_day is null then raise exception 'invalid date';end if;
 select jsonb_build_object('cohort',scope,'day',p_day,
 'roster',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.name,s.id) from public.submissions s where s.cohort=scope and s.type='application'),'[]'::jsonb),
 'sessions',coalesce((select jsonb_agg(jsonb_build_object('id',cs.id,'title',cs.title,'version',cs.attendance_version,
 'marks',coalesce((select jsonb_agg(jsonb_build_object('id',m.submission_id,'status',m.attendance,'note',m.attendance_note) order by m.submission_id)
 from public.cohort_marks m join public.submissions s on s.id=m.submission_id
 where m.session_id=cs.id and s.cohort=scope and s.type='application'),'[]'::jsonb)) order by cs.created_at,cs.id)
 from public.cohort_sessions cs where cs.cohort=scope and cs.held_on=p_day),'[]'::jsonb)) into result;
 return result;
end $$;

create or replace function public.attendance_save(p_day date,p_session uuid,p_version bigint,p_title text,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare scope text;sid uuid;v bigint;n int;entry jsonb;old_marks jsonb;
begin
 scope:=amas_private.attendance_scope();
 if p_day is null or p_title is null or length(p_title)>120 or jsonb_typeof(p_entries) is distinct from 'array' then
 return jsonb_build_object('ok',false,'error','validation_failed');end if;
 n:=jsonb_array_length(p_entries);
 if n<1 or n>500 or exists(select 1 from jsonb_array_elements(p_entries) e where jsonb_typeof(e) is distinct from 'object'
 or e->>'status' is null or e->>'status' not in ('','present','late','absent','excused')
 or coalesce(length(e->>'note'),0)>500 or e->>'id' is null)
 or (select count(distinct e->>'id') from jsonb_array_elements(p_entries) e)<>n then
 return jsonb_build_object('ok',false,'error','validation_failed');end if;
 -- Lock the cohort while checking roster and scope, also serializing same-day creation.
 perform pg_advisory_xact_lock(hashtextextended('amas.attendance.'||scope||'.'||p_day::text,0));
 perform 1 from public.submissions s where s.id in(select (e->>'id')::bigint from jsonb_array_elements(p_entries) e) for share;
 if exists(select 1 from jsonb_array_elements(p_entries) e where not exists(select 1 from public.submissions s where s.id=(e->>'id')::bigint and s.cohort=scope and s.type='application')) then
 return jsonb_build_object('ok',false,'error','outside_roster');end if;
 if p_session is null then
  -- Retry after a lost response cannot create a second daily session.
  select count(*) into n from public.cohort_sessions where cohort=scope and held_on=p_day;
  if n>0 then return jsonb_build_object('ok',false,'error','reload_required');end if;
  if p_version is distinct from 0 then return jsonb_build_object('ok',false,'error','conflict');end if;
  insert into public.cohort_sessions(cohort,held_on,title,source,created_by) values(scope,p_day,p_title,'whatsapp',auth.uid()) returning id into sid;
 else
  select id,attendance_version into sid,v from public.cohort_sessions where id=p_session and cohort=scope and held_on=p_day for update;
  if sid is null then return jsonb_build_object('ok',false,'error','outside_cohort');end if;
  if v is distinct from p_version then return jsonb_build_object('ok',false,'error','conflict');end if;
  -- Existing teaching session metadata belongs to staff; clerk cannot rewrite it.
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',m.submission_id,'status',m.attendance,'note',m.attendance_note)),'[]'::jsonb)
 into old_marks from public.cohort_marks m where session_id=sid and submission_id in(select (e->>'id')::bigint from jsonb_array_elements(p_entries) e);
 for entry in select * from jsonb_array_elements(p_entries) loop
  insert into public.cohort_marks(session_id,submission_id,attendance,attendance_note,attendance_recorded_by)
  values(sid,(entry->>'id')::bigint,entry->>'status',coalesce(entry->>'note',''),auth.uid())
  on conflict(session_id,submission_id) do update set attendance=excluded.attendance,attendance_note=excluded.attendance_note,attendance_recorded_by=excluded.attendance_recorded_by;
 end loop;
 insert into public.audit_logs(actor_id,event_type,target_type,target_id,category,old_value,new_value)
 values(auth.uid(),'attendance.saved','cohort_sessions',sid::text,'academic',old_marks,p_entries);
 return jsonb_build_object('ok',true,'session',sid,'version',(select attendance_version from public.cohort_sessions where id=sid));
end $$;
revoke all on function public.attendance_day(date),public.attendance_save(date,uuid,bigint,text,jsonb) from public,anon;
grant execute on function public.attendance_day(date),public.attendance_save(date,uuid,bigint,text,jsonb) to authenticated;

create or replace function public.admin_attendance_operators()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.has_active_role(auth.uid(),'super_admin') or not public.request_is_aal2() then
 raise exception using errcode='42501',message='forbidden';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',p.id,'display_name',p.display_name,'email',p.email,'expires_at',a.expires_at) order by p.display_name,p.id)
 from amas_private.attendance_operators a join public.profiles p on p.id=a.user_id where a.revoked_at is null),'[]'::jsonb);
end $$;
revoke all on function public.admin_attendance_operators() from public,anon;
grant execute on function public.admin_attendance_operators() to authenticated;
