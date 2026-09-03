-- ============================================================
-- 0016_course_catalog · PORTAL-2B 课程目录只读镜像
--
-- ★ 这是镜像，不是新的权威源。
--   67 门正式课程的权威源始终是 App 的 services/catalog.ts → OFFICIAL_CATALOG。
--   改课程（名称/分类/课时）只能改那里，然后重跑 scripts/gen-course-catalog.mjs
--   重新生成本迁移的播种段；一致性由 portal2b_catalog_consistency.mjs 三方钉住
--   （Supabase 镜像 ↔ App OFFICIAL_CATALOG ↔ 官网课程卡）。
--
-- 为什么要镜像：官网与 App 已各有一份课程清单，门户再 hard-code 第三份是明确禁止的
-- （同 program_catalog / D-2 的处理）。门户是静态站点，无法在运行时读取 App 后端。
--
-- 硬规则（PORTAL-2B 2B-2）：
--   * credits 一律 null —— 不显示 0、不合计、不生成学分进度、不推算
--   * 「列入目录」≠「学生已注册」≠「内容当前可学」，三者由不同字段表达：
--       在本表中     = 列入 67 门正式目录
--       availability = 内容是否开放（21 门 in_development）
--       是否已注册   = 当前系统没有任何数据源，本表刻意不表达（见学习数据审计 §4）
-- ============================================================

do $$ begin
  create type course_category as enum
    ('nt','ot','bible_basics','theology','practical','history','language');
exception when duplicate_object then null; end $$;

do $$ begin
  create type course_availability as enum ('available','in_development');
exception when duplicate_object then null; end $$;

create table if not exists public.course_catalog (
  code          text primary key,          -- 与 App OFFICIAL_CATALOG 的 id 一致（c_matthew…）
  title_zh      text not null,
  category      course_category not null,
  level         text,                      -- bth / mdiv / dmin，可空
  instructor    text,
  total_lessons integer not null default 0,
  availability  course_availability not null default 'in_development',
  credits       numeric,                   -- ★ 恒为 null，等正式学分表批准后才可填
  sort_order    integer not null default 0,
  updated_at    timestamptz not null default now()
);
comment on table public.course_catalog is
  '67 门正式课程的只读镜像。权威源是 App services/catalog.ts；credits 恒 null，不得推算。';
comment on column public.course_catalog.credits is
  '★ 未经 AMAS 正式学分表批准不得填写。前端遇 null 显示"不显示学分信息"，绝不显示 0。';
comment on column public.course_catalog.availability is
  'available = 已有可学内容；in_development = 已列入正式目录但线上内容尚未开放（不是候选课程）';

create index if not exists course_catalog_cat on public.course_catalog (category, sort_order);

-- 播种（由 scripts/gen-course-catalog.mjs 从 OFFICIAL_CATALOG 生成）
insert into public.course_catalog
  (code, title_zh, category, level, instructor, total_lessons, availability, sort_order)
