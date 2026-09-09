-- ══════════════════════════════════════════════════════════════════════
-- CANONICAL LEDGER DIGEST  —  supabase_migrations.schema_migrations
-- ══════════════════════════════════════════════════════════════════════
--
-- 由 Supervisor 于 2026-09-09 裁定为 canonical 算法（STAGING-1A7 §10.3）。
-- 存在的意义：让 ledger baseline 可以在任意时点被本地独立复算，
-- 不再依赖聊天消息里传递的一次性 digest 值。
--
-- 已知基线（amas-staging）：
--   0001-0010  row_count=10  779baa849645081d9f8ba68b18ec7224
--   0001-0021  row_count=21  ec46316fd12ce62d09b0290aece90684
--
-- statements 参与摘要，因此本 digest 能检出「既有行被 repair 覆盖」，
-- 而不只是版本号增减。
--
-- ★ 纯 SELECT。本文件不得包含任何写语句。
-- ══════════════════════════════════════════════════════════════════════

\set from '0001'
\set to   '0021'

select
  :'from' || '-' || :'to'                              as range,
  count(*)                                             as row_count,
  md5(string_agg(
        version || '|' ||
        coalesce(name, '') || '|' ||
        coalesce(md5(array_to_string(statements, E'\n')), ''),
        E'\n' order by version))                       as digest
from supabase_migrations.schema_migrations
where version between :'from' and :'to';
