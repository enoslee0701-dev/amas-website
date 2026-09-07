-- DB-6 course migration — 由 backend/scripts/db6-course-migration.mjs 生成，请勿手改。
-- 只更新 canonical course_catalog 中**已存在**行的 App 专属扩展列。
-- 不 INSERT、不 DELETE、不修改任何 Portal 既有列。重复执行结果相同（幂等）。

begin;

-- 前置断言：canonical 目录必须恰好 67 条，且每个待更新 code 都必须已存在。
do $$ declare n int; begin
  select count(*) into n from public.course_catalog;
  if n <> 67 then raise exception 'canonical course_catalog 行数为 %，预期 67 —— 拒绝执行', n; end if;
end $$;

update public.course_catalog set
  thumbnail_path        = '/images/stock/books.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552677 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_1cor';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_1john';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_1pet';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_1thess';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_1tim';

update public.course_catalog set
  thumbnail_path        = '/images/stock/books.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552746 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_2cor';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_2john';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_2pet';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_2thess';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_2tim';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_3john';

update public.course_catalog set
  thumbnail_path        = '/images/stock/bible-map.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552736 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_acts';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_ai_ministry';

update public.course_catalog set
  thumbnail_path        = '/images/stock/jesus-worship.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552755 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_assurance';

update public.course_catalog set
  thumbnail_path        = '/images/stock/christian-life.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552741 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_basics';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_bible_geography';

update public.course_catalog set
  thumbnail_path        = '/images/stock/bible-open.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552742 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_bible_intro';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_china_church_history';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_china_cults';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_china_theology';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_christian_education';

update public.course_catalog set
  thumbnail_path        = '/images/stock/church-congregation.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552754 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_church_ops';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_comparative_religion';

update public.course_catalog set
  thumbnail_path        = '/images/stock/asia-street.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552750 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_contextual';

update public.course_catalog set
  thumbnail_path        = '/images/stock/discipleship.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552750 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_counseling';

update public.course_catalog set
  thumbnail_path        = '/images/stock/discipleship.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552744 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_disciple';

update public.course_catalog set
  thumbnail_path        = '/images/stock/books.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699119467 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_colossians';

update public.course_catalog set
  thumbnail_path        = '/images/stock/library-books.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699118153 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_galatians';

update public.course_catalog set
  thumbnail_path        = '/images/stock/mountain.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699114215 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_genesis';

update public.course_catalog set
  thumbnail_path        = '/images/stock/practical.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699127341 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_james';

update public.course_catalog set
  thumbnail_path        = '/images/stock/armor.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699128653 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_jude';

update public.course_catalog set
  thumbnail_path        = '/images/stock/bible-light.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699116841 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_luke';

update public.course_catalog set
  thumbnail_path        = '/images/stock/bible-open.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699115528 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_mark';

update public.course_catalog set
  thumbnail_path        = '/images/stock/study.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699129966 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_marking';

update public.course_catalog set
  thumbnail_path        = '/images/stock/christian-life.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699122090 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_philemon';

update public.course_catalog set
  thumbnail_path        = '/images/stock/worship.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699120778 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_philippians';

update public.course_catalog set
  thumbnail_path        = '/images/stock/books.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699112883 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_dr_reformed';

update public.course_catalog set
  thumbnail_path        = '/images/stock/worship.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552738 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_ephesians';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_ethics';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_evangelical_core';

update public.course_catalog set
  thumbnail_path        = '/images/stock/preaching.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552748 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_evangelism';

update public.course_catalog set
  thumbnail_path        = '/images/stock/library-books.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786699131277 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_greek';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_healing_inner';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_healing_word';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_hebrew';

update public.course_catalog set
  thumbnail_path        = '/images/stock/library-books.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552737 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_hebrews';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_homiletics';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_islam';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_israel_culture';

update public.course_catalog set
  thumbnail_path        = '/images/stock/bible-light.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552732 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_john';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_judges';

update public.course_catalog set
  thumbnail_path        = '/images/stock/books.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552757 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_lay_systematic';

update public.course_catalog set
  thumbnail_path        = '/images/stock/mountain.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552734 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_matthew';

update public.course_catalog set
  thumbnail_path        = '/images/stock/baptism-water.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552754 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_newbeliever';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_newbeliever_material';

update public.course_catalog set
  thumbnail_path        = '/images/stock/prayer.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552745 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_prayer';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_preaching_practicum';

update public.course_catalog set
  thumbnail_path        = '/images/stock/dramatic-sky.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552739 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_revelation';

update public.course_catalog set
  thumbnail_path        = '/images/stock/bible-open.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552747 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_romans';

update public.course_catalog set
  thumbnail_path        = '/images/stock/campus-community.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552751 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_smallgroup';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_sunday_school';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_titus';

update public.course_catalog set
  thumbnail_path        = '/images/stock/armor.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552753 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_warfare';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_world_church_history';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_worldview';

update public.course_catalog set
  thumbnail_path        = '/images/stock/worship-hands.jpg',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1786673552756 / 1000.0),
  created_by_provenance = 'system'
where code = 'c_worship_order';

update public.course_catalog set
  thumbnail_path        = '',
  thumbnail_image_id    = null,
  created_at            = to_timestamp(1787898657811 / 1000.0),
  created_by_provenance = 'catalog-migration'
where code = 'c_worship_studies';

-- 后置断言：行数未变，且扩展列已按预期填充。
do $$ declare n int; f int; begin
  select count(*) into n from public.course_catalog;
  if n <> 67 then raise exception '执行后 canonical 行数变为 %，迁移引入了增删 —— 已回滚', n; end if;
  select count(*) into f from public.course_catalog where created_by_provenance is not null;
  if f <> 67 then raise exception '预期 % 行带 provenance，实际 %', 67, f; end if;
end $$;

commit;
