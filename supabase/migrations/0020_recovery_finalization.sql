-- ============================================================
-- 0020_recovery_finalization · AMAS Recovery Finalization Idempotency
--
-- 决策依据 D-AUTH-R6：不再把「recovery credential 只能成功消费一次」当作
-- AMAS 的唯一保护。目标不是证明 Supabase 永远只消费一次，而是证明：
--   **即使底层 recovery verification 在极端并发下出现多个成功结果，
--     AMAS 最终 password finalization 仍然最多执行一次。**
--
-- 核心是**真正的原子状态转换**，不是 check-then-act：
--   UPDATE ... SET status='processing' WHERE id=? AND status IN ('pending','failed_retryable')
-- 由数据库裁决谁抢到，ROW_COUNT 必须为 1；其余并发调用一律 conflict。
--
-- recovery_flow_id 是**非秘密**的：它不能作为认证凭据，只用于流程关联与幂等控制。
-- 真正的身份验证始终由 Supabase 完成（RPC 用 auth.uid()，Edge 用 getUser()）。
--
-- 失败只进入受控的 failed_retryable，**不重新创建身份**；
-- 一次网络失败不得把用户永久锁死。
-- ============================================================

do $$ begin
  create type recovery_flow_status as enum
    ('pending','processing','completed','failed_retryable');
exception when duplicate_object then null; end $$;

create table if not exists public.recovery_flows (
  id            uuid primary key default gen_random_uuid(),   -- = recovery_flow_id（非秘密）
  user_id       uuid not null references public.profiles(id) on delete cascade,
  -- Supabase session_id：同一个 recovery session 重复打开（浏览器刷新 / deep link
  -- 二次打开）必须复用同一个 flow，而不是各开一个（验收 18/19）
  session_id    text,
  status        recovery_flow_status not null default 'pending',
  attempts      int not null default 0,
  last_error    text,          -- ★ 只存错误分类，**绝不含密码或任何凭据**
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  completed_at  timestamptz,
  updated_at    timestamptz not null default now()
);
comment on table public.recovery_flows is
  'AMAS 密码恢复 finalization 幂等控制。id 是非秘密的 recovery_flow_id，不构成认证凭据。';
comment on column public.recovery_flows.last_error is
  '★ 只允许写入错误分类字符串，绝不写入密码、token 或任何凭据。';

-- ★ 每个用户同时至多一个未终结的 flow —— 这条约束本身就挡住了
--   「deep link 重复打开各建一个 flow，然后各自 finalize 一次」这条路径。
create unique index if not exists recovery_flows_one_active
  on public.recovery_flows (user_id)
  where status in ('pending','processing');

create index if not exists recovery_flows_lookup
  on public.recovery_flows (user_id, status, created_at desc);

drop trigger if exists recovery_flows_set_updated_at on public.recovery_flows;
create trigger recovery_flows_set_updated_at before update on public.recovery_flows
  for each row execute function public.set_updated_at();

-- ---------- RLS：本人只读自己的 flow；客户端一律不可写 ----------
alter table public.recovery_flows enable row level security;
drop policy if exists recovery_flows_self_select on public.recovery_flows;
create policy recovery_flows_self_select on public.recovery_flows
  for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.recovery_flows from anon, authenticated;

-- ============================================================
-- 1. 开始一次 recovery flow（authenticated：调用者必须已持有 recovery session）
-- ============================================================
-- 同一 session 重复调用返回**同一个** flow，不新建 —— 支撑验收 18/19。
create or replace function public.start_recovery_flow()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_sid text := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id';
  v_row public.recovery_flows;
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;

  -- 已有未终结的 flow：直接复用（幂等）
  select * into v_row from public.recovery_flows
   where user_id = v_uid and status in ('pending','processing')
   order by created_at desc limit 1;
  if found then
    return jsonb_build_object('ok', true, 'flow_id', v_row.id,
                              'status', v_row.status, 'reused', true);
  end if;

  insert into public.recovery_flows (user_id, session_id, status)
  values (v_uid, v_sid, 'pending')
  returning * into v_row;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category, new_value)
  values (v_uid, 'self', 'recovery_flow_started', 'recovery_flows', v_row.id::text, 'security',
          jsonb_build_object('status', 'pending'));   -- ★ 不含任何凭据

  return jsonb_build_object('ok', true, 'flow_id', v_row.id, 'status', 'pending', 'reused', false);
