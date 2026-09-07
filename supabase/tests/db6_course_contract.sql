-- ============================================================================
-- db6_course_contract.sql
-- RB-01 / DB-6 TASK 13 —— 课程迁移的契约测试。
--
-- 前提：目标库已应用 0001..0026，并已执行 DB-6 的 apply SQL
--       （backend/scripts/db6-course-migration.mjs --emit-sql 的产物）。
--
-- 运行：psql -v ON_ERROR_STOP=1 -f supabase/tests/db6_course_contract.sql
--
-- 写操作全部在事务内并于结尾 ROLLBACK；只读断言不产生任何副作用。
-- ============================================================================

\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.ck(cond boolean, label text) returns void
language plpgsql as $$
begin
  if cond is not true then raise exception 'ASSERTION FAILED: %', label; end if;
  raise notice '  PASS  %', label;
end $$;


-- ══ 1. Canonical catalog 完整性 ══════════════════════════════════════════
do $$
declare n int; d int;
begin
  select count(*) into n from public.course_catalog;
  perform pg_temp.ck(n = 67, 'canonical: course_catalog 恰为 67 条（实际 '||n||'）');

  select count(*) into d from (
    select code from public.course_catalog group by code having count(*) > 1) x;
  perform pg_temp.ck(d = 0, 'canonical: 无重复 code');

  perform pg_temp.ck(
    (select count(*) from public.course_catalog where code is null or code = '') = 0,
    'canonical: 无空 code');
end $$;

-- 不存在第二套课程目录（TASK 3）
do $$ begin
  perform pg_temp.ck(
    to_regclass('public.app_courses') is null
    and to_regclass('public.legacy_courses') is null
    and to_regclass('public.app_course_catalog') is null
    and to_regclass('public.courses') is null,
    '唯一 SoT: 不存在 app_courses / legacy_courses / app_course_catalog / courses');
end $$;

-- 重复 code 会被主键拒绝
do $$ declare ok boolean := false; begin
  begin
    insert into public.course_catalog (code, title_zh, category)
    values ('c_1cor', '重复', 'nt');
  exception when unique_violation then ok := true; end;
  perform pg_temp.ck(ok, 'canonical: 重复 code 被主键拒绝');
end $$;


-- ══ 2. created_by provenance（D-28 / TASK 4）══════════════════════════════
do $$
declare bad int;
begin
  perform pg_temp.ck(
    (select count(*) from public.course_catalog where created_by_provenance is null) = 0,
    'provenance: 67 条全部带来源标记');

  select count(*) into bad from public.course_catalog
   where created_by_provenance not in ('system','catalog-migration');
  perform pg_temp.ck(bad = 0, 'provenance: 取值仅为 system / catalog-migration');

  perform pg_temp.ck(
    (select count(*) from public.course_catalog where created_by_provenance = 'system') = 35
    and (select count(*) from public.course_catalog where created_by_provenance = 'catalog-migration') = 32,
    'provenance: 分布 35 system / 32 catalog-migration，与源库一致');
end $$;

-- ★ 最要紧的一条：provenance 绝不能变成身份。
do $$ begin
  perform pg_temp.ck(not exists(
    select 1 from pg_constraint c
    where c.conrelid = 'public.course_catalog'::regclass and c.contype = 'f'
      and c.conkey = array[(select attnum from pg_attribute
                             where attrelid = 'public.course_catalog'::regclass
                               and attname = 'created_by_provenance')]),
    'D-28: created_by_provenance 上没有任何外键（不是身份）');

  perform pg_temp.ck(
    (select data_type from information_schema.columns
      where table_schema='public' and table_name='course_catalog'
        and column_name='created_by_provenance') = 'text',
    'D-28: created_by_provenance 是 text，不是 uuid');

  -- 哨兵值没有被变成 profiles 行
  perform pg_temp.ck(
    (select count(*) from public.profiles
      where display_name in ('system','catalog-migration')
         or email in ('system','catalog-migration')) = 0,
    'D-28: 未为哨兵值制造任何假用户（R-7）');
end $$;


