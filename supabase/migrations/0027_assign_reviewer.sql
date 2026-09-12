-- ============================================================
-- AMAS · 招生审核人指派（G1）
--
-- 语义（由项目负责人裁定，保守口径）：
--   · 指派**只记录分工** —— 不扩大任何人的访问权，也不减少其他审核人的权限；
--     谁本来能审，指派之后照样能审。
--   · 只有 submitted / under_review / needs_information 可以改指派。
--     accepted / rejected / withdrawn（终态）与 draft（未提交）一律拒绝，
--     检查放在**行锁之后**，不另设归档更正流程。
--   · 只写 audit_logs，**不写 application_status_history** ——
--     my_application_timeline(p_app) 返回该申请全部 history 行且不按类型过滤
--     （0008_applications.sql:211-218），写进去申请人时间线就会多出一条，
--     等于把内部人员安排透给他。
--   · 不发任何通知（无邮件、无外部推送）。
--
-- 授权：仅 service_role 可执行。调用方是 Edge Function review-application，
--       那里已经验过角色与 **aal2**；本函数不重复实现授权，只做 is_admin_any 前置。
--
-- ⚠ 本文件在编写它的那次会话里**没有被 apply**，也没有对任何真实数据库执行过。
--   下面每一条行为都是 NOT_RUN —— 离线测试只覆盖客户端，不构成对本函数的验证。
-- ============================================================

create or replace function public.assign_application_reviewer(
  p_app      uuid,
  p_actor    uuid,
  p_reviewer uuid,          -- null = 取消指派
  p_expected uuid,          -- 调用方看到的当前值；**没有默认值**，必须显式传
  p_note     text default null   -- 仅内部，绝不进 applicant_visible_message
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.applications; v_old uuid; v_evt text;
begin
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;

  -- 行锁先拿，之后所有判断都基于锁住的这一行（与 review_application 同形）
  select * into a from public.applications where id = p_app for update;
  if not found then raise exception 'not_found'; end if;

  -- 可指派的状态只有「在审」这三个。锁之后立刻判。
  --   draft      —— 还没提交，指派没有意义；而且这一次 update 会触发
  --                 applications_set_updated_at（0008:51）bump updated_at，
  --                 正在编辑草稿的申请人下一次保存就会撞上一次**无谓的版本冲突**。
  --   accepted / rejected / withdrawn —— 终态，新指派、重指派、取消一律不允许。
  -- 返回里带上 status，让调用方能说清楚「因为它现在是什么状态所以不能指派」。
  if a.status::text not in ('submitted','under_review','needs_information') then
    return jsonb_build_object('ok', false, 'error', 'not_assignable', 'status', a.status::text);
  end if;

  v_old := a.assigned_reviewer;

  -- 乐观并发：调用方看到的当前值与库里不一致，就不盲覆盖
  if p_expected is distinct from v_old then
    return jsonb_build_object('ok', false, 'error', 'reassigned', 'current', v_old);
  end if;

  -- 只能指给**本来就能审**的人。用 is_admin_any 而不是自己拼条件 ——
  -- 它内部是 has_active_role（revoked_at is null 且 expires_at 未过，0002:117-125），
  -- 客户端的候选人过滤必须与这里一致，不能各写一套。
  if p_reviewer is not null and not public.is_admin_any(p_reviewer) then
    return jsonb_build_object('ok', false, 'error', 'not_a_reviewer');
  end if;

  if v_old is not distinct from p_reviewer then
    return jsonb_build_object('ok', true, 'assigned_reviewer', v_old, 'changed', false);
  end if;

  update public.applications set assigned_reviewer = p_reviewer where id = p_app;

  v_evt := case when p_reviewer is null then 'application_unassign'
                when v_old is null      then 'application_assign'
                else                         'application_reassign' end;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id,
                                 category, old_value, new_value, reason)
  values (p_actor, 'admin', v_evt, 'applications', p_app::text, 'admissions',
          jsonb_build_object('assigned_reviewer', v_old),
          jsonb_build_object('assigned_reviewer', p_reviewer), p_note);

  return jsonb_build_object('ok', true, 'assigned_reviewer', p_reviewer, 'changed', true);
end $$;

revoke execute on function public.assign_application_reviewer(uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant  execute on function public.assign_application_reviewer(uuid,uuid,uuid,uuid,text)
  to service_role;

comment on function public.assign_application_reviewer is
  'G1 招生审核人指派：只记录分工，不改任何人的访问权；终态不可改；只写 audit_logs，不写 application_status_history。';

-- 说明（不改代码，只记录）：review_application 里
--   assigned_reviewer = coalesce(assigned_reviewer, p_reviewer)
-- 保持原样。所以**取消指派之后，下一次有人执行审核动作，这一列会被再次自动填上那个人**。
-- 这是既有行为，不在本次范围内修改；界面必须把这一点写给操作者看。