end $$;
revoke execute on function public.start_recovery_flow() from public, anon;
grant execute on function public.start_recovery_flow() to authenticated;

-- ============================================================
-- 2. ★ 原子 claim：pending|failed_retryable → processing
-- ============================================================
-- **不是** check-then-act。由单条条件 UPDATE 裁决，ROW_COUNT 必须为 1。
-- service_role 专用：只有 Edge Function 能调，客户端不能自行推进状态。
create or replace function public.claim_recovery_flow(p_flow uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int; v_cur public.recovery_flows;
begin
  update public.recovery_flows
     set status = 'processing', claimed_at = now(), attempts = attempts + 1
   where id = p_flow
     and user_id = p_user                       -- 流程归属：wrong user + valid flow → 拿不到
     and status in ('pending', 'failed_retryable');
  get diagnostics v_n = row_count;

  if v_n = 1 then
    return jsonb_build_object('ok', true, 'claimed', true);
  end if;

  -- 没抢到：如实回报当前状态，供调用方区分 conflict / already_completed
  select * into v_cur from public.recovery_flows where id = p_flow;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'flow_not_found');
  end if;
  if v_cur.user_id <> p_user then
    return jsonb_build_object('ok', false, 'error', 'flow_not_owned');
  end if;
  return jsonb_build_object('ok', false,
    'error', case v_cur.status
               when 'processing' then 'already_processing'
               when 'completed'  then 'already_completed'
               else 'conflict' end,
    'status', v_cur.status);
end $$;
revoke execute on function public.claim_recovery_flow(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_recovery_flow(uuid,uuid) to service_role;

-- ============================================================
-- 3. 结算：processing → completed / failed_retryable
-- ============================================================
create or replace function public.complete_recovery_flow(p_flow uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update public.recovery_flows
     set status = 'completed', completed_at = now(), last_error = null
   where id = p_flow and user_id = p_user and status = 'processing';
  get diagnostics v_n = row_count;
  if v_n <> 1 then return jsonb_build_object('ok', false, 'error', 'not_processing'); end if;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category, new_value)
  values (p_user, 'self', 'recovery_finalized', 'recovery_flows', p_flow::text, 'security',
          jsonb_build_object('status', 'completed'));   -- ★ 不含密码
  return jsonb_build_object('ok', true, 'status', 'completed');
end $$;
revoke execute on function public.complete_recovery_flow(uuid,uuid) from public, anon, authenticated;
grant execute on function public.complete_recovery_flow(uuid,uuid) to service_role;

-- 失败只进入受控可重试态；p_reason 必须是**错误分类**，不得含凭据
create or replace function public.fail_recovery_flow(p_flow uuid, p_user uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  update public.recovery_flows
     set status = 'failed_retryable',
         last_error = left(coalesce(p_reason, 'unknown'), 120)
   where id = p_flow and user_id = p_user and status = 'processing';
  get diagnostics v_n = row_count;
  if v_n <> 1 then return jsonb_build_object('ok', false, 'error', 'not_processing'); end if;
  return jsonb_build_object('ok', true, 'status', 'failed_retryable');
end $$;
revoke execute on function public.fail_recovery_flow(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.fail_recovery_flow(uuid,uuid,text) to service_role;

-- ============================================================
-- 4. 本人查询自己的 flow 状态（供页面显示，不含任何敏感信息）
-- ============================================================
create or replace function public.my_recovery_flow()
returns table (id uuid, status text, attempts int, created_at timestamptz, completed_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select f.id, f.status::text, f.attempts, f.created_at, f.completed_at
  from public.recovery_flows f
  where f.user_id = auth.uid()
  order by f.created_at desc limit 1;
$$;
revoke execute on function public.my_recovery_flow() from public, anon;
grant execute on function public.my_recovery_flow() to authenticated;
