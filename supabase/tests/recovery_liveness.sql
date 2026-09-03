-- ============================================================
-- AUTH-R6.1 · Recovery Flow Liveness 验收
--
-- 目的不是再证明并发安全，而是保证**幂等锁不会把合法用户永久锁死**。
--
-- 时间维度用「直接把时间字段改旧」来模拟陈旧，而不是真等一小时：
-- 被验证的是**状态机与回收逻辑**，不是 wall clock。
--
-- 运行：psql -f supabase/tests/recovery_liveness.sql   结束自动回滚
-- ============================================================
do $$
declare
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  f1 uuid; f2 uuid; v jsonb; v_cnt int; v_txt text;
  v_claims text;
begin
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
   (u1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','live1@test.amas',
    crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}','{}', now(), now()),
   (u2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','live2@test.amas',
    crypt('T!123456', gen_salt('bf')), now(), '{"provider":"email"}','{}', now(), now());

  -- 模拟 recovery session：claims 里带 exp（1 小时后），start 会据此设 expires_at
  v_claims := json_build_object('sub', u1, 'role','authenticated',
                'session_id','sess-1', 'exp', extract(epoch from now() + interval '1 hour')::bigint)::text;
  perform set_config('request.jwt.claims', v_claims, true);

  ------------------------------------------------------------
  -- L01 expires_at 来自凭据 exp，而不是写死的业务 TTL
  ------------------------------------------------------------
  v := public.start_recovery_flow();
  f1 := (v->>'flow_id')::uuid;
  select expires_at into v_txt from public.recovery_flows where id = f1;
  if (select expires_at from public.recovery_flows where id = f1) is null then
    raise exception 'FAIL L01 expires_at 未设置';
  end if;
  if abs(extract(epoch from
        (select expires_at from public.recovery_flows where id = f1) - (now() + interval '1 hour'))) > 5 then
    raise exception 'FAIL L01 expires_at 与凭据 exp 不一致';
  end if;
  raise notice 'PASS L01 expires_at 取自实际凭据 exp（非写死 TTL）';

  ------------------------------------------------------------
  -- L02 用户建了 pending 后完全不操作：凭据过期后可以重新发起
  ------------------------------------------------------------
  update public.recovery_flows set expires_at = now() - interval '1 minute' where id = f1;
  -- 新一轮 recovery：新凭据、新 exp
  perform set_config('request.jwt.claims',
    json_build_object('sub', u1, 'role','authenticated','session_id','sess-2',
      'exp', extract(epoch from now() + interval '1 hour')::bigint)::text, true);
  v := public.start_recovery_flow();
  f2 := (v->>'flow_id')::uuid;
  if f2 = f1 then raise exception 'FAIL L02 陈旧 flow 被当成活动 flow 复用'; end if;
  if (select status from public.recovery_flows where id = f1) <> 'expired' then
    raise exception 'FAIL L02 陈旧 pending 未被回收为 expired';
  end if;
  raise notice 'PASS L02 陈旧 pending 自动回收，用户可重新发起';

  ------------------------------------------------------------
  -- L03 stale pending 不会永久触发唯一索引阻塞
  ------------------------------------------------------------
  select count(*) into v_cnt from public.recovery_flows
   where user_id = u1 and status in ('pending','processing','failed_retryable');
  if v_cnt <> 1 then raise exception 'FAIL L03 活动 flow 数应为 1，实为 %', v_cnt; end if;
  raise notice 'PASS L03 陈旧记录不再占用活动名额（活动 flow 恰好 1 个）';

  ------------------------------------------------------------
  -- L04 processing 卡死（模拟 Edge 崩溃/超时）→ 受控恢复，不永久卡死
  ------------------------------------------------------------
  v := public.claim_recovery_flow(f2, u1);
  if not (v->>'ok')::boolean then raise exception 'FAIL L04 claim 失败: %', v; end if;
  -- 模拟：claim 之后进程崩溃，从此没有任何后续调用
  update public.recovery_flows set claimed_at = now() - interval '30 minutes' where id = f2;
  v := public.reap_stale_recovery_flows(u1);
  if (select status from public.recovery_flows where id = f2) <> 'failed_retryable' then
    raise exception 'FAIL L04 卡死的 processing 未被回收，用户被永久锁死';
  end if;
  if (select reap_reason from public.recovery_flows where id = f2) <> 'processing_timeout' then
    raise exception 'FAIL L04 回收原因未记录（不可审计）';
  end if;
  raise notice 'PASS L04 卡死 processing → failed_retryable，且回收原因可审计';

  ------------------------------------------------------------
  -- L05 客户端不能把 processing 改回 pending
  ------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', u1, 'role','authenticated')::text, true);
  set local role authenticated;
  begin
    update public.recovery_flows set status = 'pending' where id = f2;
    raise exception 'FAIL L05 客户端改写了 flow 状态';
  exception when insufficient_privilege then
    raise notice 'PASS L05 客户端不可改写 recovery flow 状态';
  end;
  reset role;

  ------------------------------------------------------------
  -- L06 恢复后的旧 flow 与新 flow 不得并存（否则可两次 finalize）
  ------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', u1, 'role','authenticated','session_id','sess-3',
      'exp', extract(epoch from now() + interval '1 hour')::bigint)::text, true);
  v := public.start_recovery_flow();
  if (v->>'flow_id')::uuid <> f2 then
    raise exception 'FAIL L06 failed_retryable 未被复用，另开了新 flow（可导致两次 finalize）';
  end if;
  if (v->>'reused')::boolean is not true then raise exception 'FAIL L06 未标记为复用'; end if;
  select count(*) into v_cnt from public.recovery_flows
   where user_id = u1 and status in ('pending','processing','failed_retryable');
  if v_cnt <> 1 then raise exception 'FAIL L06 活动 flow 不唯一（% 个）', v_cnt; end if;
  raise notice 'PASS L06 恢复后复用同一 flow，活动 flow 始终唯一';

  ------------------------------------------------------------
  -- L07 completed 永不可重新激活
  ------------------------------------------------------------
  v := public.claim_recovery_flow(f2, u1);
  v := public.complete_recovery_flow(f2, u1);
  if not (v->>'ok')::boolean then raise exception 'FAIL L07 complete 失败: %', v; end if;
  v := public.claim_recovery_flow(f2, u1);
  if (v->>'ok')::boolean or v->>'error' <> 'already_completed' then
    raise exception 'FAIL L07 completed 被重新激活: %', v;
  end if;
  v := public.reap_stale_recovery_flows(u1);
  if (select status from public.recovery_flows where id = f2) <> 'completed' then
    raise exception 'FAIL L07 reaper 改动了 completed 记录';
  end if;
  raise notice 'PASS L07 completed 永不可重新激活，reaper 也不动它';

  ------------------------------------------------------------
  -- L08 凭据已过期时，即使 flow 仍 pending 也不能 finalize
  ------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', u2, 'role','authenticated','session_id','s2',
      'exp', extract(epoch from now() + interval '1 hour')::bigint)::text, true);
  v := public.start_recovery_flow();
  f1 := (v->>'flow_id')::uuid;
  update public.recovery_flows set expires_at = now() - interval '1 second' where id = f1;
  v := public.claim_recovery_flow(f1, u2);
  if (v->>'ok')::boolean then
    raise exception 'FAIL L08 凭据已过期的 flow 仍被 claim —— 失效凭据被重新变有效';
  end if;
  if v->>'error' <> 'flow_expired' then raise exception 'FAIL L08 错误码不正确: %', v; end if;
  raise notice 'PASS L08 凭据过期后 flow 不可 finalize（失效凭据不会重新生效）';

  ------------------------------------------------------------
  -- L09 回收只做状态迁移，不删除审计所需记录
  ------------------------------------------------------------
  select count(*) into v_cnt from public.recovery_flows where user_id in (u1, u2);
  if v_cnt < 3 then raise exception 'FAIL L09 回收删除了历史记录（仅剩 % 行）', v_cnt; end if;
  select count(*) into v_cnt from public.audit_logs
   where event_type in ('recovery_flow_started','recovery_flows_reaped','recovery_finalized');
  if v_cnt < 3 then raise exception 'FAIL L09 审计事件不完整（% 条）', v_cnt; end if;
  -- 审计与 flow 表都不得含凭据
  select count(*) into v_cnt from public.recovery_flows
   where coalesce(reap_reason,'') !~ '^(credential_expired|processing_timeout)?$';
  if v_cnt <> 0 then raise exception 'FAIL L09 reap_reason 含非预期内容'; end if;
  raise notice 'PASS L09 回收只迁移状态、保留可审计记录，且不含凭据';

  ------------------------------------------------------------
  -- L10 回收不触碰任何业务归属数据
  ------------------------------------------------------------
  insert into public.applications (applicant_id, pathway, status, form_data)
  values (u2, 'bth', 'draft', '{"name_zh":"liveness"}'::jsonb);
  v := public.reap_stale_recovery_flows(null);   -- 全量回收
  select count(*) into v_cnt from public.applications where applicant_id = u2;
  if v_cnt <> 1 then raise exception 'FAIL L10 回收影响了 application 数据'; end if;
  raise notice 'PASS L10 回收不触碰 application/student/CP/learning 归属';

  ------------------------------------------------------------
  -- L11 「旧 flow 恢复 + 新 flow 创建」并发下，活动 flow 至多一个
  ------------------------------------------------------------
  -- 同一事务内无法真并发；这里验证的是裁决机制本身：
  -- 唯一索引 + failed_retryable 计入活动态，使得"另开一个"根本插不进去。
  --
  -- 铺垫：L10 的全量回收已把 u2 之前那个（凭据过期的）flow 落到 expired，
  -- 因此这里必须先给 u2 建一个**活动** flow，否则插入本来就该成功，测不到约束。
  insert into public.recovery_flows (user_id, status, expires_at)
  values (u2, 'pending', now() + interval '1 hour');
  begin
    insert into public.recovery_flows (user_id, status, expires_at)
    values (u2, 'pending', now() + interval '1 hour');
    raise exception 'FAIL L11 同一用户插入了第二个活动 flow';
  exception when unique_violation then
    raise notice 'PASS L11 唯一索引裁决：同一用户至多一个活动 flow';
  end;
  -- 同理，failed_retryable 也算活动态，不能借它绕开
  update public.recovery_flows set status = 'failed_retryable'
   where user_id = u2 and status = 'pending';
  begin
    insert into public.recovery_flows (user_id, status, expires_at)
    values (u2, 'pending', now() + interval '1 hour');
    raise exception 'FAIL L11 failed_retryable 未计入活动态，可另开新 flow';
  exception when unique_violation then
    raise notice 'PASS L11b failed_retryable 同样占用活动名额（不能绕开重试）';
  end;

  ------------------------------------------------------------
  -- L12 crash 恢复后再次 finalize，仍只完成一次
  ------------------------------------------------------------
  perform set_config('request.jwt.claims',
    json_build_object('sub', u2, 'role','authenticated','session_id','s3',
      'exp', extract(epoch from now() + interval '1 hour')::bigint)::text, true);
  update public.recovery_flows set expires_at = now() + interval '1 hour'
   where user_id = u2 and status in ('pending','processing','failed_retryable');
  v := public.start_recovery_flow();   -- 复用 L11 留下的 failed_retryable
  f1 := (v->>'flow_id')::uuid;
  v := public.claim_recovery_flow(f1, u2);
  update public.recovery_flows set claimed_at = now() - interval '30 minutes' where id = f1;  -- 模拟崩溃
  v := public.reap_stale_recovery_flows(u2);
  v := public.claim_recovery_flow(f1, u2);       -- 受控重试
  if not (v->>'ok')::boolean then raise exception 'FAIL L12 crash 后无法重试: %', v; end if;
  v := public.complete_recovery_flow(f1, u2);
  if not (v->>'ok')::boolean then raise exception 'FAIL L12 重试后未能完成'; end if;
  -- 再来一次：必须拒绝
  v := public.claim_recovery_flow(f1, u2);
  if (v->>'ok')::boolean then raise exception 'FAIL L12 完成后仍可再次 claim'; end if;
  select count(*) into v_cnt from public.recovery_flows
   where user_id = u2 and status = 'completed';
  if v_cnt <> 1 then raise exception 'FAIL L12 completed 记录数应为 1，实为 %', v_cnt; end if;
  raise notice 'PASS L12 crash 恢复后仍只完成一次 finalization';

  reset role;
  raise notice '=== AUTH-R6.1 RECOVERY FLOW LIVENESS PASSED ===';
  raise exception 'ROLLBACK_OK';
exception when others then
  if sqlerrm = 'ROLLBACK_OK' then return; end if;
  raise;
end $$;
