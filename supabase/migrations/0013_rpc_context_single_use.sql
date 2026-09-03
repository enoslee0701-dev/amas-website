-- ============================================================
-- 0013_rpc_context_single_use · PORTAL-2 验收发现，回补到 PORTAL-1 申请域
--
-- 缺陷：0009 引入的 amas.rpc_context 用 set_config(..., true) 设置，是**事务级**的。
--       RPC 返回后标记仍留在同一事务里，此后同一事务内的任何直写都会被当成"受保护流程"。
--       PostgREST 一请求一事务时不构成实际风险，但这条防线的强度不该依赖调用方的事务边界；
--       PORTAL-2 的 DB 验收（P2-D10）正是在同一事务内先调 RPC 再直写，一次就穿透了。
--
-- 修复：令牌用后即焚——守卫触发器在放行一次后立即清空 amas.rpc_context。
--       每个受保护 RPC 因此只能写主表一次（现有 RPC 均只写一次），多写即被拒。
--       0012 的 student_guard 已采用同一写法，这里把 applications 补齐。
--
-- 行为不变：正常的 submit / withdraw / review 流程照常通过（见 portal1_acceptance.sql 全量回归）。
-- ============================================================

create or replace function public.application_protect_locked()
returns trigger language plpgsql set search_path = '' as $$
declare
  k text;
  in_rpc boolean := coalesce(current_setting('amas.rpc_context', true), '') = 'application';
begin
  if in_rpc then perform set_config('amas.rpc_context', '', true); end if;   -- 用后即焚

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

comment on function public.application_protect_locked is
  '申请域锁定/越权守卫（0013）：rpc_context 令牌用后即焚，防止同一事务内 RPC 之后的直写继承受保护身份。';