-- ══ 3. created_at 保真（TASK 5）══════════════════════════════════════════
do $$
declare n int;
begin
  select count(*) into n from public.course_catalog where created_at is null;
  perform pg_temp.ck(n = 0, 'created_at: 67 条全部非空，无静默丢失');

  perform pg_temp.ck(
    (select count(*) from public.course_catalog
      where created_at < timestamptz '2026-08-01' or created_at > timestamptz '2026-09-01') = 0,
    'created_at: 全部落在源数据的时间范围内（2026-08）');
end $$;

-- ★ 毫秒精度锚点：源库 67 条的毫秒位**全部非零**，
--   因此 epoch ms → timestamptz 一旦丢精度就是真实的数据损失。
--   这里用三个真实极值/中值逐毫秒比对。
do $$
declare rec record;
begin
  for rec in
    select * from (values
      ('c_1cor',            1786673552677::bigint),
      ('c_dr_marking',      1786699129966),
      ('c_worship_studies', 1787898657811)
    ) as t(code, expect_ms)
  loop
    perform pg_temp.ck(
      (select (extract(epoch from created_at) * 1000)::numeric::bigint
         from public.course_catalog where code = rec.code) = rec.expect_ms,
      'created_at: '||rec.code||' 毫秒级往返精确等于源值 '||rec.expect_ms);
  end loop;
end $$;

-- 时区解释：timestamptz 存的是绝对时刻，切换会话时区不得改变它。
do $$
declare a timestamptz; b timestamptz;
begin
  set local timezone = 'UTC';
  select created_at into a from public.course_catalog where code = 'c_1cor';
  set local timezone = 'Asia/Bangkok';
  select created_at into b from public.course_catalog where code = 'c_1cor';
  perform pg_temp.ck(a = b, 'created_at: 会话时区改变不影响所存的绝对时刻');
end $$;


-- ══ 4. 扩展列语义（TASK 6）═══════════════════════════════════════════════
do $$ begin
  -- 空串与 NULL 逐字保留，未被静默归一化
  perform pg_temp.ck(
    (select count(*) from public.course_catalog where thumbnail_path = '') = 32,
    'thumbnail_path: 32 条空串逐字保留（未被归一成 NULL）');
  perform pg_temp.ck(
    (select count(*) from public.course_catalog where thumbnail_path <> '') = 35,
    'thumbnail_path: 35 条应用内相对路径');
  perform pg_temp.ck(
    (select count(*) from public.course_catalog where thumbnail_path is null) = 0,
    'thumbnail_path: 无 NULL —— 与源库 67/67 非 NULL 一致');
  perform pg_temp.ck(
    (select count(*) from public.course_catalog
      where thumbnail_path like 'data:%' or thumbnail_path ~* '^https?:') = 0,
    'thumbnail_path: 无 data URI / 外部 URL 混入');

  -- 上传式封面：源库 67/67 全 NULL，不得凭空产生引用
  perform pg_temp.ck(
    (select count(*) from public.course_catalog where thumbnail_image_id is not null) = 0,
    'thumbnail_image_id: 全 NULL，未凭空制造图片引用');
end $$;

-- 扩展列都必须可空 —— 它们是 App 专属，Portal 自身的写入路径不提供它们。
do $$
declare bad text;
begin
  select string_agg(column_name, ', ') into bad
  from information_schema.columns
  where table_schema='public' and table_name='course_catalog'
    and column_name in ('thumbnail_path','thumbnail_image_id','created_at','created_by_provenance')
    and is_nullable = 'NO';
  perform pg_temp.ck(bad is null,
    coalesce('扩展列: 以下列被设为 NOT NULL，会破坏 Portal 写入 -> '||bad,
             '扩展列: 4 列全部可空，不改变 Portal 既有写入行为'));
end $$;


