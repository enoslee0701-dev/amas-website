-- Reconcile to the later 2026-10-26 HQ form decision recorded in the site.
-- Preserve historical codes and fail closed if other open offerings appeared.
do $$ begin
 if exists(select 1 from public.program_catalog where is_open_for_application and code not in ('bth','pastor','preaching','dip','gdip','mdiv','dmin','missionary','laycert','pdip')) then
  raise exception 'Unexpected open program; reconcile the academic offering policy before applying this migration';
 end if;
end $$;
insert into public.program_catalog(code,name_zh,name_en,short_label,category,sort_order,is_open_for_application,approved_at)
values('dip','大学（DIP）','Diploma (DIP)','DIP','certificate',40,true,'2026-10-26')
on conflict(code) do update set name_zh=excluded.name_zh,short_label=excluded.short_label;
update public.program_catalog set is_open_for_application=(code in ('bth','pastor','preaching','dip','gdip','mdiv','dmin','missionary')) where code in ('bth','pastor','preaching','dip','gdip','mdiv','dmin','missionary','laycert','pdip');
update public.program_catalog set sort_order=v.sort from (values
 ('bth',10),('pastor',20),('preaching',30),('dip',40),('gdip',50),('mdiv',60),('dmin',70),('missionary',80)) v(code,sort)
where program_catalog.code=v.code;

-- Content managers can maintain announcements/settings without admissions,
-- academic records, role management, finance, or full cohort record access.
create or replace function public.is_content_staff(p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select public.is_admin_any(p_user) or public.has_active_role(p_user,'content_admin');
$$;
revoke all on function public.is_content_staff(uuid) from public,anon;
grant execute on function public.is_content_staff(uuid) to authenticated,service_role;
drop policy if exists sa_admin on public.site_announcements;
drop policy if exists ss_admin on public.site_settings;
drop policy if exists sa_read on public.site_announcements;
drop policy if exists sa_insert on public.site_announcements;
drop policy if exists sa_update on public.site_announcements;
drop policy if exists ss_read on public.site_settings;
drop policy if exists ss_update on public.site_settings;
create policy sa_read on public.site_announcements for select to authenticated using ((select public.is_content_staff(auth.uid()) and public.request_is_aal2()));
create policy sa_insert on public.site_announcements for insert to authenticated with check ((select public.is_content_staff(auth.uid()) and public.request_is_aal2()));
create policy sa_update on public.site_announcements for update to authenticated using ((select public.is_content_staff(auth.uid()) and public.request_is_aal2())) with check ((select public.is_content_staff(auth.uid()) and public.request_is_aal2()));
create policy ss_read on public.site_settings for select to authenticated using ((select public.is_content_staff(auth.uid()) and public.request_is_aal2()));
create policy ss_update on public.site_settings for update to authenticated using ((select public.is_content_staff(auth.uid()) and public.request_is_aal2())) with check ((select public.is_content_staff(auth.uid()) and public.request_is_aal2()));

create or replace function public.content_cohorts()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.is_content_staff(auth.uid()) or not public.request_is_aal2() then raise exception using errcode='42501',message='forbidden';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('name',name,'phase',phase,'show_on_site',show_on_site,'sort',sort) order by sort,name) from public.submission_cohorts),'[]'::jsonb);
end $$;
create or replace function public.content_set_cohort(p_name text,p_phase text,p_show boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not public.is_content_staff(auth.uid()) or not public.request_is_aal2() then raise exception using errcode='42501',message='forbidden';end if;
 if p_phase is null or p_phase not in ('enrolling','in_session','finished') or p_show is null then return jsonb_build_object('ok',false,'error','validation_failed');end if;
 update public.submission_cohorts set phase=p_phase,show_on_site=p_show where name=p_name;
 if not found then return jsonb_build_object('ok',false,'error','not_found');end if;
 insert into public.audit_logs(actor_id,event_type,target_type,target_id,category,new_value)
  values(auth.uid(),'content.cohort_visibility','submission_cohort',p_name,'academic',jsonb_build_object('phase',p_phase,'show_on_site',p_show));
 return jsonb_build_object('ok',true);
end $$;
revoke all on function public.content_cohorts(),public.content_set_cohort(text,text,boolean) from public,anon;
grant execute on function public.content_cohorts(),public.content_set_cohort(text,text,boolean) to authenticated;
