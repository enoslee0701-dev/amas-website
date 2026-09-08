-- ============================================================================
-- r2_schema_fingerprint.sql
-- STAGING-1A · R2 —— CANONICAL DEFINITION EQUIVALENCE 指纹提取
--
-- ★ 全文件只有 SELECT。无 DDL / DML / migration / repair。
--
-- 用法（两侧用**完全相同**的这一个文件，输出可直接 diff）：
--
--   canonical 侧（本地 PG 17.6，已应用 0001..0021）：
--     psql -X -A -t -f r2_schema_fingerprint.sql > canonical.txt
--   remote 侧（amas-staging，只读）：
--     psql -X -A -t -f r2_schema_fingerprint.sql > remote.txt
--   比对：
--     diff canonical.txt remote.txt
--
-- ── 口径（关键，写错会产生大量假阳性）───────────────────────────────────
--   1. **只取 public schema**。Supabase 原生带 auth / storage / realtime 等
--      schema，本地垫片没有；不设 schema 过滤会凭空多出几十条差异。
--      实测：外键「全库」远端 61 / 本地 38，但「仅 public」两侧都是 38。
--   2. **剔除扩展自带对象**（pg_depend deptype='e'）。本地垫片把 pgcrypto
--      装进 public（36 个函数），Supabase 装在 extensions schema。
--      实测：不剔除 95 vs 59，剔除后两侧都是 59。
--   3. 定义一律取 PostgreSQL 的规范化输出（pg_get_*def），不取源文件文本 ——
--      源文本的空白与注释差异会淹没真正的语义差异。
--   4. 每行形如  `domain|key|fingerprint`，全局有序，便于逐行 diff。
-- ============================================================================

\pset tuples_only on
\pset format unaligned
\pset fieldsep '|'
\pset footer off

-- ══ A. tables / columns（类型 · 可空性 · 默认值）═════════════════════════
select 'A_column|' || c.relname || '.' || a.attname || '|'
       || a.attnum || ' ' || format_type(a.atttypid, a.atttypmod)
       || ' null=' || (not a.attnotnull)::text
       || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '(none)')
       || ' generated=' || coalesce(nullif(a.attgenerated::text,''), '-')
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
       || con.contype::text || ' ' || pg_get_constraintdef(con.oid)
from pg_constraint con
join pg_class t     on t.oid = con.conrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
order by 1;

-- ══ C. indexes（精确定义 · 谓词 · 唯一性）════════════════════════════════
select 'C_index|' || t.relname || '.' || i.relname || '|' || pg_get_indexdef(x.indexrelid)
from pg_index x
join pg_class i     on i.oid = x.indexrelid
join pg_class t     on t.oid = x.indrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public'
  and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
order by 1;

-- ══ D. triggers（时机 · 事件 · 表 · 函数）════════════════════════════════
select 'D_trigger|' || t.relname || '.' || g.tgname || '|' || pg_get_triggerdef(g.oid)
from pg_trigger g
join pg_class t     on t.oid = g.tgrelid
join pg_namespace n on n.oid = t.relnamespace
where n.nspname = 'public' and not g.tgisinternal
  and not exists (select 1 from pg_depend dep where dep.objid = t.oid and dep.deptype = 'e')
order by 1;

-- ══ E. RLS policies（命令 · 角色 · USING · WITH CHECK）═══════════════════
select 'E_policy|' || p.tablename || '.' || p.policyname || '|'
       || p.cmd
       || ' permissive=' || p.permissive
       || ' roles=' || array_to_string(p.roles, ',')
       || ' using=' || coalesce(p.qual, '(none)')
       || ' check=' || coalesce(p.with_check, '(none)')
from pg_policies p
where p.schemaname = 'public'
order by 1;

-- 表级 RLS 开关（policy 数为 0 时尤其重要）
select 'E_rls_enabled|' || c.relname || '|' || c.relrowsecurity::text || ' forced=' || c.relforcerowsecurity::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
  and not exists (select 1 from pg_depend dep where dep.objid = c.oid and dep.deptype = 'e')
order by 1;

-- ══ F. functions（签名 · 语言 · volatility · SECDEF · search_path · 定义哈希）
select 'F_function|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|'
       || 'lang=' || l.lanname
       || ' vol=' || p.provolatile::text
       || ' secdef=' || p.prosecdef::text
       || ' strict=' || p.proisstrict::text
       || ' cfg=' || coalesce(array_to_string(p.proconfig, ','), '(none)')
       || ' defmd5=' || md5(pg_get_functiondef(p.oid))
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join pg_language l  on l.oid = p.prolang
where n.nspname = 'public'
  and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')
order by 1;

-- ══ G. privileges ════════════════════════════════════════════════════════
-- 表级授权（只看四个关注角色 + PUBLIC）
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

-- 函数 EXECUTE 授权（0027 的直接依据）
select 'G_func_grant|' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ').' || g.grantee || '|' || g.privilege_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a on true
join lateral (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
                     a.privilege_type) g on true
where n.nspname = 'public'
  and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated','service_role'))
  and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')
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

-- ══ G2. ★ 表级授权的**绝对属性**断言（不做 diff）══════════════════════════
--
-- ⚠ 为什么 G_table_grant 不能裸 diff：
--   Supabase 对 public schema 的新表默认授予 anon / authenticated 权限；
--   本地垫片没有这层默认。迁移里的 `revoke ... from anon, authenticated`
--   在两侧作用于**不同的基线**，因此最终 ACL 必然不同 ——
--   这是平台差异，不是 canonical drift。实测本地 canonical 侧
--   G_table_grant 仅 1 行、7 张表 relacl 为 NULL（owner-only）。
--
--   有意义的判据是**绝对属性**：不该有写权限的角色是否真的没有写权限。
--   下面每一行都是一个可独立判真伪的断言，两侧各自成立即可，无需相等。
select 'G2_writable_by_anon|' || c.relname || '|' || string_agg(distinct a.privilege_type, ',' order by a.privilege_type)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where n.nspname = 'public' and c.relkind = 'r'
  and (a.grantee = 0 or pg_get_userbyid(a.grantee) = 'anon')
  and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
  and not exists (select 1 from pg_depend dep where dep.objid = c.oid and dep.deptype = 'e')
group by c.relname
order by 1;

select 'G2_writable_by_authenticated|' || c.relname || '|' || string_agg(distinct a.privilege_type, ',' order by a.privilege_type)
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
where n.nspname = 'public' and c.relkind = 'r'
  and pg_get_userbyid(a.grantee) = 'authenticated'
  and a.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')
  and not exists (select 1 from pg_depend dep where dep.objid = c.oid and dep.deptype = 'e')
group by c.relname
order by 1;

-- 函数 EXECUTE 面（0027 的绝对判据：哪些函数仍对 PUBLIC/anon 开放）
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
