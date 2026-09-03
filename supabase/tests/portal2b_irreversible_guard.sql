-- ============================================================
-- PORTAL-2B · 不可逆记录登记守卫（2B-11）
--
-- 目的：让"新增正式记录表却忘了登记"这件事**不可能静默通过**。
-- 运行：psql -f supabase/tests/portal2b_irreversible_guard.sql
--
-- 判定逻辑：扫描 public schema 里名字看起来像正式业务记录的表
-- （成绩 / 学分 / 成绩单 / 证书 / 收据 / 支付 / 毕业 / 注册），
-- 每一张都必须在 irreversible_record_sources 中登记；
-- 没登记 → 直接失败，并打印出该建哪条登记。
--
-- 这条测试属于 migration checklist 强制项：
-- 任何新增 migration 之后都要跑一次（已列入 supabase/tests/README.md）。
-- ============================================================
do $$
declare
  r record;
  missing text[] := '{}';
  pending text[] := '{}';
  bad_check text[] := '{}';
  v_ok boolean;
begin
  ------------------------------------------------------------
  -- G01 看起来像正式业务记录的表必须已登记
  ------------------------------------------------------------
  for r in
    select t.tablename
    from pg_tables t
    where t.schemaname = 'public'
      and (
           t.tablename ~* '(^|_)(grade|grades|score|scores)($|_)'
        or t.tablename ~* 'credit'
        or t.tablename ~* 'transcript'
        or t.tablename ~* 'certificate'
        or t.tablename ~* '(receipt|invoice|payment|billing|scholarship)'
        or t.tablename ~* 'graduation'
        or t.tablename ~* 'enrollment'
      )
      -- 登记簿自身与纯参考数据不在此列
      and t.tablename <> 'irreversible_record_sources'
  loop
    if not exists (select 1 from public.irreversible_record_sources s
                    where s.table_name = r.tablename) then
      missing := missing || r.tablename::text;
    end if;
  end loop;

  if array_length(missing, 1) > 0 then
    raise exception E'FAIL G01 以下正式记录表未在 irreversible_record_sources 登记：%\n'
      '每一张都必须回答"它是否构成 student number 的 irreversible record"。\n'
      '若是，必须同时提供 check_sql 并扩展闸门；若否，也要登记并写明理由。\n'
      '参见 docs/operations/engineering-security-rules.md R-8。', array_to_string(missing, ', ');
  end if;
  raise notice 'PASS G01 所有正式记录表均已登记（当前无遗漏）';

  ------------------------------------------------------------
  -- G02 登记为 yes 的来源，check_sql 必须真的能跑
  ------------------------------------------------------------
  for r in
    select source_key, check_sql from public.irreversible_record_sources
     where is_irreversible = 'yes'
  loop
    begin
      execute r.check_sql into v_ok using 'GUARD-PROBE-NONEXISTENT';
      if v_ok is null then bad_check := bad_check || r.source_key::text; end if;
    exception when others then
      bad_check := bad_check || (r.source_key || '(' || sqlerrm || ')')::text;
    end;
  end loop;
  if array_length(bad_check, 1) > 0 then
    raise exception 'FAIL G02 以下登记的 check_sql 无法执行或不返回 boolean：%',
      array_to_string(bad_check, ', ');
  end if;
  raise notice 'PASS G02 所有 check_sql 可执行且返回 boolean';

  ------------------------------------------------------------
  -- G03 存在 pending_decision 时闸门必须 fail closed
  ------------------------------------------------------------
  select array_agg(source_key) into pending
    from public.irreversible_record_sources where is_irreversible = 'pending_decision';
  if pending is not null then
    if not public.student_number_has_irreversible_records('GUARD-PROBE-NONEXISTENT') then
      raise exception 'FAIL G03 存在未决来源（%）时闸门没有 fail closed', array_to_string(pending, ', ');
    end if;
    raise notice 'PASS G03 存在未决来源时闸门 fail closed（未决：%）', array_to_string(pending, ', ');
  else
    raise notice 'PASS G03 当前没有 pending_decision 来源';
  end if;

  ------------------------------------------------------------
  -- G04 闸门对"从未使用过的学号"返回 false（否则纠错功能整体不可用）
  ------------------------------------------------------------
  if pending is null then
    if public.student_number_has_irreversible_records('GUARD-PROBE-NONEXISTENT') then
      raise exception 'FAIL G04 闸门对未使用过的学号误报为有不可逆记录';
    end if;
    raise notice 'PASS G04 闸门对未使用过的学号返回 false';
  end if;

  ------------------------------------------------------------
  -- G05 登记簿对客户端不可读写
  ------------------------------------------------------------
  if has_table_privilege('authenticated', 'public.irreversible_record_sources', 'SELECT')
     or has_table_privilege('anon', 'public.irreversible_record_sources', 'SELECT')
     or has_table_privilege('authenticated', 'public.irreversible_record_sources', 'INSERT') then
    raise exception 'FAIL G05 登记簿对客户端可访问';
  end if;
  raise notice 'PASS G05 登记簿对客户端不可读写';

  raise notice '=== IRREVERSIBLE RECORD GUARD PASSED ===';
end $$;
