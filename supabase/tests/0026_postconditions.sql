-- ══════════════════════════════════════════════════════════════════════
-- 0026 POST-DB3 CANONICAL GATE  ·  STAGING-1A10 §1
-- ══════════════════════════════════════════════════════════════════════
--
-- 用法：psql "$URL" -v ON_ERROR_STOP=1 -f 本文件
--
-- ★ 纯 SELECT + raise。本文件不写任何数据、不建任何对象。
--
-- 与 supabase/tests/0022_postconditions.sql 的关系：
--   那一份门禁的是 **post-0022** 终态（rls_tables=26 / open_execute_funcs=11），
--   它是历史门禁，**刻意保持不变**。live 推进到 DB-3 之后它会失败，那是正确行为
--   —— 把它的常量改成 54/12 会让它不再门禁它所命名的那个状态。
--   本文件承接 **post-0026** 终态。两者并存，各自门禁各自的时点。
--
-- 八域指纹的行构造式**从 supabase/tests/r2_schema_fingerprint.sql 原样提取**，
-- 不是手抄。因此本门禁与既有 R2 方法论逐字符一致：
--   每域 digest = md5( 该域行按字典序排序、以单个 LF 连接 )
--   scope = public schema，排除扩展自有对象（pg_depend deptype='e'）
-- 期望值全部在 **PG 17.6（目标版本）** 上算出，
-- 见 docs/operations/db3/pg176-db3-fingerprints.txt。
-- **不得使用任何 PG 18.6 来源的 digest。**
--
-- 基线来源：DB-3 LIVE 执行后实测 8/8 EXACT MATCH
-- （docs/operations/db3/DB-3-LIVE-EXECUTION-REPORT.md）。
-- ══════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

do $gate$
declare
  bad      text := '';
  okdom    int  := 0;
  q        text;
  v_n      bigint;
  v_m      text;
  v_ver    text;
  v_rows   int;
  v_dig    text;
  v_tab    int;
  v_rls    int;
  v_norls  int;
  v_mig    int;
  v_migrls int;
  v_pol    int;
  v_fn     int;
  v_open   int;
  v_app    int;
  v_users  int;
  v_prof   int;
  v_roles  int;
  v_pc     int;
  v_biz    text;
  v_cre    text;
  v_set    text[];
  v_zh     text;
  v_en     text;
  a bool; b bool; c bool;
