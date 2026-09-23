-- ============================================================
-- AMAS · 课程总表 V1.0 —— 学士培养方案落库（2026-09-23）
--
-- 依据：《AMAS 课程总表 V1.0_2026-09-23》，Enos 逐项口头确认，并确认这就是
--       0016_course_catalog.sql 的 guard 里所说的「正式学分表批准」。
--       在它之前 credits 一律为 null 是**制度性的**，不是技术遗留：
--       学院没批学分表，系统就不许填、页面就不许显示，也不准按课时推算。
--       本迁移是那道门第一次被正式打开，且只开给学士的 27 门。
--
-- 本迁移做四件事：
--   1. 放宽 course_catalog_guard()：上限 67 → 68；credits 从「一律禁写」改为
--      「只有学士（level='bth'）的课程可以有学分，其余层级仍必须为 null」
--   2. 三处合并：把被并掉那一侧的学生进度、讲义、社区关联先挪到存活的课上，再删除
--   3. 课程目录整体对齐到 App 权威源（services/catalog.ts）的 68 门，写入 credits
--   4. program_catalog 里 B.Th 的毕业学分 90 → 77
--
-- 合并映射（被并掉 → 存活）：
--   c_1thess, c_2thess  → c_thess               帖撒罗尼迦前后书
--   c_healing_word      → c_healing_inner       神话语的内在医治
--   c_china_theology    → c_china_church_history 中国教会史与信仰根基
--   存活方的选取原则：保留在 App 推荐系统里已被引用的那个 id，避免断链。
--
-- ⚠ 本文件写成时**没有对任何数据库执行过**，包括本地与 staging。全部 NOT_RUN。
--   由 Enos 亲自 apply；apply 前请先在非生产环境跑一遍并核对文末的自检输出。
--
-- 回退：见文件末尾的「回退方式」注释。合并是有损的（两门并一门），
--       回退能恢复目录结构，但无法把合并后的学习进度再拆回两门。
-- ============================================================

begin;

-- ── 1. 放宽闸门 ──────────────────────────────────────────────
-- 注意：这不是绕过闸门，是按批准更新闸门的规则。未经新的书面批准，
-- 非学士层级的 credits 仍然写不进去。
create or replace function public.course_catalog_guard()
returns trigger language plpgsql set search_path = '' as $$
declare n int;
begin
  if tg_op = 'DELETE' or tg_op = 'INSERT' then
    select count(*) into n from public.course_catalog;
    if tg_op = 'INSERT' and n > 68 then
      raise exception '正式课程固定 68 门（课程总表 V1.0），新增课程需先获批准并更新 OFFICIAL_CATALOG';
    end if;
  end if;
  if tg_op <> 'DELETE' and new.credits is not null and new.level is distinct from 'bth' then
    raise exception 'credits 目前只对学士（B.Th）课程开放 —— 其余层级的逐课学分尚未经正式学分表批准';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- 数据搬迁期间目录会短暂处于中间状态（先插新课再删旧课会超过 68），
-- 因此整段在事务内关掉触发器，搬完立刻打开，并在文末重新逐条自检。
alter table public.course_catalog disable trigger course_catalog_guard_t;

-- ── 2. 先建三门合并后的新课（其余新增课程一并建立）──────────
insert into public.course_catalog
  (code, title_zh, category, level, instructor, total_lessons, availability, credits, sort_order)
values
  ('c_gospels_intro', '四福音概论', 'nt', 'bth', null, 0, 'in_development', 4, 10),
  ('c_thess', '帖撒罗尼迦前后书', 'nt', 'bth', null, 0, 'in_development', 2, 140),
  ('c_ot_typology', '旧约救赎预表神学', 'theology', 'bth', null, 0, 'in_development', 3, 330),
  ('c_denominations', '基督教宗派与神学思想', 'theology', 'bth', null, 0, 'in_development', 2, 340),
  ('c_vision_mission', '异象与使命', 'practical', 'bth', null, 0, 'in_development', 2, 530)
on conflict (code) do nothing;

-- ── 3. 把被并掉那一侧的依赖数据挪到存活的课上 ────────────────
-- 顺序很重要：app_course_files 是 ON DELETE CASCADE（先删课会连讲义一起删掉），
-- app_course_progress 是 ON DELETE RESTRICT（不先挪走，删课会直接失败），
-- app_posts.linked_course_id 是 ON DELETE SET NULL（不先挪走，帖子会失去课程关联）。
create temporary table _merge_map(from_code text primary key, to_code text not null) on commit drop;
insert into _merge_map values
  ('c_1thess',        'c_thess'),
  ('c_2thess',        'c_thess'),
  ('c_healing_word',  'c_healing_inner'),
  ('c_china_theology','c_china_church_history');

