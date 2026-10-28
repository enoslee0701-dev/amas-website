-- Monthly attendance review, frozen session rosters and scoped immutable change history.
alter table public.cohort_sessions add column attendance_roster_frozen boolean not null default false;
alter table public.cohort_sessions alter column attendance_roster_frozen set default true;
create table amas_private.attendance_rosters (
 session_id uuid not null references public.cohort_sessions(id) on delete cascade,
 submission_id bigint not null, name text not null, captured_at timestamptz not null default now(),
 primary key(session_id,submission_id)
);
alter table amas_private.attendance_rosters enable row level security;
revoke all on amas_private.attendance_rosters from public,anon,authenticated;
-- Legacy membership cannot be reconstructed with certainty. Flag it explicitly.
insert into amas_private.attendance_rosters(session_id,submission_id,name)
 select cs.id,s.id,coalesce(s.name,'') from public.cohort_sessions cs join public.submissions s
 on (s.cohort=cs.cohort and s.type='application') or exists(select 1 from public.cohort_marks m where m.session_id=cs.id and m.submission_id=s.id);
create table amas_private.attendance_changes (
 id bigint generated always as identity primary key, created_at timestamptz not null default now(),
 actor_id uuid, actor_name text not null, cohort text not null, held_on date not null,
 session_id uuid not null, title text not null, submission_id bigint, name text not null default '',
 operation text not null, old_status text, new_status text, old_note text, new_note text
);
create index attendance_changes_month on amas_private.attendance_changes(cohort,held_on,id desc);
alter table amas_private.attendance_changes enable row level security;
revoke all on amas_private.attendance_changes from public,anon,authenticated;
revoke all on sequence amas_private.attendance_changes_id_seq from public,anon,authenticated;
create function amas_private.attendance_capture_session() returns trigger
 language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then
  insert into amas_private.attendance_rosters(session_id,submission_id,name)
   select new.id,s.id,coalesce(s.name,'') from public.submissions s where s.cohort=new.cohort and s.type='application';
 elsif tg_op='DELETE' or (old.cohort,old.held_on,old.title) is distinct from (new.cohort,new.held_on,new.title) then
  insert into amas_private.attendance_changes(actor_id,actor_name,cohort,held_on,session_id,title,operation)
   values(auth.uid(),coalesce((select display_name from public.profiles where id=auth.uid()),'系统维护'),old.cohort,old.held_on,old.id,old.title,
    case when tg_op='DELETE' then 'session_deleted' else 'session_changed' end);
 end if;
 return coalesce(new,old);
end $$;
revoke all on function amas_private.attendance_capture_session() from public,anon,authenticated;
create trigger attendance_snapshot after insert on public.cohort_sessions for each row execute function amas_private.attendance_capture_session();
create trigger attendance_session_history before update or delete on public.cohort_sessions for each row execute function amas_private.attendance_capture_session();
create function amas_private.attendance_capture_mark() returns trigger
 language plpgsql security definer set search_path='' as $$
declare cs public.cohort_sessions; student_name text; sid uuid:=coalesce(new.session_id,old.session_id); pid bigint:=coalesce(new.submission_id,old.submission_id);
begin
 select * into cs from public.cohort_sessions where id=sid;
 if not found then return coalesce(new,old);end if;
 select name into student_name from amas_private.attendance_rosters where session_id=sid and submission_id=pid;
 if student_name is null then
  select coalesce(name,'') into student_name from public.submissions where id=pid;
  insert into amas_private.attendance_rosters(session_id,submission_id,name) values(sid,pid,coalesce(student_name,'已移除学员')) on conflict do nothing;
 end if;
 if tg_op='UPDATE' and (old.attendance,old.attendance_note) is not distinct from (new.attendance,new.attendance_note) then return new;end if;
 insert into amas_private.attendance_changes(actor_id,actor_name,cohort,held_on,session_id,title,submission_id,name,operation,old_status,new_status,old_note,new_note)
 values(auth.uid(),coalesce((select display_name from public.profiles where id=auth.uid()),'系统维护'),cs.cohort,cs.held_on,sid,cs.title,pid,coalesce(student_name,'已移除学员'),lower(tg_op),old.attendance,new.attendance,old.attendance_note,new.attendance_note);
 return coalesce(new,old);
end $$;
revoke all on function amas_private.attendance_capture_mark() from public,anon,authenticated;
create trigger attendance_changes after insert or update or delete on public.cohort_marks for each row execute function amas_private.attendance_capture_mark();
create function amas_private.attendance_review_guard() returns void
 language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.is_admin_any(auth.uid()) or not public.request_is_aal2() then
  raise exception using errcode='42501',message='attendance_review_forbidden';end if;