begin
  -- ── 1. ledger 精确等于 0001–0026 ────────────────────────────────────
  select count(*), string_agg(version, ',' order by version)
    into v_rows, v_ver from supabase_migrations.schema_migrations;
  if v_rows <> 26 then
    bad := bad || format('ledger 行数=%s(期望26); ', v_rows); end if;
  if v_ver is distinct from
     '0001,0002,0003,0004,0005,0006,0007,0008,0009,0010,0011,0012,0013,'
     '0014,0015,0016,0017,0018,0019,0020,0021,0022,0023,0024,0025,0026'
  then bad := bad || format('ledger 版本集合不精确=%s; ', v_ver); end if;

  -- ── 2. ledger digest（算法见 supabase/tests/ledger_digest.sql）───────
  select md5(string_agg(
           version || '|' || coalesce(name,'') || '|' ||
           coalesce(md5(array_to_string(statements, E'\n')), ''),
           E'\n' order by version))
    into v_dig from supabase_migrations.schema_migrations;
  if v_dig is distinct from 'e781ce12b804fbc3508179c7b97ae56a' then
    bad := bad || format('ledger digest=%s; ', v_dig); end if;

  -- ── 3. 0027 必须缺席 ────────────────────────────────────────────────
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0027')
  then bad := bad || '0027 已入账; '; end if;

  -- ── 4. 表 / RLS / 策略 / 函数 ───────────────────────────────────────
  select count(*),
         count(*) filter (where c.relrowsecurity),
         count(*) filter (where not c.relrowsecurity)
    into v_tab, v_rls, v_norls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r';
  if v_tab   <> 54 then bad := bad || format('public 表=%s(期望54); ', v_tab); end if;
  if v_rls   <> 54 then bad := bad || format('public RLS=%s(期望54); ', v_rls); end if;
  if v_norls <> 0  then bad := bad || format('public 无 RLS 表=%s(期望0); ', v_norls); end if;

  select count(*) into v_app
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'app\_%';
  if v_app <> 28 then bad := bad || format('app_* 表=%s(期望28); ', v_app); end if;

  select count(*), count(*) filter (where c.relrowsecurity)
    into v_mig, v_migrls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'migration' and c.relkind = 'r';
  if v_mig    <> 4 then bad := bad || format('migration 表=%s(期望4); ', v_mig); end if;
  if v_migrls <> 0 then bad := bad || format('migration RLS=%s(期望0); ', v_migrls); end if;

  select count(*) into v_pol
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public';
  if v_pol <> 33 then bad := bad || format('策略=%s(期望33); ', v_pol); end if;

  select count(*) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
   where n.nspname = 'public' and d.objid is null;
  if v_fn <> 60 then bad := bad || format('public 非扩展函数=%s(期望60); ', v_fn); end if;

  -- ── 5. open_execute_funcs（口径与 G2_func_exec_open 一致）───────────
  --     ★ 它与 rls_tables 是两个不同指标，不得互相推导。
  --       post-0022 = 11，post-0026 = 12，+1 是 app_rooms_mark_host_orphaned。
  select count(distinct p.proname) into v_open
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
    cross join lateral (select case when x.grantee = 0 then 'PUBLIC'
                                    else pg_get_userbyid(x.grantee) end as g) g
   where n.nspname = 'public' and x.privilege_type = 'EXECUTE'
     and g.g in ('PUBLIC','anon')
     and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e');
  if v_open <> 12 then bad := bad || format('open_execute_funcs=%s(期望12); ', v_open); end if;

  -- ── 6. migration schema 的 schema-level deny ────────────────────────
  --     那 4 张表不启 RLS 是安全的，因为 schema 本身不可达 —— 不是遗漏。
  if to_regnamespace('migration') is null then
    bad := bad || 'migration schema 不存在; ';
  else
    a := has_schema_privilege('anon',         'migration', 'USAGE');
    b := has_schema_privilege('authenticated','migration', 'USAGE');
    c := has_schema_privilege('service_role', 'migration', 'USAGE');
    if a or b or c then
      bad := bad || format('migration USAGE 未全 false: anon=%s auth=%s svc=%s; ', a, b, c); end if;
  end if;

  -- ── 7. 身份与业务态必须未被 DB-3 改动（DB-3 = SCHEMA ONLY）──────────
  select count(*) into v_users from auth.users;
  select count(*) into v_prof  from public.profiles;
  select count(*) into v_roles from public.user_roles;
  select count(*) into v_pc    from public.program_catalog;
  if v_users <> 1 then bad := bad || format('auth.users=%s(期望1); ', v_users); end if;
  if v_prof  <> 1 then bad := bad || format('profiles=%s(期望1); ', v_prof); end if;
  if v_roles <> 1 then bad := bad || format('user_roles=%s(期望1); ', v_roles); end if;
  if v_pc    <> 9 then bad := bad || format('program_catalog=%s(期望9); ', v_pc); end if;

  select md5(string_agg(concat_ws(E'\x1f', code, name_zh, name_en,
               coalesce(short_label,'\N'), category, sort_order::text,
               is_open_for_application::text, coalesce(intake_note_zh,'\N'),
               coalesce(approved_at::text,'\N')), E'\n' order by code))
    into v_biz from public.program_catalog;
  if v_biz is distinct from 'cd41beee2463a78e68b8fc39c67f9c07' then
    bad := bad || format('pc 业务指纹=%s; ', v_biz); end if;

  select md5(string_agg(code || '|' || created_at::text, E'\n' order by code))
    into v_cre from public.program_catalog;
  if v_cre is distinct from 'dca03a83aff3f0674241739444da006b' then
    bad := bad || format('pc created_at 指纹=%s; ', v_cre); end if;

  select array_agg(code order by sort_order) into v_set
    from public.program_catalog where is_open_for_application;
  if v_set is distinct from array['bth','gdip','mdiv','dmin']::text[] then
    bad := bad || format('开放集合=%s; ', v_set); end if;

  select name_zh, name_en into v_zh, v_en from public.program_catalog where code = 'dmin';
  if (v_zh, v_en) is distinct from ('教牧学博士', 'Doctor of Ministry') then
    bad := bad || format('dmin 名称=(%s, %s); ', v_zh, v_en); end if;

  -- ── 8. A–F/H 八域指纹，必须 8/8 EXACT MATCH ─────────────────────────
  -- ── A_column ──
  q := $q$select 'A_column|' || c.relname || '.' || a.attname || '|'
       || replace(replace(
            a.attnum || ' ' || format_type(a.atttypid, a.atttypmod)
            || ' null=' || (not a.attnotnull)::text
            || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '(none)')
            || ' generated=' || coalesce(nullif(a.attgenerated::text, ''), '-')
          , E'\r', '\\r'), E'\n', '\\n')
