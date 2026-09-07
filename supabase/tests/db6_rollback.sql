-- ============================================================================
-- db6_rollback.sql
-- RB-01 / DB-6 TASK 12 —— 把 course_catalog 还原到 DB-3 baseline（apply 之前）。
--
-- DB-6 **不新增、不删除** canonical 课程行，只填充 DB-3 新建的 4 个可空扩展列。
-- 因此回退就是把这 4 列置回 NULL —— Portal 自有列全程未被触碰，无需还原。
--
-- ⚠ 前提：这 4 列在 DB-3 建成时全部为 NULL（DB-6 报告 §1 已实测：
--   apply 前「已填扩展列的行数 = 0」）。若将来有 DB-6 之外的写入方，
--   本脚本会一并清空它们的写入 —— 届时须改为按 provenance 精确回退。
--
-- 用法：psql -v ON_ERROR_STOP=1 -f supabase/tests/db6_rollback.sql
-- ============================================================================

\set ON_ERROR_STOP on
begin;

-- 前置断言：只做「清空扩展列」，绝不允许在回退时丢课程。
do $$ declare n int; begin
  select count(*) into n from public.course_catalog;
  if n <> 67 then
    raise exception 'course_catalog 行数为 %，预期 67 —— 拒绝回退（库不在预期状态）', n;
  end if;
end $$;

update public.course_catalog set
  thumbnail_path        = null,
  thumbnail_image_id    = null,
  created_at            = null,
  created_by_provenance = null;

-- 后置断言：课程一门不少，扩展列已全部清空。
do $$ declare n int; f int; begin
  select count(*) into n from public.course_catalog;
  if n <> 67 then raise exception '回退后行数变为 % —— 回退动作删除了课程，已阻止', n; end if;

  select count(*) into f from public.course_catalog
   where thumbnail_path is not null or thumbnail_image_id is not null
      or created_at is not null or created_by_provenance is not null;
  if f <> 0 then raise exception '仍有 % 行残留扩展列数据', f; end if;
end $$;

commit;
\echo '=== DB-6 已回退：扩展列清空，67 门 canonical 课程与 Portal 自有列完全不变 ==='