-- 3a. 讲义：直接改挂。
update public.app_course_files f
   set course_code = m.to_code
  from _merge_map m
 where f.course_code = m.from_code;

-- 3b. 社区帖子的课程关联：直接改挂。
update public.app_posts p
   set linked_course_id = m.to_code
  from _merge_map m
 where p.linked_course_id = m.from_code;

-- 3c. 学习进度：同一个人可能在被合并的两门课上都有进度，
--     主键是 (user_id, course_code)，直接改挂会撞主键。
--     口径：取两边里更靠前的那个（progress 与 completed_lessons 各取较大值），
--     不倒退任何人的学习记录。
insert into public.app_course_progress (user_id, course_code, progress, completed_lessons, updated_at)
select p.user_id, m.to_code, max(p.progress), max(p.completed_lessons), max(p.updated_at)
  from public.app_course_progress p
  join _merge_map m on m.from_code = p.course_code
 group by p.user_id, m.to_code
    on conflict (user_id, course_code) do update
   set progress          = greatest(public.app_course_progress.progress, excluded.progress),
       completed_lessons = greatest(public.app_course_progress.completed_lessons, excluded.completed_lessons),
       updated_at        = greatest(public.app_course_progress.updated_at, excluded.updated_at);

delete from public.app_course_progress p
 using _merge_map m
 where p.course_code = m.from_code;

-- 3d. 依赖清空后才能删课。
delete from public.course_catalog c using _merge_map m where c.code = m.from_code;

-- ── 4. 目录整体对齐到 App 权威源的 68 门 ─────────────────────
-- 由 scripts/gen-course-catalog.mjs 从 services/catalog.ts 生成，勿手改；
-- 改课程请改权威源后重跑生成器。
insert into public.course_catalog
  (code, title_zh, category, level, instructor, total_lessons, availability, credits, sort_order)
