-- ============================================================
-- 0021_recovery_flow_liveness · AUTH-R6.1 Recovery Flow Liveness
--
-- 目的**不是**再证明并发安全（0020 已证），而是保证幂等锁不会把合法用户永久锁死。
--
-- ★ TTL 不拍脑袋。两个时间界限都有推导依据：
--
--   1. flow 过期 = **实际 recovery credential 的有效期**。
--      start_recovery_flow 直接读调用者 JWT 的 exp claim 作为 expires_at ——
--      不猜、不写死。凭据什么时候失效，flow 就什么时候失效。
--      由此天然满足：「Supabase recovery credential 已失效时，
--      AMAS flow 绝不能让它重新变有效」。
--
--   2. processing stale threshold = **AMAS 当前运行策略**（见函数内常量注释）。
--      它用于识别明显异常中断的 processing flow，不是对平台行为的永久假设。
--
-- ★ 自愈优先于外部 cron：start_recovery_flow 先回收调用者**自己**的陈旧 flow。
--   用户再次点开恢复链接就能继续，不依赖任何后台任务是否跑过。
--
-- ★ reaper 只做**状态迁移**，绝不删除行 —— 审计所需的非秘密事件记录必须留存。
--   它也只碰 recovery_flows，不触碰任何 application / student / CP / learning 数据。
-- ============================================================

-- 终态：凭据已过期且未完成。与 completed 一样不可再激活。
do $$ begin
  alter type recovery_flow_status add value if not exists 'expired';
exception when others then null; end $$;

alter table public.recovery_flows
  add column if not exists expires_at timestamptz,
  add column if not exists reaped_at  timestamptz,
  add column if not exists reap_reason text;

comment on column public.recovery_flows.expires_at is
  '与实际 recovery credential 同寿：取自签发时调用者 JWT 的 exp claim，不是写死的业务 TTL。';
comment on column public.recovery_flows.reap_reason is
  '陈旧回收原因分类（credential_expired / processing_timeout）。可审计，且绝不含凭据。';

-- ★ 活动态必须包含 failed_retryable：
--   否则"陈旧 processing → failed_retryable"之后，用户还能再建一个新 flow，
--   于是旧新两个 flow 同时可 claim —— 那就等于允许两次 finalize。
--   把 failed_retryable 也算作活动态，用户只能**重试同一个 flow**，不能另开一个。
drop index if exists public.recovery_flows_one_active;
create unique index if not exists recovery_flows_one_active
  on public.recovery_flows (user_id)
  where status in ('pending','processing','failed_retryable');

-- ============================================================
-- 陈旧回收
-- ============================================================
-- 当前 processing stale threshold 为 10 分钟。
--
-- 该值基于当前 password finalization 实测通常为秒级完成，并留有显著安全余量，
-- 用于识别**明显异常中断**的 processing flow。
-- 它是 AMAS 当前的运行策略，**不是**对 Supabase Edge Function 最大执行时间的
-- 永久平台假设。
--
-- ★ 出现以下任一情况时必须重新评估该阈值：
--     · finalize 流程增加外部依赖
--     · Edge runtime 行为变化
--     · 实测 latency 明显提高
create or replace function public.reap_stale_recovery_flows(p_user uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  PROCESSING_STALE_THRESHOLD constant interval := interval '10 minutes';
  v_expired int := 0;
  v_stuck   int := 0;
begin
  -- 1) 凭据已过期而仍未完成 → expired（终态，释放唯一索引占位）
  update public.recovery_flows
     set status = 'expired', reaped_at = now(), reap_reason = 'credential_expired'
   where status in ('pending','failed_retryable')
     and expires_at is not null and expires_at <= now()
     and (p_user is null or user_id = p_user);
  get diagnostics v_expired = row_count;

  -- 2) processing 卡死 → failed_retryable（受控可重试，**不是**回到 pending）
  --    只有超过 stale threshold 才判定为异常中断；不因一次慢请求就抢锁。
  update public.recovery_flows
     set status = 'failed_retryable', reaped_at = now(), reap_reason = 'processing_timeout'
   where status = 'processing'
     and claimed_at is not null and claimed_at <= now() - PROCESSING_STALE_THRESHOLD
     and (p_user is null or user_id = p_user);
  get diagnostics v_stuck = row_count;

  -- 3) 卡死回收后若凭据也已过期，直接落到终态
  update public.recovery_flows
     set status = 'expired', reaped_at = now(), reap_reason = 'credential_expired'
   where status = 'failed_retryable'
     and expires_at is not null and expires_at <= now()
     and (p_user is null or user_id = p_user);

  if v_expired + v_stuck > 0 then
    insert into public.audit_logs (actor_id, actor_role, event_type, target_type, category, new_value)
    values (null, 'system', 'recovery_flows_reaped', 'recovery_flows', 'security',
            jsonb_build_object('expired', v_expired, 'processing_timeout', v_stuck));
  end if;
  return jsonb_build_object('ok', true, 'expired', v_expired, 'processing_timeout', v_stuck);
