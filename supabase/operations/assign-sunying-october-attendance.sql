-- Apply only after the attendance backend AND frontend have been released.
-- Explicit user designation: 孙莹 is the 10月班 attendance operator.
-- Resolve the existing login alias; never create another account or impersonate an admin.
begin;
do $$
declare target uuid; matches int;
begin
 select count(*),(array_agg(p.id))[1] into matches,target
 from public.profiles p join public.login_aliases a on a.user_id=p.id
 where a.alias_normalized='SUNYING2026' and a.revoked_at is null and p.display_name='孙莹' and p.account_status='active';
 if matches<>1 then raise exception 'Expected exactly one active 孙莹 / SUNYING2026 account; nothing changed';end if;
 perform 1 from public.profiles where id=target for update;
 if not exists(select 1 from public.student_records where user_id=target and status='active')
 or not exists(select 1 from public.submissions where student_user_id=target and type='application' and cohort='10月班') then
 raise exception 'Verify formal enrollment and October cohort before assigning attendance';end if;
 if exists(select 1 from public.user_roles where user_id=target and role not in ('student','applicant') and revoked_at is null and (expires_at is null or expires_at>now())) then
 raise exception 'Unexpected privileged role; assignment refused';end if;
 if exists(select 1 from amas_private.attendance_operators where user_id=target and revoked_at is null and (expires_at is null or expires_at>now())) then
 raise notice 'October attendance assignment already active; no change';return;end if;
 insert into amas_private.attendance_operators(user_id,granted_by) values(target,null)
 on conflict(user_id) do update set revoked_at=null,expires_at=null,granted_at=now(),granted_by=null;
 insert into public.audit_logs(actor_id,actor_role,event_type,target_type,target_id,category,new_value,reason)
 values(null,'operator','attendance.operator_assigned','profiles',target::text,'academic',
 jsonb_build_object('cohort','10月班','login_alias','SUNYING2026','academic_identity','preserved'),
 'User explicitly designated 孙莹 as October-cohort attendance operator; existing account and formal enrollment preserved. Applied through reviewed operator SQL, not a signed-in administrator.');
end $$;
commit;