end $$;
revoke all on function amas_private.attendance_review_guard() from public,anon,authenticated;
create function public.admin_attendance_month(p_cohort text,p_month date) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare first_day date:=date_trunc('month',p_month)::date; last_day date:=(date_trunc('month',p_month)+interval '1 month')::date; result jsonb;
begin
 perform amas_private.attendance_review_guard();
 if p_month is null or p_cohort is null or not exists(select 1 from public.submission_cohorts where name=p_cohort) then raise exception 'invalid_month_or_cohort';end if;
 with lessons as (select * from public.cohort_sessions where cohort=p_cohort and held_on>=first_day and held_on<last_day),
 rows as (select l.id session_id,r.submission_id,r.name,coalesce(m.attendance,'') status from lessons l join amas_private.attendance_rosters r on r.session_id=l.id left join public.cohort_marks m on m.session_id=r.session_id and m.submission_id=r.submission_id),
 totals as (select submission_id,(array_agg(name order by session_id))[1] name,count(*) expected,count(*) filter(where status='present') present,count(*) filter(where status='late') late,count(*) filter(where status='excused') excused,count(*) filter(where status='absent') absent,count(*) filter(where status='') unmarked from rows group by submission_id)
 select jsonb_build_object('cohort',p_cohort,'month',first_day,'sessions',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'day',l.held_on,'title',l.title,'roster_frozen',l.attendance_roster_frozen,'expected',(select count(*) from rows r where r.session_id=l.id),'unmarked',(select count(*) from rows r where r.session_id=l.id and r.status='')) order by l.held_on,l.created_at,l.id) from lessons l),'[]'::jsonb),'students',coalesce((select jsonb_agg(to_jsonb(t) order by name,submission_id) from totals t),'[]'::jsonb)) into result;
 return result;
end $$;
create function public.admin_attendance_history(p_cohort text,p_month date,p_before bigint default null) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform amas_private.attendance_review_guard();
 if p_month is null or p_cohort is null then raise exception 'invalid_month_or_cohort';end if;
 with changes as (select * from amas_private.attendance_changes where cohort=p_cohort and held_on>=date_trunc('month',p_month)::date and held_on<(date_trunc('month',p_month)+interval '1 month')::date and (p_before is null or id<p_before) order by id desc limit 51),
 page as (select * from changes order by id desc limit 50)
 select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(p) - 'actor_id' order by id desc) from page p),'[]'::jsonb),'next_before',case when (select count(*) from changes)>50 then (select min(id) from page) else null end,'legacy_saves',(select count(*) from public.audit_logs a join public.cohort_sessions cs on cs.id::text=a.target_id where a.event_type='attendance.saved' and cs.cohort=p_cohort and cs.held_on>=date_trunc('month',p_month)::date and cs.held_on<(date_trunc('month',p_month)+interval '1 month')::date and a.created_at<(select coalesce(min(captured_at),now()) from amas_private.attendance_rosters))) into result;
 return result;
end $$;
revoke all on function public.admin_attendance_month(text,date),public.admin_attendance_history(text,date,bigint) from public,anon;
grant execute on function public.admin_attendance_month(text,date),public.admin_attendance_history(text,date,bigint) to authenticated;

create or replace function public.attendance_day(p_day date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare scope text;result jsonb;
begin
 scope:=amas_private.attendance_scope();
 if p_day is null then raise exception 'invalid date';end if;
 select jsonb_build_object('cohort',scope,'day',p_day,
 'roster',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.name,s.id) from public.submissions s where s.cohort=scope and s.type='application'),'[]'::jsonb),
 'sessions',coalesce((select jsonb_agg(jsonb_build_object('id',cs.id,'title',cs.title,'version',cs.attendance_version,
 'roster',coalesce((select jsonb_agg(jsonb_build_object('id',r.submission_id,'name',r.name) order by r.name,r.submission_id) from amas_private.attendance_rosters r where r.session_id=cs.id),'[]'::jsonb),'roster_frozen',cs.attendance_roster_frozen,
 'marks',coalesce((select jsonb_agg(jsonb_build_object('id',m.submission_id,'status',m.attendance,'note',m.attendance_note) order by m.submission_id)
 from public.cohort_marks m where m.session_id=cs.id),'[]'::jsonb)) order by cs.created_at,cs.id)
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
 if p_session is not null and not exists(select 1 from public.cohort_sessions where id=p_session and cohort=scope and held_on=p_day) then return jsonb_build_object('ok',false,'error','outside_cohort');end if;
 -- Lock the cohort while checking roster and scope, also serializing same-day creation.
 perform pg_advisory_xact_lock(hashtextextended('amas.attendance.'||scope||'.'||p_day::text,0));
 perform 1 from public.submissions s where s.id in(select (e->>'id')::bigint from jsonb_array_elements(p_entries) e) for share;
 if exists(select 1 from jsonb_array_elements(p_entries) e where not exists(select 1 from public.submissions s where s.id=(e->>'id')::bigint and ((p_session is null and s.cohort=scope and s.type='application') or (p_session is not null and exists(select 1 from amas_private.attendance_rosters r join public.cohort_sessions cs on cs.id=r.session_id where r.session_id=p_session and r.submission_id=s.id and cs.cohort=scope and cs.held_on=p_day))))) then
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