end $$;
revoke execute on function public.reap_stale_recovery_flows(uuid) from public, anon, authenticated;
grant execute on function public.reap_stale_recovery_flows(uuid) to service_role;

-- ============================================================
-- start：先自愈回收自己的陈旧 flow，再复用/新建
-- ============================================================
create or replace function public.start_recovery_flow()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_sid   text := v_claims ->> 'session_id';
  -- ★ 与实际凭据同寿：直接取 JWT 的 exp，不写死业务 TTL
  v_exp   timestamptz := to_timestamp((v_claims ->> 'exp')::bigint);
  v_row   public.recovery_flows;
begin
  if v_uid is null then raise exception 'unauthenticated'; end if;

  -- 自愈：不依赖外部 cron，用户再点一次链接就能继续
  perform public.reap_stale_recovery_flows(v_uid);

  select * into v_row from public.recovery_flows
   where user_id = v_uid and status in ('pending','processing','failed_retryable')
   order by created_at desc limit 1;
  if found then
    -- 复用同一 flow（含 failed_retryable 的受控重试），绝不另开一个
    return jsonb_build_object('ok', true, 'flow_id', v_row.id,
                              'status', v_row.status, 'reused', true);
  end if;

  insert into public.recovery_flows (user_id, session_id, status, expires_at)
  values (v_uid, v_sid, 'pending', v_exp)
  returning * into v_row;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category, new_value)
  values (v_uid, 'self', 'recovery_flow_started', 'recovery_flows', v_row.id::text, 'security',
          jsonb_build_object('status', 'pending', 'expires_at', v_exp));

  return jsonb_build_object('ok', true, 'flow_id', v_row.id, 'status', 'pending', 'reused', false);
end $$;
revoke execute on function public.start_recovery_flow() from public, anon;
grant execute on function public.start_recovery_flow() to authenticated;

-- ============================================================
-- claim：过期的 flow 一律不可 claim
-- ============================================================
create or replace function public.claim_recovery_flow(p_flow uuid, p_user uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int; v_cur public.recovery_flows;
begin
  -- 先把该用户的陈旧 flow 归位，避免"卡死锁"挡住合法重试
  perform public.reap_stale_recovery_flows(p_user);

  update public.recovery_flows
     set status = 'processing', claimed_at = now(), attempts = attempts + 1
   where id = p_flow
     and user_id = p_user
     and status in ('pending', 'failed_retryable')
     -- ★ 凭据已过期的 flow 绝不可 claim：AMAS 不能让失效凭据重新变有效
     and (expires_at is null or expires_at > now());
  get diagnostics v_n = row_count;

  if v_n = 1 then return jsonb_build_object('ok', true, 'claimed', true); end if;

  select * into v_cur from public.recovery_flows where id = p_flow;
  if not found then return jsonb_build_object('ok', false, 'error', 'flow_not_found'); end if;
  if v_cur.user_id <> p_user then return jsonb_build_object('ok', false, 'error', 'flow_not_owned'); end if;
  if v_cur.expires_at is not null and v_cur.expires_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'flow_expired', 'status', v_cur.status);
  end if;
  return jsonb_build_object('ok', false,
    'error', case v_cur.status
               when 'processing' then 'already_processing'
               when 'completed'  then 'already_completed'
               when 'expired'    then 'flow_expired'
               else 'conflict' end,
    'status', v_cur.status);
end $$;
revoke execute on function public.claim_recovery_flow(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_recovery_flow(uuid,uuid) to service_role;

-- my_recovery_flow 补上时间字段（仍不含任何敏感信息）。
-- 返回列有变化，必须先 drop —— create or replace 不能改返回类型。
drop function if exists public.my_recovery_flow();
create function public.my_recovery_flow()
returns table (id uuid, status text, attempts int, created_at timestamptz,
               expires_at timestamptz, completed_at timestamptz, reap_reason text)
language sql stable security definer set search_path = '' as $$
  select f.id, f.status::text, f.attempts, f.created_at,
         f.expires_at, f.completed_at, f.reap_reason
  from public.recovery_flows f
  where f.user_id = auth.uid()
  order by f.created_at desc limit 1;
$$;
revoke execute on function public.my_recovery_flow() from public, anon;
grant execute on function public.my_recovery_flow() to authenticated;
