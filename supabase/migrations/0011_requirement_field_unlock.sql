-- ============================================================
-- 0011_requirement_field_unlock · PORTAL-1 验收发现业务缺陷修复
-- 缺陷：提交后锁定 name_zh/birth_ym/gender/nationality/conversion_date/baptism_date/programs；
--       若审核员要求补充的恰是锁定字段（例：受洗日期），申请人无法修改 → 补件流程死锁。
-- 修复：补件条目可携带 field（对应表单字段名）；review_application 在
--       needs_information 时把这些 field 从 locked_fields 中移除（精确解锁、留审计），
--       重新提交时再次全量锁定。未指定 field 的条目不解锁任何字段（仅文字说明）。
-- ============================================================

alter table public.application_requirements
  add column if not exists field text;
comment on column public.application_requirements.field is
  '可选：本条要求对应的表单字段名；填写后该字段在 needs_information 阶段被解锁。';

create or replace function public.review_application(
  p_app uuid, p_reviewer uuid, p_action text,
  p_message text default null, p_requirements jsonb default null,
  p_internal_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.applications;
  v_new public.application_status;
  r jsonb;
  v_unlock text[] := '{}';
begin
  perform set_config('amas.rpc_context', 'application', true);
  if not public.is_admin_any(p_reviewer) then raise exception 'reviewer lacks admin role'; end if;
  select * into a from public.applications where id = p_app for update;
  if not found then raise exception 'not_found'; end if;

  v_new := case p_action
    when 'start_review'      then 'under_review'
    when 'needs_information' then 'needs_information'
    when 'accept'            then 'accepted'
    when 'reject'            then 'rejected'
    else null end::public.application_status;
  if v_new is null then raise exception 'unknown action %', p_action; end if;

  -- 条目化补件（可指定 field 以精确解锁）
  if p_action = 'needs_information' and p_requirements is not null then
    for r in select * from jsonb_array_elements(p_requirements) loop
      insert into public.application_requirements (application_id, label, detail, field, created_by)
      values (p_app, coalesce(r ->> 'label','补充资料'), r ->> 'detail', nullif(r ->> 'field',''), p_reviewer);
      if coalesce(r ->> 'field','') <> '' then
        v_unlock := v_unlock || (r ->> 'field')::text;
      end if;
    end loop;
  end if;

  update public.applications
     set status = v_new,
         assigned_reviewer = coalesce(assigned_reviewer, p_reviewer),
         applicant_visible_message = coalesce(p_message, applicant_visible_message),
         -- 精确解锁：仅移除本次被要求补充的字段
         locked_fields = case
           when p_action = 'needs_information' and array_length(v_unlock,1) > 0
             then array(select unnest(locked_fields) except select unnest(v_unlock))
           else locked_fields end
   where id = p_app;

  if p_internal_note is not null then
    insert into public.application_internal (application_id, notes, updated_by)
    values (p_app, p_internal_note, p_reviewer)
    on conflict (application_id) do update
      set notes = public.application_internal.notes || E'\n' || excluded.notes,
          updated_by = excluded.updated_by, updated_at = now();
  end if;

  insert into public.application_status_history
    (application_id, from_status, to_status, actor_id, actor_role, applicant_visible_message, internal_note)
  values (p_app, a.status, v_new, p_reviewer, 'admin', p_message, p_internal_note);

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_reviewer, 'admin', 'application_' || p_action, 'applications', p_app::text, 'admissions',
          jsonb_build_object('status', a.status, 'locked_fields', to_jsonb(a.locked_fields)),
          jsonb_build_object('status', v_new, 'unlocked', to_jsonb(v_unlock)), p_message);

  return jsonb_build_object('ok', true, 'status', v_new, 'unlocked', to_jsonb(v_unlock));
end $$;
revoke execute on function public.review_application(uuid,uuid,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.review_application(uuid,uuid,text,text,jsonb,text) to service_role;

comment on function public.review_application is
  'PORTAL-1 招生审核（0011 修复版）：needs_information 时按 requirements.field 精确解锁字段，重新提交后再次全量锁定；全过程写 admissions 审计。';