-- ══ 5. Portal 既有列未被破坏（TASK 6 / TASK 14）══════════════════════════
do $$ begin
  perform pg_temp.ck(
    (select count(*) from public.course_catalog where credits is not null) = 0,
    'Portal: credits 仍全为 null（等正式学分表批准，DB-6 未擅自填充）');

  perform pg_temp.ck(
    (select count(*) from public.course_catalog where title_zh is null or title_zh = '') = 0,
    'Portal: title_zh 全部有值');

  -- 7 大类分布与 0016 种子一致
  perform pg_temp.ck(
    (select count(distinct category) from public.course_catalog) = 7,
    'Portal: 课程仍为 7 大类');

  perform pg_temp.ck(
    (select count(*) from public.course_catalog where availability = 'in_development') = 21,
    'Portal: 21 门内容筹备中，与种子一致');
end $$;


-- ══ 6. Retired 课程处置（TASK 2 / TASK 10）════════════════════════════════
--
-- 4 个 retired id 不在 canonical 目录中，且**任何对它们的引用都会被拒绝**，
-- 而不是被静默重映射到某门名字相近的现役课程。
do $$
declare rec record;
begin
  for rec in select unnest(array['c_dr_pastoral','c_dr_peter','c_dr_johannine','c_healing']) as id
  loop
    perform pg_temp.ck(
      not exists(select 1 from public.course_catalog where code = rec.id),
      'retired: '||rec.id||' 不在 canonical 目录中');
  end loop;
end $$;

-- 固定装置：一个真实身份，用于测 course_progress 的引用行为
insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'db6@test.invalid');
insert into public.profiles (id, email, display_name) values
  ('55555555-5555-5555-5555-555555555555', 'db6@test.invalid', 'DB6');

-- ★ 对 retired 课程的学习进度**写不进去**，因此不可能被静默算作别的课。
do $$ declare ok boolean := false; begin
  begin
    insert into public.app_course_progress (user_id, course_code, progress, updated_at)
    values ('55555555-5555-5555-5555-555555555555', 'c_healing', 50, now());
  exception when foreign_key_violation then ok := true; end;
  perform pg_temp.ck(ok, 'retired: 指向 retired 课程的学习进度被 FK 拒绝，不会静默转成错误课程');
end $$;

-- 未知课程同样被拒
do $$ declare ok boolean := false; begin
  begin
    insert into public.app_course_progress (user_id, course_code, progress, updated_at)
    values ('55555555-5555-5555-5555-555555555555', 'c_not_a_real_course', 10, now());
  exception when foreign_key_violation then ok := true; end;
  perform pg_temp.ck(ok, '未知课程: 不存在的 course_code 被 FK 拒绝');
end $$;

-- 正常课程可以写入
do $$ begin
  insert into public.app_course_progress (user_id, course_code, progress, updated_at)
  values ('55555555-5555-5555-5555-555555555555', 'c_1cor', 30, now());
  perform pg_temp.ck(true, '正常课程: canonical code 的学习进度可正常写入');
end $$;

-- 课程附件同样只能指向 canonical
do $$ declare ok boolean := false; begin
  begin
    insert into public.app_course_files (id, course_code, filename, stored_name, mime, size_bytes, uploaded_at)
    values (gen_random_uuid(), 'c_dr_peter', 'x.pdf', 'x', 'application/pdf', 1, now());
  exception when foreign_key_violation then ok := true; end;
  perform pg_temp.ck(ok, 'retired: 课程附件也无法挂到 retired 课程上');
end $$;


-- ══ 7. 幂等性的结构前提（TASK 11）════════════════════════════════════════
--
-- apply 脚本只做绝对赋值的 UPDATE，不含 INSERT / DELETE。
-- 这里断言重复执行不可能改变行数：主键存在即无法重复插入（上面已验），
-- 且不存在任何会随执行次数变化的列（如自增计数器）。
do $$ begin
  perform pg_temp.ck(
    (select count(*) from information_schema.columns
      where table_schema='public' and table_name='course_catalog'
        and (column_default like 'nextval%' or is_identity = 'YES')) = 0,
    '幂等: course_catalog 无自增/identity 列，重复 apply 不会漂移');
end $$;


rollback;
\echo '=== DB-6 COURSE CONTRACT TESTS: 全部断言通过（已回滚，无残留数据）==='