values
  ('c_matthew', '马太福音', 'nt', 'mdiv', 'Dr. Kim Joy', 26, 'available', 10),
  ('c_dr_mark', '马可福音', 'nt', 'dmin', null, 2, 'available', 20),
  ('c_dr_luke', '路加福音', 'nt', 'dmin', null, 3, 'available', 30),
  ('c_john', '约翰福音', 'nt', 'mdiv', 'Dr. Kim Joy', 24, 'available', 40),
  ('c_acts', '使徒行传', 'nt', 'bth', 'Dr. Kim Joy', 29, 'available', 50),
  ('c_romans', '罗马书', 'nt', 'mdiv', null, 1, 'available', 60),
  ('c_1cor', '哥林多前书', 'nt', 'bth', 'Enos', 10, 'available', 70),
  ('c_2cor', '哥林多后书', 'nt', 'mdiv', null, 1, 'available', 80),
  ('c_dr_galatians', '加拉太书', 'nt', 'dmin', null, 1, 'available', 90),
  ('c_ephesians', '以弗所书', 'nt', 'mdiv', 'Dr. Kim Joy', 7, 'available', 100),
  ('c_dr_philippians', '腓立比书', 'nt', 'dmin', null, 2, 'available', 110),
  ('c_dr_colossians', '歌罗西书', 'nt', 'dmin', null, 1, 'available', 120),
  ('c_1thess', '帖撒罗尼迦前书', 'nt', null, null, 0, 'in_development', 130),
  ('c_2thess', '帖撒罗尼迦后书', 'nt', null, null, 0, 'in_development', 140),
  ('c_1tim', '提摩太前书', 'nt', 'dmin', null, 2, 'available', 150),
  ('c_2tim', '提摩太后书', 'nt', 'dmin', null, 1, 'available', 160),
  ('c_titus', '提多书', 'nt', 'dmin', null, 1, 'available', 170),
  ('c_dr_philemon', '腓利门书', 'nt', 'dmin', null, 1, 'available', 180),
  ('c_hebrews', '希伯来书', 'nt', 'dmin', 'Dr. Kim Joy', 15, 'available', 190),
  ('c_dr_james', '雅各书', 'nt', 'dmin', null, 1, 'available', 200),
  ('c_1pet', '彼得前书', 'nt', 'dmin', null, 1, 'available', 210),
  ('c_2pet', '彼得后书', 'nt', 'dmin', null, 1, 'available', 220),
  ('c_1john', '约翰一书', 'nt', 'dmin', null, 1, 'available', 230),
  ('c_2john', '约翰二书', 'nt', 'dmin', null, 1, 'available', 240),
  ('c_3john', '约翰三书', 'nt', 'dmin', null, 2, 'available', 250),
  ('c_dr_jude', '犹大书', 'nt', 'dmin', null, 2, 'available', 260),
  ('c_revelation', '启示录', 'nt', 'dmin', 'Dr. Kim Joy', 23, 'available', 270),
  ('c_dr_genesis', '创世记', 'ot', 'dmin', null, 1, 'available', 280),
  ('c_judges', '士师记', 'ot', null, null, 0, 'in_development', 290),
  ('c_bible_intro', '认识圣经（圣经综合概观）', 'bible_basics', 'bth', '王恩光教授', 12, 'available', 300),
  ('c_bible_geography', '圣经地理', 'bible_basics', null, null, 0, 'in_development', 310),
  ('c_dr_marking', '研经标记法', 'bible_basics', 'dmin', null, 1, 'available', 320),
  ('c_lay_systematic', '平信徒系统神学', 'theology', 'bth', null, 1, 'available', 330),
  ('c_evangelical_core', '福音派神学核心要义', 'theology', null, null, 0, 'in_development', 340),
  ('c_contextual', '处境化神学', 'theology', 'mdiv', null, 1, 'available', 350),
  ('c_christian_education', '基督教教育', 'theology', null, null, 0, 'in_development', 360),
  ('c_dr_reformed', '改革宗（加尔文主义）与福音派神学', 'theology', 'dmin', null, 1, 'available', 370),
  ('c_china_theology', '中国教会的神学根基', 'theology', null, null, 0, 'in_development', 380),
  ('c_ethics', '基督教伦理', 'theology', null, null, 0, 'in_development', 390),
  ('c_worldview', '世界观', 'theology', null, null, 0, 'in_development', 400),
  ('c_comparative_religion', '宗教比较', 'theology', null, null, 0, 'in_development', 410),
  ('c_islam', '伊斯兰教理解', 'theology', null, null, 0, 'in_development', 420),
  ('c_china_cults', '中国异端', 'theology', null, null, 0, 'in_development', 430),
  ('c_newbeliever', '新信徒事工', 'practical', null, null, 1, 'available', 440),
  ('c_newbeliever_material', '新信徒教材', 'practical', null, null, 1, 'available', 450),
  ('c_basics', '基督徒生活基础', 'practical', null, '李恩慈牧师', 8, 'available', 460),
  ('c_assurance', '确信生活', 'practical', null, null, 1, 'available', 470),
  ('c_disciple', '门徒训练', 'practical', null, '陈恩典牧师', 10, 'available', 480),
  ('c_prayer', '祷告与灵修生活', 'practical', null, '林恩光师母', 6, 'available', 490),
  ('c_worship_order', '礼拜学（礼拜顺序）', 'practical', 'bth', null, 1, 'available', 500),
  ('c_smallgroup', '小组运营', 'practical', 'bth', null, 1, 'available', 510),
  ('c_evangelism', '传道法', 'practical', 'bth', null, 1, 'available', 520),
  ('c_warfare', '属灵争战', 'practical', 'bth', null, 1, 'available', 530),
  ('c_healing_word', '神的话语医治', 'practical', 'mdiv', null, 3, 'available', 540),
  ('c_healing_inner', '内在医治', 'practical', 'mdiv', null, 2, 'available', 550),
  ('c_homiletics', '讲道学', 'practical', null, null, 0, 'in_development', 560),
  ('c_preaching_practicum', '讲道实习', 'practical', null, null, 0, 'in_development', 570),
  ('c_worship_studies', '敬拜学', 'practical', null, null, 0, 'in_development', 580),
  ('c_counseling', '协谈学（牧会相谈）', 'practical', 'mdiv', null, 1, 'available', 590),
  ('c_church_ops', '教会运营', 'practical', 'mdiv', null, 1, 'available', 600),
  ('c_sunday_school', '主日学教育', 'practical', null, null, 0, 'in_development', 610),
  ('c_israel_culture', '以色列文化', 'history', null, null, 0, 'in_development', 620),
  ('c_world_church_history', '世界教会史', 'history', null, null, 0, 'in_development', 630),
  ('c_china_church_history', '中国教会史', 'history', null, null, 0, 'in_development', 640),
  ('c_greek', '希腊语', 'language', 'mdiv', null, 9, 'available', 650),
  ('c_hebrew', '希伯来语', 'language', null, null, 0, 'in_development', 660),
  ('c_ai_ministry', '人工智能与教牧实践', 'language', null, null, 0, 'in_development', 670)

