-- ══════════════════════════════════════════════════════════════════════
-- 0022 执行后置门禁  ·  STAGING-1A8 §7（FINAL GATE HARDENING 后）
-- ══════════════════════════════════════════════════════════════════════
--
-- 用法：psql "$URL" -v ON_ERROR_STOP=1 -f 本文件
--   任何一项不符即 raise exception，配合 ON_ERROR_STOP=1 使流水线停住。
--
-- ★ 纯 SELECT + raise。本文件不写任何数据。
--
-- 本版按 Supervisor FINAL GATE HARDENING 裁定，把原先三处只 raise notice
-- 的观察项升级为**硬断言**：
--   POSTCOND-1  ledger 版本集合改为精确全等（不再用 LIKE）
--               —— 理由：本项目已经真实发生过 UNKNOWN EXTERNAL WRITER，
--                  「末位是 0022」不足以证明中间没有被塞进别的版本。
--   POSTCOND-7  created_at 指纹硬失败
--   POSTCOND-8  open_execute_funcs = 11 且 rls_tables = 26 硬失败
--
-- 库外仍需单独执行一项：business schema 8/8 EXACT MATCH
-- （r2_schema_fingerprint.sql vs canonical-0021-fingerprint-v2.txt）。
-- 0022 不含任何 DDL，因此该项必须与执行前**完全相同**。
-- 硬断言不替代它，两者都必须做。
-- ══════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

-- created_at 指纹的期望值。默认是 Supervisor 独立复核过的 live 实测值，
-- 本会话亦已在 live 只读复算得到同一值。
-- ★ 该值绑定的是 live 每一行的实际创建时刻，本地沙箱是重建出来的，
--   时间戳必然不同，所以沙箱演练必须用 -v expect_created_digest=<沙箱值> 覆盖。
--   **对 live 执行时不得传这个参数。**
\if :{?expect_created_digest}
\else
  \set expect_created_digest 'dca03a83aff3f0674241739444da006b'
\endif

-- psql 不在 dollar-quoted 字符串内做变量替换，故先落到会话级 GUC。
-- 这是会话设置，不写任何数据。
select set_config('amas.expect_created_digest', :'expect_created_digest', false);

do $$
declare
  v_versions  text;
  v_count     int;
  v_openset   text[];
  v_zh        text;
  v_en        text;
  v_rows      int;
  v_all       text;
  v_unrel     text;
  v_affected  text;
  v_created   text;
  v_openexec  int;
  v_rlstabs   int;
