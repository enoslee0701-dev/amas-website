-- ============================================================================
-- r2_schema_fingerprint.sql  ·  v2（序列化修正版）
-- STAGING-1A · R2 —— CANONICAL DEFINITION EQUIVALENCE 指纹提取
--
-- ★ 全文件只有 SELECT。无 DDL / DML / migration / repair。
--
-- 用法（两侧用**完全相同**的这一个文件，输出可直接 diff / 逐域 digest）：
--   psql -X -q -f r2_schema_fingerprint.sql > side.txt
--
-- ── v2 修正的两个序列化缺陷（Supervisor drilldown 证实）──────────────────
--
--  【E】**一个数据库逻辑行必须等于一个物理输出行。**
--       v1 直接把可能含换行的表达式（policy USING / CHECK、CHECK 约束、
--       索引谓词、默认值、触发器定义）原样输出，导致含 embedded newline 的行
--       在物理文本层被截断。逐行 digest 工具按物理行切分，
--       只对第一段算了哈希 —— 于是 4 条 policy 报出**假差异**：
--         application_hq_approvals.hq_appr_select
--         application_requirements.areq_select
--         application_status_history.ash_select
--         student_status_history.ssh_select
--       Supervisor 已逐条证明 canonical digest == md5(remote payload 首个物理行)，
--       4/4 精确吻合 → E_POLICY DIFFERENCE = FINGERPRINT SERIALIZATION ARTIFACT。
--       **修正**：所有可能含 CR/LF 的字段一律先编码为字面 \r / \n 再输出。
--       见下方 `nl()` 的等价内联写法。**不得再用物理行 split 代表 database row。**
--
--  【F】**不得直接把 line-ending 敏感的 md5(pg_get_functiondef()) 当语义等价判据。**
--       v1 用它做 defmd5，而 canonical 本地库的 0008 系函数 prosrc 是 CRLF、
--       remote 是 LF，于是 4 个函数报出**假差异**：
--         application_validate_transition() · my_application()
--         my_application_timeline(uuid)     · resolve_requirement(uuid)
--       Supervisor 已证明：仅把 remote prosrc 的 LF 换成 CRLF（保持 PG 生成的
--       header 不变）即得到与 canonical 完全相同的 defmd5，4/4 EXACT MATCH
--       → F_FUNCTION DIFFERENCE = LINE-ENDING SERIALIZATION ARTIFACT。
--       **修正**：改为由**语义分量**组装指纹，并先把 prosrc 归一为 LF
--       （CRLF → LF，孤立 CR → LF），不再依赖 pg_get_functiondef 的原始字节。
--
-- ── 口径（写错会产生大量假阳性，均为实测结论）───────────────────────────
--   1. **只取 public schema**。Supabase 原生带 auth / storage / realtime；
--      本地垫片没有。实测：外键「全库」远端 61 / 本地 38，「仅 public」两侧都是 38。
--   2. **剔除扩展自带对象**（pg_depend deptype='e'）。本地垫片把 pgcrypto 装进
--      public（36 个函数），Supabase 装在 extensions。实测：不剔除 95 vs 59，
--      剔除后两侧都是 59。
--   3. 定义取 PostgreSQL 规范化输出（pg_get_*def），不取源文件文本。
--   4. 每行形如 `domain|key|fingerprint`，域内字典序，一行一逻辑对象。
--   5. **G 域是 PLATFORM-BASELINE-SENSITIVE，不得裸 diff**（见 G / G2 / G3 注释）。
-- ============================================================================

\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'
\pset footer off

-- ══ A. tables / columns（类型 · 可空性 · 默认值 · generated）═════════════
select 'A_column|' || c.relname || '.' || a.attname || '|'
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
order by 1;

-- ══ B. constraints（PK · UNIQUE · FK 含 ON DELETE/UPDATE · CHECK）═══════
select 'B_constraint|' || t.relname || '.' || con.conname || '|'
       || replace(replace(
            con.contype::text || ' ' || pg_get_constraintdef(con.oid)
          , E'\r', '\\r'), E'\n', '\\n')
from pg_constraint con
join pg_class t     on t.oid = con.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
order by 1;

-- ══ C. indexes（精确定义 · 谓词 · 唯一性）════════════════════════════════
select 'C_index|' || t.relname || '.' || i.relname || '|'
       || replace(replace(pg_get_indexdef(x.indexrelid), E'\r', '\\r'), E'\n', '\\n')
from pg_index x
join pg_class i     on i.oid = x.indexrelid
join pg_class t     on t.oid = x.indrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
order by 1;

-- ══ D. triggers（时机 · 事件 · 表 · 函数）════════════════════════════════
select 'D_trigger|' || t.relname || '.' || g.tgname || '|'
       || replace(replace(pg_get_triggerdef(g.oid), E'\r', '\\r'), E'\n', '\\n')
from pg_trigger g
join pg_class t     on t.oid = g.tgrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public' and not g.tgisinternal
  and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
order by 1;

-- ══ E. RLS policies（命令 · 角色 · USING · WITH CHECK）═══════════════════
-- ★ USING / WITH CHECK 常含换行 —— 必须编码，否则一个 policy 会被截成多行。
select 'E_policy|' || p.tablename || '.' || p.policyname || '|'
       || replace(replace(
            p.cmd
            || ' permissive=' || p.permissive
            || ' roles=' || array_to_string(p.roles, ',')
            || ' using=' || coalesce(p.qual, '(none)')
            || ' check=' || coalesce(p.with_check, '(none)')
          , E'\r', '\\r'), E'\n', '\\n')