values
  ('c_gospels_intro', '四福音概论', 'nt', 'bth', null, 0, 'in_development', 4, 10),
  ('c_matthew', '马太福音', 'nt', 'bth', 'Dr. Kim Joy', 26, 'available', 3, 20),
  ('c_dr_mark', '马可福音', 'nt', 'dmin', null, 2, 'available', null, 30),
  ('c_dr_luke', '路加福音', 'nt', 'dmin', null, 3, 'available', null, 40),
  ('c_john', '约翰福音', 'nt', 'mdiv', 'Dr. Kim Joy', 24, 'available', null, 50),
  ('c_acts', '使徒行传', 'nt', 'bth', 'Dr. Kim Joy', 29, 'available', 3, 60),
  ('c_romans', '罗马书', 'nt', 'bth', null, 1, 'available', 3, 70),
  ('c_1cor', '哥林多前书', 'nt', 'bth', 'Enos', 10, 'available', 3, 80),
  ('c_2cor', '哥林多后书', 'nt', 'mdiv', null, 1, 'available', null, 90),
  ('c_dr_galatians', '加拉太书', 'nt', 'dmin', null, 1, 'available', null, 100),
  ('c_ephesians', '以弗所书', 'nt', 'bth', 'Dr. Kim Joy', 7, 'available', 2, 110),
  ('c_dr_philippians', '腓立比书', 'nt', 'dmin', null, 2, 'available', null, 120),
  ('c_dr_colossians', '歌罗西书', 'nt', 'dmin', null, 1, 'available', null, 130),
  ('c_thess', '帖撒罗尼迦前后书', 'nt', 'bth', null, 0, 'in_development', 2, 140),
  ('c_1tim', '提摩太前书', 'nt', 'dmin', null, 2, 'available', null, 150),
  ('c_2tim', '提摩太后书', 'nt', 'dmin', null, 1, 'available', null, 160),
  ('c_titus', '提多书', 'nt', 'dmin', null, 1, 'available', null, 170),
  ('c_dr_philemon', '腓利门书', 'nt', 'dmin', null, 1, 'available', null, 180),
  ('c_hebrews', '希伯来书', 'nt', 'bth', 'Dr. Kim Joy', 15, 'available', 3, 190),
  ('c_dr_james', '雅各书', 'nt', 'bth', null, 1, 'available', 2, 200),
  ('c_1pet', '彼得前书', 'nt', 'dmin', null, 1, 'available', null, 210),
  ('c_2pet', '彼得后书', 'nt', 'dmin', null, 1, 'available', null, 220),
  ('c_1john', '约翰一书', 'nt', 'dmin', null, 1, 'available', null, 230),
  ('c_2john', '约翰二书', 'nt', 'dmin', null, 1, 'available', null, 240),
  ('c_3john', '约翰三书', 'nt', 'dmin', null, 2, 'available', null, 250),
  ('c_dr_jude', '犹大书', 'nt', 'dmin', null, 2, 'available', null, 260),
  ('c_revelation', '启示录', 'nt', 'dmin', 'Dr. Kim Joy', 23, 'available', null, 270),
  ('c_dr_genesis', '创世记', 'ot', 'bth', null, 1, 'available', 3, 280),
  ('c_judges', '士师记', 'ot', null, null, 0, 'in_development', null, 290),
  ('c_bible_intro', '圣经综合概观', 'bible_basics', 'bth', '王恩光教授', 12, 'available', 3, 300),
  ('c_bible_geography', '圣经地理', 'bible_basics', null, null, 0, 'in_development', null, 310),
  ('c_dr_marking', '研经标记法', 'bible_basics', 'dmin', null, 1, 'available', null, 320),
  ('c_ot_typology', '旧约救赎预表神学', 'theology', 'bth', null, 0, 'in_development', 3, 330),
  ('c_denominations', '基督教宗派与神学思想', 'theology', 'bth', null, 0, 'in_development', 2, 340),
  ('c_lay_systematic', '平信徒系统神学', 'theology', null, null, 1, 'available', null, 350),
  ('c_evangelical_core', '福音派神学核心要义', 'theology', null, null, 0, 'in_development', null, 360),
  ('c_contextual', '处境化神学', 'theology', 'mdiv', null, 1, 'available', null, 370),
  ('c_christian_education', '基督教教育', 'theology', null, null, 0, 'in_development', null, 380),
  ('c_dr_reformed', '改革宗（加尔文主义）与福音派神学', 'theology', 'dmin', null, 1, 'available', null, 390),
  ('c_ethics', '基督教伦理', 'theology', null, null, 0, 'in_development', null, 400),
  ('c_worldview', '世界观', 'theology', null, null, 0, 'in_development', null, 410),
  ('c_comparative_religion', '宗教比较', 'theology', null, null, 0, 'in_development', null, 420),
  ('c_islam', '伊斯兰教理解', 'theology', null, null, 0, 'in_development', null, 430),
  ('c_china_cults', '中国异端', 'theology', null, null, 0, 'in_development', null, 440),
  ('c_newbeliever', '新信徒事工', 'practical', 'bth', null, 1, 'available', 2, 450),
  ('c_newbeliever_material', '新信徒教材', 'practical', 'bth', null, 1, 'available', 2, 460),
  ('c_basics', '基督徒生活基础', 'practical', null, '李恩慈牧师', 8, 'available', null, 470),
  ('c_assurance', '确信生活', 'practical', 'bth', null, 1, 'available', 2, 480),
  ('c_disciple', '门徒生活', 'practical', 'bth', '陈恩典牧师', 10, 'available', 2, 490),
  ('c_prayer', '祷告与灵修生活', 'practical', 'bth', '林恩光师母', 6, 'available', 3, 500),
  ('c_worship_order', '礼拜学', 'practical', 'bth', null, 1, 'available', 2, 510),
  ('c_evangelism', '传道法', 'practical', 'bth', null, 1, 'available', 3, 520),
  ('c_vision_mission', '异象与使命', 'practical', 'bth', null, 0, 'in_development', 2, 530),
  ('c_smallgroup', '小组运营', 'practical', null, null, 1, 'available', null, 540),
  ('c_warfare', '属灵争战', 'practical', null, null, 1, 'available', null, 550),
  ('c_healing_inner', '神话语的内在医治', 'practical', 'bth', null, 5, 'available', 3, 560),
  ('c_homiletics', '讲道学', 'practical', 'bth', null, 0, 'in_development', 3, 570),
  ('c_preaching_practicum', '讲道实习', 'practical', null, null, 0, 'in_development', null, 580),
  ('c_worship_studies', '敬拜学', 'practical', null, null, 0, 'in_development', null, 590),
  ('c_counseling', '协谈学（牧会相谈）', 'practical', 'mdiv', null, 1, 'available', null, 600),
  ('c_church_ops', '教会运营', 'practical', 'mdiv', null, 1, 'available', null, 610),
  ('c_sunday_school', '主日学教育', 'practical', null, null, 0, 'in_development', null, 620),
  ('c_israel_culture', '以色列文化', 'history', 'bth', null, 0, 'in_development', 2, 630),
  ('c_world_church_history', '世界教会史', 'history', 'bth', null, 0, 'in_development', 3, 640),
  ('c_china_church_history', '中国教会史与信仰根基', 'history', 'bth', null, 0, 'in_development', 3, 650),
  ('c_greek', '希腊语', 'language', 'mdiv', null, 9, 'available', null, 660),
  ('c_hebrew', '希伯来语', 'language', null, null, 0, 'in_development', null, 670),
  ('c_ai_ministry', '人工智能与教牧实践', 'language', 'bth', null, 0, 'in_development', 2, 680)