from pg_attribute a
join pg_class c        on c.oid = a.attrelid
join pg_namespace n    on n.oid = c.relnamespace
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where n.nspname = 'public' and c.relkind = 'r'
  and a.attnum > 0 and not a.attisdropped
  and not exists (select 1 from pg_depend dep where dep.objid = c.oid and dep.deptype = 'e')
order by 1$q$;
  execute 'select count(*), coalesce(md5(string_agg(line, E''
'' order by line)), ''(empty)'') from (' || q || ') t(line)'
    into v_n, v_m;
  if v_n <> 434 or v_m <> 'e655f5d26c430d6f76ecc6e439eed699' then
    bad := bad || format('A_column rows=%s md5=%s (期望 434 / e655f5d26c430d6f76ecc6e439eed699); ', v_n, v_m);
  else
    okdom := okdom + 1;
  end if;

  -- ── B_constraint ──
  q := $q$select 'B_constraint|' || t.relname || '.' || con.conname || '|'
       || replace(replace(
            con.contype::text || ' ' || pg_get_constraintdef(con.oid)
          , E'\r', '\\r'), E'\n', '\\n')
from pg_constraint con
join pg_class t     on t.oid = con.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
order by 1$q$;
  execute 'select count(*), coalesce(md5(string_agg(line, E''
'' order by line)), ''(empty)'') from (' || q || ') t(line)'
    into v_n, v_m;
  if v_n <> 166 or v_m <> '032a9c98a2e3df4b7fc04de5f761809d' then
    bad := bad || format('B_constraint rows=%s md5=%s (期望 166 / 032a9c98a2e3df4b7fc04de5f761809d); ', v_n, v_m);
  else
    okdom := okdom + 1;
  end if;

  -- ── C_index ──
  q := $q$select 'C_index|' || t.relname || '.' || i.relname || '|'
       || replace(replace(pg_get_indexdef(x.indexrelid), E'\r', '\\r'), E'\n', '\\n')
from pg_index x
join pg_class i     on i.oid = x.indexrelid
join pg_class t     on t.oid = x.indrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
order by 1$q$;
  execute 'select count(*), coalesce(md5(string_agg(line, E''
'' order by line)), ''(empty)'') from (' || q || ') t(line)'
    into v_n, v_m;
  if v_n <> 123 or v_m <> '8956d7006a4fcc20aa93a65c421ecc81' then
    bad := bad || format('C_index rows=%s md5=%s (期望 123 / 8956d7006a4fcc20aa93a65c421ecc81); ', v_n, v_m);
  else
    okdom := okdom + 1;
  end if;

  -- ── D_trigger ──
  q := $q$select 'D_trigger|' || t.relname || '.' || g.tgname || '|'
       || replace(replace(pg_get_triggerdef(g.oid), E'\r', '\\r'), E'\n', '\\n')
from pg_trigger g
join pg_class t     on t.oid = g.tgrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public' and not g.tgisinternal
  and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
order by 1$q$;
  execute 'select count(*), coalesce(md5(string_agg(line, E''
'' order by line)), ''(empty)'') from (' || q || ') t(line)'
    into v_n, v_m;
  if v_n <> 19 or v_m <> '38695e309ed38faadc75976b33babbc7' then
    bad := bad || format('D_trigger rows=%s md5=%s (期望 19 / 38695e309ed38faadc75976b33babbc7); ', v_n, v_m);
  else
    okdom := okdom + 1;
  end if;

  -- ── E_policy ──
  q := $q$select 'E_policy|' || p.tablename || '.' || p.policyname || '|'
       || replace(replace(
            p.cmd
            || ' permissive=' || p.permissive
            || ' roles=' || array_to_string(p.roles, ',')
            || ' using=' || coalesce(p.qual, '(none)')
            || ' check=' || coalesce(p.with_check, '(none)')
          , E'\r', '\\r'), E'\n', '\\n')
