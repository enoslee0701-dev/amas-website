-- ══════════════════════════════════════════════════════════════════════
-- 0022 执行前置门禁  ·  STAGING-1A8 §6
-- ══════════════════════════════════════════════════════════════════════
--
-- 用法：psql "$URL" -v ON_ERROR_STOP=1 -f 本文件
--   任何一项不符即 raise exception，配合 ON_ERROR_STOP=1 使整条流水线停住。
--
-- ★ 纯 SELECT + raise。本文件不写任何数据。
--
-- 覆盖不到的一项：business schema 8/8 EXACT MATCH。
-- 那需要把 supabase/tests/r2_schema_fingerprint.sql 的输出与
-- docs/operations/r2/canonical-0021-fingerprint-v2.txt 做域级 md5 比对，
-- 是库外比对，SQL 内无法自证。**必须单独执行，且必须先于本门禁通过。**
-- ══════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

-- 期望的 ledger digest。默认值是 live amas-staging 的实测值。
-- ★ 这个值**不可**由 canonical 文件集重算得出：schema_migrations.statements
--   存的是当年实际推送的语句原文，而 live 的 0008 记录缺少 canonical 现在
--   带的 5 处 ::text（详见 STAGING-1A8 报告「0008 ledger 文本漂移」）。
--   因此本地沙箱演练时必须用 -v expect_ledger_digest=<沙箱实测值> 覆盖。
\if :{?expect_ledger_digest}
\else
  \set expect_ledger_digest 'ec46316fd12ce62d09b0290aece90684'
\endif

-- psql 不在 dollar-quoted 字符串内做变量替换，故先落到会话级 GUC。
-- 这是会话设置，不写任何数据。
select set_config('amas.expect_ledger_digest', :'expect_ledger_digest', false);

do $$
declare
  v_versions text;
  v_count    int;
  v_digest   text;
  v_open     int;
  v_closed   int;
  v_renamed  int;
  v_rows     int;
  v_bizdig   text;
begin
  -- ── 1. ledger 必须恰好是 0001–0021 ──────────────────────────────────
  select count(*), string_agg(version, ',' order by version)
    into v_count, v_versions
    from supabase_migrations.schema_migrations;

  if v_count <> 21 then
    raise exception 'PRECOND-1 FAIL: ledger 行数为 %，期望 21', v_count;
  end if;
  if v_versions is distinct from
     '0001,0002,0003,0004,0005,0006,0007,0008,0009,0010,'
     '0011,0012,0013,0014,0015,0016,0017,0018,0019,0020,0021'
  then
    raise exception 'PRECOND-1 FAIL: ledger 版本集合不符，实际为 %', v_versions;
  end if;

  -- ── 2. ledger digest（算法见 supabase/tests/ledger_digest.sql）────────
  select md5(string_agg(
           version || '|' || coalesce(name,'') || '|' ||
           coalesce(md5(array_to_string(statements, E'\n')), ''),
           E'\n' order by version))
    into v_digest
    from supabase_migrations.schema_migrations;

  if v_digest is distinct from current_setting('amas.expect_ledger_digest') then
    raise exception 'PRECOND-2 FAIL: ledger digest 为 %，期望 %',
                    v_digest, current_setting('amas.expect_ledger_digest');
  end if;

  -- ── 3. 0022 必须不在 ledger 中 ───────────────────────────────────────
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0022') then
    raise exception 'PRECOND-3 FAIL: ledger 中已存在 0022';
  end if;

  -- ── 4. 0022 数据态哨兵 ───────────────────────────────────────────────
  select count(*) into v_open
    from public.program_catalog where is_open_for_application;
  select count(*) into v_closed
    from public.program_catalog
   where code in ('laycert','pdip','pastor','preaching','missionary')
     and is_open_for_application = false;
  select count(*) into v_renamed
    from public.program_catalog
   where code = 'dmin' and name_zh = '教牧学博士' and name_en = 'Doctor of Ministry';

  if (v_open, v_closed, v_renamed) is distinct from (9, 0, 0) then
    raise exception 'PRECOND-4 FAIL: 数据态哨兵为 (open=%, five_closed=%, dmin_renamed=%)，期望 (9,0,0)',
                    v_open, v_closed, v_renamed;
  end if;

  -- ── 5. program_catalog 精确前置态（比哨兵强：业务 9 列全覆盖）─────────
  select count(*) into v_rows from public.program_catalog;
  if v_rows <> 9 then
    raise exception 'PRECOND-5 FAIL: program_catalog 行数为 %，期望 9', v_rows;
  end if;

  select md5(string_agg(
           concat_ws(E'\x1f', code, name_zh, name_en,
                     coalesce(short_label,'\N'), category, sort_order::text,
                     is_open_for_application::text,
                     coalesce(intake_note_zh,'\N'),
                     coalesce(approved_at::text,'\N')),
           E'\n' order by code))
    into v_bizdig
    from public.program_catalog;

  if v_bizdig is distinct from '84e0ea68e07150cc67c5909f6abedcac' then
    raise exception 'PRECOND-5 FAIL: program_catalog 业务指纹为 %，期望 84e0ea68e07150cc67c5909f6abedcac', v_bizdig;
  end if;

  raise notice 'PRECOND ALL PASS  ledger=21/%  sentinel=(9,0,0)  pc_business=84e0ea68', left(v_digest,8);
end $$;

select 'PRECOND|OK' as result;
