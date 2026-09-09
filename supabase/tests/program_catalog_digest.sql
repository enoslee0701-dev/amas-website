-- ══════════════════════════════════════════════════════════════════════
-- PROGRAM_CATALOG ROW DIGEST  ·  STAGING-1A8
-- ══════════════════════════════════════════════════════════════════════
--
-- 用途：0022 执行前后的行级证据。列顺序取自 attnum，**全部 11 列**，
-- 不是只取 code / name_zh / name_en / is_open_for_application。
--
-- 两个指纹刻意分开：
--   digest_full      含 created_at / updated_at
--                    —— 用于证明「快照恢复是逐字段精确的」
--   digest_business  不含这两列
--                    —— 用于证明「业务语义未变」
--
-- 分开的原因：program_catalog 上有 BEFORE UPDATE FOR EACH ROW 触发器
-- program_catalog_set_updated_at → set_updated_at()，它无条件执行
-- new.updated_at = now()。因此**在触发器启用的前提下，updated_at
-- 不可能被快照还原成旧值**。把两者混进一个指纹会掩盖这个事实。
--
-- 字段分隔用 US (U+001F)，NULL 用 \N —— 避免 ''（空串）与 NULL 撞车，
-- 也避免任何业务文本（含 · 与 /）与分隔符撞车。
--
-- scope 取值：all / affected / unrelated
--   affected = 0022 两条 UPDATE 的 WHERE 并集，共 6 个 code
--
-- ★ 纯 SELECT。本文件不得包含任何写语句。
-- ══════════════════════════════════════════════════════════════════════

\if :{?scope}
\else
  \set scope 'all'
\endif

with rows_in_scope as (
  select * from public.program_catalog
   where :'scope' = 'all'
      or (:'scope' = 'affected'
          and code in ('laycert','pdip','pastor','preaching','missionary','dmin'))
      or (:'scope' = 'unrelated'
          and code not in ('laycert','pdip','pastor','preaching','missionary','dmin'))
),
lines as (
  select code,
         concat_ws(E'\x1f',
           code,
           name_zh,
           name_en,
           coalesce(short_label,      '\N'),
           category,
           sort_order::text,
           is_open_for_application::text,
           coalesce(intake_note_zh,   '\N'),
           coalesce(approved_at::text,'\N')
         ) as business_line,
         concat_ws(E'\x1f', created_at::text, updated_at::text) as ts_line
  from rows_in_scope
)
select
  :'scope'                                                     as scope,
  count(*)                                                     as row_count,
  md5(string_agg(business_line || E'\x1f' || ts_line,
                 E'\n' order by code))                         as digest_full,
  md5(string_agg(business_line, E'\n' order by code))           as digest_business
from lines;