from pg_policies p
where p.schemaname = 'public'
order by 1$q$;
  execute 'select count(*), coalesce(md5(string_agg(line, E''
'' order by line)), ''(empty)'') from (' || q || ') t(line)'
    into v_n, v_m;
  if v_n <> 33 or v_m <> 'd06a9b7f90dd2697420ed043350a5d5f' then
    bad := bad || format('E_policy rows=%s md5=%s (期望 33 / d06a9b7f90dd2697420ed043350a5d5f); ', v_n, v_m);
  else
    okdom := okdom + 1;
  end if;

  -- ── E_rls_enabled ──
  q := $q$select 'E_rls_enabled|' || c.relname || '|'
       || c.relrowsecurity::text || ' forced=' || c.relforcerowsecurity::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and not exists (select 1 from pg_depend dep where dep.objid = c.oid and dep.deptype = 'e')
order by 1$q$;
  execute 'select count(*), coalesce(md5(string_agg(line, E''
'' order by line)), ''(empty)'') from (' || q || ') t(line)'
    into v_n, v_m;
  if v_n <> 54 or v_m <> '02f74bc9c984907645ec6ab432029bb4' then
    bad := bad || format('E_rls_enabled rows=%s md5=%s (期望 54 / 02f74bc9c984907645ec6ab432029bb4); ', v_n, v_m);
  else
    okdom := okdom + 1;
  end if;

  -- ── F_function ──
  q := $q$select 'F_function|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|'
       || 'lang=' || l.lanname
       || ' vol=' || p.provolatile::text
       || ' secdef=' || p.prosecdef::text
       || ' strict=' || p.proisstrict::text
       || ' cfg=' || coalesce(array_to_string(p.proconfig, ','), '(none)')
       || ' ret=' || replace(pg_get_function_result(p.oid), E'\n', ' ')
       || ' srcmd5=' || md5(replace(replace(p.prosrc, E'\r\n', E'\n'), E'\r', E'\n'))
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l  on l.oid = p.prolang
where n.nspname = 'public'
  and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')
order by 1$q$;
  execute 'select count(*), coalesce(md5(string_agg(line, E''
'' order by line)), ''(empty)'') from (' || q || ') t(line)'
    into v_n, v_m;
  if v_n <> 60 or v_m <> 'dd89f4e9027b7e2050ae2d91031dc21c' then
    bad := bad || format('F_function rows=%s md5=%s (期望 60 / dd89f4e9027b7e2050ae2d91031dc21c); ', v_n, v_m);
  else
    okdom := okdom + 1;
  end if;

  -- ── H_enum ──
  q := $q$with en as (
  select t.typname, e.enumlabel, e.enumsortorder
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  join pg_enum e      on e.enumtypid = t.oid
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
)
select 'H_enum|' || typname || '|' || string_agg(enumlabel, ',' order by enumsortorder)
from en group by typname order by 1$q$;
  execute 'select count(*), coalesce(md5(string_agg(line, E''
'' order by line)), ''(empty)'') from (' || q || ') t(line)'
    into v_n, v_m;
  if v_n <> 24 or v_m <> '681c5f7d761305047d22212cb8e242ed' then
    bad := bad || format('H_enum rows=%s md5=%s (期望 24 / 681c5f7d761305047d22212cb8e242ed); ', v_n, v_m);
  else
    okdom := okdom + 1;
  end if;

  if okdom <> 8 then
    bad := bad || format('指纹域仅 %s/8 匹配; ', okdom); end if;

  if bad <> '' then
    raise exception 'POST-0026 GATE FAIL: %', bad;
  end if;

  raise notice 'POST-0026 ALL PASS  ledger=0001..0026/26/e781ce12  tab=54 rls=54 norls=0 app=28 mig=4/rls0 pol=33 fn=60 open_exec=12  migration USAGE 全 false  identity 1/1/1  pc 9 未变  指纹 %/8 EXACT MATCH', okdom;
end
$gate$;

select 'POST-0026|OK' as result;