begin
  -- ── 1. ledger 必须**精确等于** 0001–0022 ────────────────────────────
  select count(*), string_agg(version, ',' order by version)
    into v_count, v_versions from supabase_migrations.schema_migrations;

  if v_count <> 22 then
    raise exception 'POSTCOND-1 FAIL: ledger 行数为 %，期望 22', v_count;
  end if;
  if v_versions is distinct from
     '0001,0002,0003,0004,0005,0006,0007,0008,0009,0010,'
     '0011,0012,0013,0014,0015,0016,0017,0018,0019,0020,0021,0022'
  then
    raise exception 'POSTCOND-1 FAIL: ledger 版本集合不精确相符，实际为 %', v_versions;
  end if;

  -- ── 2. 0023–0027 必须全部缺席 ───────────────────────────────────────
  if exists (select 1 from supabase_migrations.schema_migrations
              where version in ('0023','0024','0025','0026','0027')) then
    raise exception 'POSTCOND-2 FAIL: ledger 中出现了 0023–0027';
  end if;

  -- ── 3. 开放集合必须恰好是 canonical 0022 的四个，且顺序一致 ──────────
  select array_agg(code order by sort_order) into v_openset
    from public.program_catalog where is_open_for_application;
  if v_openset is distinct from array['bth','gdip','mdiv','dmin']::text[] then
    raise exception 'POSTCOND-3 FAIL: 开放集合为 %，期望 {bth,gdip,mdiv,dmin}', v_openset;
  end if;

  -- ── 4. dmin 名称必须是 canonical 0022 的精确值 ──────────────────────
  select name_zh, name_en into v_zh, v_en
    from public.program_catalog where code = 'dmin';
  if (v_zh, v_en) is distinct from ('教牧学博士', 'Doctor of Ministry') then
    raise exception 'POSTCOND-4 FAIL: dmin 名称为 (%, %)', v_zh, v_en;
  end if;

  -- ── 5. 无增删行 ─────────────────────────────────────────────────────
  select count(*) into v_rows from public.program_catalog;
  if v_rows <> 9 then
    raise exception 'POSTCOND-5 FAIL: program_catalog 行数为 %，期望 9', v_rows;
  end if;

  -- ── 6. 业务指纹必须精确等于沙箱实测的 post-0022 值 ───────────────────
  --      unrelated 分量就是「无关字段未被改动」的机械化断言：
  --      它在 0022 前后**必须完全不变**。
  select md5(string_agg(concat_ws(E'\x1f', code, name_zh, name_en,
               coalesce(short_label,'\N'), category, sort_order::text,
               is_open_for_application::text, coalesce(intake_note_zh,'\N'),
               coalesce(approved_at::text,'\N')), E'\n' order by code))
    into v_all from public.program_catalog;

  select md5(string_agg(concat_ws(E'\x1f', code, name_zh, name_en,
               coalesce(short_label,'\N'), category, sort_order::text,
               is_open_for_application::text, coalesce(intake_note_zh,'\N'),
               coalesce(approved_at::text,'\N')), E'\n' order by code))
    into v_unrel from public.program_catalog
   where code not in ('laycert','pdip','pastor','preaching','missionary','dmin');

  select md5(string_agg(concat_ws(E'\x1f', code, name_zh, name_en,
               coalesce(short_label,'\N'), category, sort_order::text,
               is_open_for_application::text, coalesce(intake_note_zh,'\N'),
               coalesce(approved_at::text,'\N')), E'\n' order by code))
    into v_affected from public.program_catalog
   where code in ('laycert','pdip','pastor','preaching','missionary','dmin');

  if v_all is distinct from 'cd41beee2463a78e68b8fc39c67f9c07' then
    raise exception 'POSTCOND-6 FAIL: all 业务指纹为 %，期望 cd41beee2463a78e68b8fc39c67f9c07', v_all;
  end if;
  if v_unrel is distinct from 'e99ab6d63d4dc38e3b337aa99304e4e2' then
    raise exception 'POSTCOND-6 FAIL: unrelated 业务指纹为 %，期望 e99ab6d63d4dc38e3b337aa99304e4e2（0022 前后必须不变）', v_unrel;
  end if;
  if v_affected is distinct from '8cab50faa6f85f1940b03dded5157e5c' then
    raise exception 'POSTCOND-6 FAIL: affected 业务指纹为 %，期望 8cab50faa6f85f1940b03dded5157e5c', v_affected;
  end if;

  -- ── 7. created_at 硬门禁：一行都不许被动过 ──────────────────────────
  --      0022 不写 created_at；恢复合同也规定 created_at MUST REMAIN EXACT。
  --      故这里是硬失败，不是提示。
  select md5(string_agg(code || '|' || created_at::text, E'\n' order by code))
    into v_created from public.program_catalog;
  if v_created is distinct from current_setting('amas.expect_created_digest') then
    raise exception 'POSTCOND-7 FAIL: created_at 指纹为 %，期望 %',
                    v_created, current_setting('amas.expect_created_digest');
  end if;

  -- ── 8. 0027 权限面硬门禁 ────────────────────────────────────────────
  --      0022 不含任何 GRANT/REVOKE，权限面必须停在 0021 基线。
  --      判定口径与 r2_schema_fingerprint.sql 的 G2_func_exec_open 完全一致。
  select count(distinct p.proname) into v_openexec
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    cross join lateral (select case when a.grantee = 0 then 'PUBLIC'
                                    else pg_get_userbyid(a.grantee) end as grantee) g
   where n.nspname = 'public'
     and a.privilege_type = 'EXECUTE'
     and g.grantee in ('PUBLIC','anon')
     and not exists (select 1 from pg_depend d
                      where d.objid = p.oid and d.deptype = 'e');

  select count(*) into v_rlstabs from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity;

  if v_openexec <> 11 then
    raise exception 'POSTCOND-8 FAIL: 开放 EXECUTE 的函数为 % 个，期望 11（0027 权限面被动过？）', v_openexec;
  end if;
  if v_rlstabs <> 26 then
    raise exception 'POSTCOND-8 FAIL: 启用 RLS 的表为 % 张，期望 26', v_rlstabs;
  end if;

  raise notice 'POSTCOND ALL PASS  ledger=0001..0022  pc=9行  created=%  open_exec=11  rls=26',
               left(v_created, 8);
end $$;

select 'POSTCOND|OK' as result;