on conflict (code) do update
   set title_zh      = excluded.title_zh,
       category      = excluded.category,
       level         = excluded.level,
       instructor    = excluded.instructor,
       total_lessons = excluded.total_lessons,
       availability  = excluded.availability,
       credits       = excluded.credits,
       sort_order    = excluded.sort_order,
       updated_at    = now();

alter table public.course_catalog enable trigger course_catalog_guard_t;

-- ── 5. B.Th 毕业学分 90 → 77 ────────────────────────────────
-- 77 = 课程 27 门 70 学分 + 实践训练 5 项 7 学分。
-- 实践训练从「11 项、不计毕业学分」改为「5 项、计入学分」也是 V1.0 的决定，
-- 对应的学生手册承诺段由前端仓库同批次修改（四个语言版本）。
update public.program_catalog
   set intake_note_zh = '2026 届招生 · 2026 年 9 月开学 · 77 学分',
       updated_at     = now()
 where code = 'bth';

-- ── 6. 自检：任一条不成立就整笔回滚 ─────────────────────────
do $$
declare n int; c int; s numeric; bad text;
begin
  select count(*) into n from public.course_catalog;
  if n <> 68 then raise exception '课程总数应为 68，实际 %', n; end if;

  select count(*), coalesce(sum(credits), 0) into c, s
    from public.course_catalog where credits is not null;
  if c <> 27 then raise exception '有学分的课程应为 27 门，实际 %', c; end if;
  if s <> 70 then raise exception '学士课程学分合计应为 70，实际 %', s; end if;

  select string_agg(code, ', ') into bad
    from public.course_catalog where credits is not null and level is distinct from 'bth';
  if bad is not null then raise exception '非学士课程不得有学分：%', bad; end if;

  select string_agg(code, ', ') into bad
    from public.course_catalog where level = 'bth' and credits is null;
  if bad is not null then raise exception '学士课程必须有学分：%', bad; end if;

  select string_agg(code, ', ') into bad from public.course_catalog
   where code in ('c_1thess', 'c_2thess', 'c_healing_word', 'c_china_theology');
  if bad is not null then raise exception '被合并的课程未删除：%', bad; end if;

  select count(*) into n from public.app_course_progress p
   where not exists (select 1 from public.course_catalog c where c.code = p.course_code);
  if n > 0 then raise exception '有 % 行学习进度指向不存在的课程', n; end if;

  select count(*) into n from public.course_catalog where level = 'bth';
  if n <> 27 then raise exception '学士课程应为 27 门，实际 %', n; end if;

  raise notice '自检通过：68 门课程，学士 27 门 70 学分，合并与依赖搬迁完成';
end $$;

commit;

-- ============================================================
-- 回退方式（需要新写一支迁移，不要直接改本文件）：
--   1. 把 course_catalog_guard() 换回 0016 的版本（上限 67、credits 一律禁写）
--   2. 删除 c_gospels_intro / c_thess / c_ot_typology / c_denominations / c_vision_mission
--      —— 删 c_thess 前要先把它的进度、讲义、帖子关联挪走或清掉
--   3. 重建 c_1thess / c_2thess / c_healing_word / c_china_theology 四条目录记录
--   4. 把三处改名与 level 改回：c_bible_intro「认识圣经（圣经综合概观）」、
--      c_worship_order「礼拜学（礼拜顺序）」、c_disciple「门徒训练」，
--      并把 credits 全部置 null
--   5. program_catalog 的 bth 改回 '… · 90 学分'
-- 注意：第 2 步无法还原「哪一部分进度原本属于帖前、哪一部分属于帖后」——
--       合并是有损的，这一点在 apply 前需要 Enos 知情同意。
-- ============================================================
