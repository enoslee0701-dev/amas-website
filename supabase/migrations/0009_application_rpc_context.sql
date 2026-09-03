-- ============================================================
-- 0009_application_rpc_context · PORTAL-1 验收发现缺陷修复
-- 缺陷：application_protect_locked 禁止「申请人自行改 status」，
--       但该判断对 submit_application / withdraw_application 这类
--       受保护 RPC 同样生效（SECURITY DEFINER 下 auth.uid() 仍是申请人），
--       导致合法路径 needs_information → submitted 被自家触发器拦截（P1-D12 FAIL）。
-- 修复：引入会话级 RPC 上下文标记 amas.rpc_context；
--       仅当标记为 'application' 时允许状态变更（该标记只能由受保护 RPC 内部设置，
--       客户端经 PostgREST 无法预设自定义 GUC，故直接 REST UPDATE 仍被拦截）。
-- ============================================================

create or replace function public.application_protect_locked()
returns trigger language plpgsql set search_path = '' as $$
declare
  k text;
  in_rpc boolean := coalesce(current_setting('amas.rpc_context', true), '') = 'application';
begin
  -- 锁定字段：任何路径都不得修改（含受保护 RPC）
  if old.status::text <> 'draft' then
    foreach k in array coalesce(old.locked_fields, '{}') loop
      if (new.form_data -> k) is distinct from (old.form_data -> k) then
        raise exception 'locked field cannot be modified: %', k;
      end if;
    end loop;
  end if;

  -- 申请人本人：不得自行改 pathway/locked_fields/reviewer/可见说明
  if auth.uid() is not null and auth.uid() = old.applicant_id
     and not public.is_admin_any(auth.uid()) then
    if not in_rpc then
      new.pathway := old.pathway;
      new.locked_fields := old.locked_fields;
      new.assigned_reviewer := old.assigned_reviewer;
      new.applicant_visible_message := old.applicant_visible_message;
      if new.status is distinct from old.status then
        raise exception 'applicant cannot change status directly';
      end if;
    else
      -- 受保护 RPC 内：仍不允许改审核人与可见说明（那是管理员字段）
      new.assigned_reviewer := old.assigned_reviewer;
      new.applicant_visible_message := old.applicant_visible_message;
    end if;
  end if;
  return new;
end $$;

-- 受保护 RPC：进入时设置上下文（事务级，随事务结束自动失效）
create or replace function public.submit_application(p_app uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.applications; missing text[]; unresolved int;
begin
  perform set_config('amas.rpc_context', 'application', true);

  select * into a from public.applications
   where id = p_app and applicant_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if a.status::text not in ('draft','needs_information') then
    raise exception 'invalid_state';
  end if;

  missing := public.application_validate_form(a.form_data, a.pathway::text);
  if array_length(missing,1) > 0 then
    return jsonb_build_object('ok', false, 'error', 'validation_failed', 'missing', to_jsonb(missing));
  end if;

  if a.status::text = 'needs_information' then
    select count(*) into unresolved from public.application_requirements
     where application_id = p_app and resolved = false;
    if unresolved > 0 then
      return jsonb_build_object('ok', false, 'error', 'requirements_pending', 'count', unresolved);
    end if;
  end if;

  update public.applications
     set status = 'submitted',
         submitted_at = coalesce(submitted_at, now()),
         locked_fields = array['name_zh','birth_ym','gender','nationality',
                               'conversion_date','baptism_date','programs']
   where id = p_app;

  insert into public.application_status_history (application_id, from_status, to_status, actor_id, actor_role)
  values (p_app, a.status, 'submitted', auth.uid(), 'applicant');

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value)
  values (auth.uid(), 'applicant', 'application_submitted', 'applications', p_app::text, 'admissions',
          jsonb_build_object('status', a.status), jsonb_build_object('status','submitted'));

  return jsonb_build_object('ok', true, 'status', 'submitted');
end $$;
revoke execute on function public.submit_application(uuid) from public, anon;
grant execute on function public.submit_application(uuid) to authenticated;

create or replace function public.withdraw_application(p_app uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.applications;
begin
  perform set_config('amas.rpc_context', 'application', true);

  select * into a from public.applications
   where id = p_app and applicant_id = auth.uid() for update;
  if not found then raise exception 'not_found'; end if;
  if a.status::text in ('accepted','rejected','withdrawn') then raise exception 'invalid_state'; end if;

  update public.applications set status = 'withdrawn' where id = p_app;
  insert into public.application_status_history
    (application_id, from_status, to_status, actor_id, actor_role, applicant_visible_message)
  values (p_app, a.status, 'withdrawn', auth.uid(), 'applicant', p_reason);
  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (auth.uid(), 'applicant', 'application_withdrawn', 'applications', p_app::text, 'admissions',
          jsonb_build_object('status', a.status), jsonb_build_object('status','withdrawn'), p_reason);
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.withdraw_application(uuid, text) from public, anon;
grant execute on function public.withdraw_application(uuid, text) to authenticated;

-- 审核 RPC 同样设置上下文（管理员路径本就放行，此处为一致性与未来扩展）
create or replace function public.review_application(
  p_app uuid, p_reviewer uuid, p_action text,
  p_message text default null, p_requirements jsonb default null,
  p_internal_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.applications; v_new public.application_status; r jsonb;
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

  update public.applications
     set status = v_new,
         assigned_reviewer = coalesce(assigned_reviewer, p_reviewer),
         applicant_visible_message = coalesce(p_message, applicant_visible_message)
   where id = p_app;

  if p_action = 'needs_information' and p_requirements is not null then
    for r in select * from jsonb_array_elements(p_requirements) loop
      insert into public.application_requirements (application_id, label, detail, created_by)
      values (p_app, coalesce(r ->> 'label','补充资料'), r ->> 'detail', p_reviewer);
    end loop;
  end if;

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
          jsonb_build_object('status', a.status), jsonb_build_object('status', v_new), p_message);

  return jsonb_build_object('ok', true, 'status', v_new);
end $$;
revoke execute on function public.review_application(uuid,uuid,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.review_application(uuid,uuid,text,text,jsonb,text) to service_role;

comment on function public.application_protect_locked is
  'PORTAL-1 锁定守卫（0009 修复版）：锁定字段任何路径不可改；申请人仅在受保护 RPC 上下文中可推进状态。';
