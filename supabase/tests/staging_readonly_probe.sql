-- ============================================================================
-- staging_readonly_probe.sql
-- STAGING-1A —— 远端 amas-staging 的**只读**事实探测包
--
-- ★ 全文件只有 SELECT。没有 INSERT / UPDATE / DELETE / DDL / migration /
--   db push / ledger repair。可安全在生产或 staging 上执行。
--
-- 用途：Supervisor 经已授权通道执行，产出的结果可与
--   `docs/operations/STAGING-1A-CANONICAL-EXPECTED-STATE.md` 直接对拍。
--
-- 已知前提（Supervisor 独立验证）：
--   remote ledger = 0001..0010
--   post-0010 对象确实存在  →  LEDGER DRIFT IS REAL
--   因此**不得** repair ledger / db push / apply 0023–0027。
--
-- 建议执行方式：整份跑一遍，把每节输出原样贴回。
-- ============================================================================


-- ══ P0. 身份与版本 ════════════════════════════════════════════════════════
select
  current_database()                as database,
  current_user                      as connected_as,
  version()                         as pg_version,
  (select setting from pg_settings where name='server_version') as server_version;


-- ══ P1. 迁移 ledger（精确有序）════════════════════════════════════════════
-- 期望：0001..0010，共 10 行。多一行少一行都要如实报出。
select version, name
from supabase_migrations.schema_migrations
order by version;

select count(*) as ledger_rows,
       min(version) as min_version,
       max(version) as max_version
from supabase_migrations.schema_migrations;


-- ══ P2. ★ 判别式：0003 是否真的生效 ══════════════════════════════════════
-- canonical 事实：
--   0002_identity.sql   的版本是  set search_path = public
--   0003_hardening.sql  的版本是  set search_path = ''      ← 加固版
-- 两者都在 ledger 内，因此远端**应当**是 0003 的版本。
-- 若 search_path 仍是 public，说明 0003 未真正落到这两个函数上。
select
  p.proname,
  p.prosecdef                                as security_definer,
  pg_get_function_identity_arguments(p.oid)  as args,
  p.proconfig                                as config_search_path,
  md5(pg_get_functiondef(p.oid))             as definition_md5
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('has_active_role','is_admin_any')
order by p.proname;


-- ══ P3. ★ drift 证据：仅存在于 0012 的对象 ═══════════════════════════════
-- 这两个函数只定义于 0012_student_core.sql，而 0012 不在 ledger 内。
-- 它们存在 = 带外执行的直接证据（Supervisor 已确认存在）。
select
  p.proname,
  p.prosecdef                                as security_definer,
  p.proconfig                                as config_search_path,
  md5(pg_get_functiondef(p.oid))             as definition_md5
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('student_guard','sync_alias_on_role_revoke')
order by p.proname;


-- ══ P4. 0011–0026 的对象存在性矩阵 ═══════════════════════════════════════
-- 逐个探测 canonical 期望对象是否存在。
-- present=false 且 ledger 未登记  → 该 migration 确实未执行
-- present=true  且 ledger 未登记  → 带外执行（drift）
with expected(migration, kind, objname) as (values
  -- 0012（已知带外执行，用于确认其**完整程度**）
  ('0012','table','application_hq_approvals'),
  ('0012','table','hq_approval_internal'),
  ('0012','table','student_number_registry'),
  ('0012','table','student_records'),
  ('0012','table','student_status_history'),
  ('0012','type','hq_approval_status'),
  ('0012','type','student_status'),
  ('0012','function','activate_student'),
  ('0012','function','append_only_guard'),
  ('0012','function','create_student_record'),
  ('0012','function','normalize_student_number'),
  -- 0011 / 0013 / 0014
  ('0011','function','review_application'),
  ('0013','function','consume_rpc_context'),
  ('0014','function','history_guard'),
  -- 0015 / 0016
  ('0015','table','student_number_void_requests'),
  ('0016','table','course_catalog'),
  ('0016','type','course_category'),
  ('0016','type','course_availability'),
  -- 0018 / 0020
  ('0018','table','irreversible_record_sources'),
  ('0020','table','recovery_flows'),
  -- 0023–0026（DB-3 的 App 表，期望全部不存在）
  ('0023','table','app_image_uploads'),
  ('0024','table','app_course_progress'),
  ('0024','table','app_christian_profile'),
  ('0025','table','app_rooms'),
  ('0026','table','app_posts')
)
select
  e.migration,
  e.kind,
  e.objname,
  case e.kind
    when 'table'    then (to_regclass('public.'||e.objname) is not null)
    when 'type'     then exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
                                  where n.nspname='public' and t.typname=e.objname)
    when 'function' then exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                                  where n.nspname='public' and p.proname=e.objname)
  end as present
from expected e
order by e.migration, e.kind, e.objname;


-- ══ P5. 全量对象计数（与 canonical 期望态对拍）═══════════════════════════
select 'tables'    as kind, count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r'
union all
select 'app_ tables', count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind='r' and c.relname like 'app\_%'
union all
select 'enums', count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace
  where n.nspname='public' and t.typtype='e'
union all
select 'functions', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'
union all
select 'security definer functions', count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef
union all
select 'rls policies', count(*) from pg_policies where schemaname='public'
union all
select 'triggers', count(*) from pg_trigger where not tgisinternal
union all
select 'foreign keys', count(*) from pg_constraint where contype='f';


-- ══ P6. SECURITY DEFINER 函数的 search_path 与授权（0027 的判断依据）═════
-- 0027 的核心风险是 is_admin_any 的 create or replace。
-- 必须先知道远端**实际定义**与**实际授权**，才能判断替换是升级还是降级。
select
  p.proname,
  p.prosecdef                               as security_definer,
  coalesce(array_to_string(p.proconfig,','),'(none)') as search_path_config,
  md5(pg_get_functiondef(p.oid))            as definition_md5,
  coalesce(array_to_string(p.proacl::text[],' '),'(default: PUBLIC EXECUTE)') as acl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname='public' and p.prosecdef
order by p.proname;


-- ══ P7. 引用 is_admin_any 的 RLS 策略（0027 影响面）═════════════════════
select schemaname, tablename, policyname, cmd,
       (qual is not null)      as has_using,
       (with_check is not null) as has_with_check
from pg_policies
where schemaname='public'
  and (coalesce(qual,'') like '%is_admin_any%' or coalesce(with_check,'') like '%is_admin_any%')
order by tablename, policyname;


-- ══ P8. 人口计数（只计数，不取任何个人数据）═════════════════════════════
select 'auth.users' as t, count(*) from auth.users
union all select 'profiles', count(*) from public.profiles
union all select 'user_roles', count(*) from public.user_roles;

-- 角色分布（不含任何标识信息）
select role::text, count(*) from public.user_roles group by 1 order by 1;

-- ★ 那一个账号是 fixture 还是真人：只看**结构性**线索，不取邮箱内容
select
  count(*)                                                     as total,
  count(*) filter (where email_confirmed_at is not null)       as confirmed,
  count(*) filter (where last_sign_in_at is not null)          as has_signed_in,
  min(created_at)                                              as earliest_created,
  max(created_at)                                              as latest_created
from auth.users;


-- ══ P9. 备份能力（只读探测，不创建备份）═══════════════════════════════════
select
  (select count(*) from pg_extension where extname='pg_cron')      as has_pg_cron,
  (select setting from pg_settings where name='wal_level')          as wal_level,
  (select setting from pg_settings where name='archive_mode')       as archive_mode;