on conflict (code) do update set
  title_zh = excluded.title_zh, category = excluded.category, level = excluded.level,
  instructor = excluded.instructor, total_lessons = excluded.total_lessons,
  availability = excluded.availability, sort_order = excluded.sort_order,
  updated_at = now();
-- credits 刻意不在 upsert 列内：重新播种不会覆盖将来正式录入的学分。

-- 守卫：把"67 门固定"与"credits 必须为 null"写成数据库约束，而不是靠人记得
create or replace function public.course_catalog_guard()
returns trigger language plpgsql set search_path = '' as $$
declare n int;
begin
  if tg_op = 'DELETE' or tg_op = 'INSERT' then
    select count(*) into n from public.course_catalog;
    if tg_op = 'INSERT' and n > 67 then
      raise exception '正式课程固定 67 门，新增课程需先获批准并更新 OFFICIAL_CATALOG';
    end if;
  end if;
  if tg_op <> 'DELETE' and new.credits is not null then
    raise exception 'credits 未经正式学分表批准不得填写（当前必须为 null）';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists course_catalog_guard_t on public.course_catalog;
create trigger course_catalog_guard_t before insert or update or delete on public.course_catalog
  for each row execute function public.course_catalog_guard();

-- RLS：目录本身是公开信息（官网早已公开列出 67 门），任何人可读，客户端一律不可写
alter table public.course_catalog enable row level security;
drop policy if exists course_catalog_read on public.course_catalog;
create policy course_catalog_read on public.course_catalog for select to anon, authenticated using (true);
revoke insert, update, delete on public.course_catalog from anon, authenticated;