from pg_policies p
where p.schemaname = 'public'
order by 1;

-- 表级 RLS 开关（policy 数为 0 时尤其重要）
select 'E_rls_enabled|' || c.relname || '|'
       || c.relrowsecurity::text || ' forced=' || c.relforcerowsecurity::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and not exists (select 1 from pg_depend dep where dep.objid = c.oid and dep.deptype = 'e')
order by 1;

-- ══ F. functions（语义分量指纹，line-ending 已归一）══════════════════════
-- ★ 不再用 md5(pg_get_functiondef())：它对 prosrc 的 CRLF/LF 敏感，
--   会把纯换行差异报成语义差异（v1 的 4 个假阳性即由此而来）。
--   改为：签名 + 返回类型 + 语言 + volatility + secdef + strict + search_path
--        + **归一为 LF 的 prosrc**。
select 'F_function|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|'
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
order by 1;

-- ══ G. privileges ════════════════════════════════════════════════════════
-- ⚠ G RAW ACL = PLATFORM-BASELINE-SENSITIVE —— **DO NOT RAW-DIFF**。
--   Supabase 对 public 新表默认授予 anon / authenticated；本地垫片没有这层默认。
--   迁移里的 `revoke ... from anon, authenticated` 在两侧作用于不同基线，
--   最终 ACL 必然不同。实测：远端 20 张表有 write-class ACL，本地 canonical 为 0。
--   **这是平台差异，不是 canonical drift。** 判据请用 G2 / G3。
with tg as (
  select c.relname as tbl,
         case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  where n.nspname = 'public' and c.relkind = 'r'
    and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated','service_role'))
    and not exists (select 1 from pg_depend dep where dep.objid = c.oid and dep.deptype = 'e')
)
select 'G_table_grant|' || tbl || '.' || grantee || '|'
       || string_agg(privilege_type, ',' order by privilege_type)
from tg group by tbl, grantee order by 1;

select 'G_func_grant|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ').'
       || g.grantee || '|' || g.privilege_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
cross join lateral (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
                           a.privilege_type) g
where n.nspname = 'public'
  and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated','service_role'))
  and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')
order by 1;

-- ══ G2_PRIVILEGE_SURFACE（只报告 surface，**不宣称必须为空**）════════════
-- v1 曾把「必须为空」当断言 —— 那只在本地 shim 上成立，
-- 在真实 Supabase ACL 基线上不成立。此处仅如实报告 ACL 面。
select 'G2_privilege_surface|' || c.relname || '.' || g.grantee || '|'
       || string_agg(distinct a.privilege_type, ',' order by a.privilege_type)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
cross join lateral (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee) g
where n.nspname = 'public' and c.relkind = 'r'
  and g.grantee in ('PUBLIC','anon','authenticated')
  and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
  and not exists (select 1 from pg_depend dep where dep.objid = c.oid and dep.deptype = 'e')
group by c.relname, g.grantee
order by 1;

-- 函数 EXECUTE 面（0027 的绝对判据）
select 'G2_func_exec_open|' || p.proname || '|' || string_agg(distinct g.grantee, ',' order by g.grantee)
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
cross join lateral (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee) g
where n.nspname = 'public' and a.privilege_type = 'EXECUTE'
  and g.grantee in ('PUBLIC','anon')
  and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')
group by p.proname
order by 1;

-- ══ G3_EFFECTIVE_WRITE_POLICY_SURFACE ═══════════════════════════════════
-- ★ `TABLE WRITE PRIVILEGE PRESENT` **不等于** `EFFECTIVE UNRESTRICTED WRITE`。
--   写权限是否真的不受限，取决于该表是否启用 RLS 以及写策略的形态。
--   这里把「表 + RLS 开关 + 写类策略」并列，供判读实际写入面。
select 'G3_write_policy|' || p.tablename || '.' || p.policyname || '|'
       || 'rls=' || c.relrowsecurity::text
       || ' cmd=' || p.cmd
       || ' roles=' || array_to_string(p.roles, ',')
       || ' using=' || replace(replace(coalesce(p.qual, '(none)'), E'\r', '\\r'), E'\n', '\\n')
       || ' check=' || replace(replace(coalesce(p.with_check, '(none)'), E'\r', '\\r'), E'\n', '\\n')
from pg_policies p
join pg_class c     on c.relname = p.tablename
join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
where p.schemaname = 'public' and p.cmd in ('INSERT','UPDATE','DELETE','ALL')
order by 1;

-- ★ 必须为空的不变式：有 anon/authenticated 写权限、却**未启用 RLS** 的表。
--   这才是真正的风险形态；单纯「有写 ACL」不是。
select 'G3_VIOLATION_write_acl_without_rls|' || c.relname || '|' || g.grantee
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
cross join lateral (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee) g
where n.nspname = 'public' and c.relkind = 'r'
  and g.grantee in ('PUBLIC','anon','authenticated')
  and a.privilege_type in ('INSERT','UPDATE','DELETE')
  and not c.relrowsecurity
  and not exists (select 1 from pg_depend dep where dep.objid = c.oid and dep.deptype = 'e')
group by c.relname, g.grantee
order by 1;

-- ══ H. enums（值域与顺序）════════════════════════════════════════════════
with en as (
  select t.typname, e.enumlabel, e.enumsortorder
  from pg_type t
  join pg_namespace n on n.oid = t.typnamespace
  join pg_enum e      on e.enumtypid = t.oid
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
)
select 'H_enum|' || typname || '|' || string_agg(enumlabel, ',' order by enumsortorder)
from en group by typname order by 1;
