-- ============================================================================
-- 0024_app_learning.sql
-- RB-01 / DB-3 —— 学习域：课程扩展、课程文件、学习进度、成长档案。
--
-- 依赖 0023（migration schema / 枚举 / app_image_uploads / profiles.bio）。
-- 只建 schema，不迁移任何一行业务数据（D-29）。
--
--   §1  course_catalog EXTEND（承接 App courses 的独有列）
--   §2  app_course_files
--   §3  app_course_progress        —— TYPE A 后端拥有（D-20）
--   §4  app_christian_profile      —— DB-1 §10，blob 逐字保持
--   §5  app_practice_training_state
--   §6  授权边界（fail-closed）
-- ============================================================================


-- ---------------------------------------------------------------------------
-- §1  course_catalog EXTEND
--
-- DB-1 §4 实测结论：App OFFICIAL_CATALOG 与 Portal course_catalog 已完全对齐
-- —— 67 vs 67，交集 67，双向差集为 0。因此**不建第二套课程目录**：
-- App courses 的独有列以扩展列并入既有 course_catalog。
--
-- 既有列（0016）已覆盖：code / title_zh / category / level / instructor /
--                        total_lessons / availability / credits / sort_order。
-- 本节新增的都是 course_catalog 尚不存在的列。
-- ---------------------------------------------------------------------------

-- App 端课程封面：实测 67/67 均为 App 内相对静态资源路径
-- （形如 /images/stock/books.jpg），既非 URL 也非 data URI。
alter table public.course_catalog
  add column if not exists thumbnail_path text;
comment on column public.course_catalog.thumbnail_path is
  'App 端课程封面的应用内相对资源路径（如 /images/stock/books.jpg）。承接 SQLite courses.thumbnail。';

-- 上传式封面。实测 67/67 全为 NULL —— 建列是为承接后续写入，不迁入任何伪造引用。
alter table public.course_catalog
  add column if not exists thumbnail_image_id uuid;
do $$ begin
  alter table public.course_catalog
    add constraint course_catalog_thumbnail_image_fk
    foreign key (thumbnail_image_id) references public.app_image_uploads(id) on delete set null;
exception when duplicate_object then null; end $$;

-- DB-1 §5 未列出但确实存在于源表的列：courses.created_at（67 行均有值）。
-- 不建此列会造成静默数据丢失，故补入（见 DB-3 报告 §3 对 DB-1 的修正）。
alter table public.course_catalog
  add column if not exists created_at timestamptz;
comment on column public.course_catalog.created_at is
  '目录条目创建时间。承接 SQLite courses.created_at（epoch ms → to_timestamp(v/1000.0)）。';

-- ★ D-28：courses.created_by 是**来源标记（provenance），不是身份**。
--   DB-2 实测：67/67 行的值全部是哨兵 —— 'system'(35) 与 'catalog-migration'(32)，
--   没有任何一行指向真实用户。因此它绝不可以变成 uuid FK：
--   那会迫使迁移去发明一个不存在的「system 用户」（违反 §7 与 R-7）。
alter table public.course_catalog
  add column if not exists created_by_provenance text;
comment on column public.course_catalog.created_by_provenance is
  'D-28：目录条目的来源标记（如 system / catalog-migration），非用户身份，刻意不设 FK。'
  ' 若将来出现真人创建的课程，须另加一列显式的 created_by uuid references profiles(id)。';


-- ---------------------------------------------------------------------------
-- §2  app_course_files
--
-- 源表 course_files 无 owner 列语义上的归属（uploader_id 实测 68/68 全 NULL），
-- 但列本身保留：它记录的是「谁传的」，将来会有真实值。
-- ---------------------------------------------------------------------------
create table if not exists public.app_course_files (
  id           uuid primary key,
  -- course_id(TEXT) → course_catalog(code)。课程被删则其附件一并删除。
  course_code  text not null references public.course_catalog(code) on delete cascade,
  filename     text not null,
  stored_name  text not null,
  mime         text not null,
  size_bytes   bigint not null check (size_bytes >= 0),
  -- R-10：上传者注销后文件记录保留（教学资料不属个人）。
  uploader_id  uuid references public.profiles(id) on delete set null,
  uploaded_at  timestamptz not null
);
comment on table public.app_course_files is
  'App 课程附件。course_code FK 到 canonical course_catalog —— 不产生第二套课程目录。';

-- 源索引 idx_course_files_course ON course_files(course_id, uploaded_at) 的等价物。
create index if not exists idx_app_course_files_course
  on public.app_course_files (course_code, uploaded_at);
-- 支撑 uploader_id FK 的反向查找（Postgres 不为 FK 自动建索引）。
create index if not exists idx_app_course_files_uploader
  on public.app_course_files (uploader_id);


-- ---------------------------------------------------------------------------
-- §3  app_course_progress   —— TYPE A：后端拥有（D-20）
--
-- 学习进度属个人；用户注销则进度随之消失（DB-1 §6：CASCADE）。
-- 迁移期**绝不允许孤儿**：owner 解析不出就停在人工复核，不得落库。
-- ---------------------------------------------------------------------------
create table if not exists public.app_course_progress (
  user_id           uuid not null references public.profiles(id) on delete cascade,
  course_code       text not null references public.course_catalog(code) on delete restrict,
  progress          integer not null default 0 check (progress between 0 and 100),
  completed_lessons integer not null default 0 check (completed_lessons >= 0),
  updated_at        timestamptz not null,
  primary key (user_id, course_code)
);
comment on table public.app_course_progress is
  'App 课程学习进度。TYPE A 后端拥有（D-20）。course_code 用 RESTRICT：目录条目不得在仍有进度时被删除。';

-- PK 的前缀已覆盖「按用户查」；反向「按课程查」需要独立索引。
create index if not exists idx_app_course_progress_course
  on public.app_course_progress (course_code);


-- ---------------------------------------------------------------------------
-- §4  app_christian_profile   —— DB-1 §10
--
-- D-19 / OPTION A：**保持现有持久化语义**。
-- 禁止 relationize / normalize / reconstruct / recompute /
-- rename internal scoring fields / 借迁移之机改算法。
--
-- state 是不透明 blob：数据库不解释它的内部结构，也不为它建任何内部字段索引。
-- 迁移正确性由 DB-1 §10.3 的三层 Gate 保证，不由 schema 保证。
-- ---------------------------------------------------------------------------
create table if not exists public.app_christian_profile (
  user_id                 uuid primary key references public.profiles(id) on delete cascade,
  state                   jsonb not null,
  updated_at              timestamptz not null,

  -- 迁移期溯源列，验收后保留为审计证据。
  -- source_raw_hash：迁移前 SQLite TEXT 原始字节的 SHA256。仅供溯源与争议仲裁，
  --   **不作为通过条件** —— jsonb 会规范化 key 顺序，用它判定必然误判（DB-1 §10.3）。
  source_raw_hash         text,
  -- canonical_semantic_hash：语义规范化（递归按 key 字典序、数组保序、无空白）后的 SHA256。
  --   验收判据是它在迁移前后相等：证明内容没变，而不是证明序列化格式没变。
  canonical_semantic_hash text
);
comment on table public.app_christian_profile is
  'Christian Profile 状态（承接 SQLite growth_state）。state 为不透明 blob，逐字保持（D-19 / OPTION A）。';
comment on column public.app_christian_profile.canonical_semantic_hash is
  'DB-1 §10.3 Layer 1 验收判据：迁移前后相等即内容未变。source_raw_hash 仅供溯源，不作判据。';


-- ---------------------------------------------------------------------------
-- §5  app_practice_training_state
--
-- 与 §4 同构：per-user JSON blob，同样不解释内部结构。
-- ---------------------------------------------------------------------------
create table if not exists public.app_practice_training_state (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  state      jsonb not null,
  updated_at timestamptz not null
);
comment on table public.app_practice_training_state is
  'App 实践训练状态（承接 SQLite pt_state）。per-user 不透明 blob。';


-- ---------------------------------------------------------------------------
-- §6  授权边界（fail-closed）—— 理由见 0023 §5
-- ---------------------------------------------------------------------------
alter table public.app_course_files            enable row level security;
alter table public.app_course_progress         enable row level security;
alter table public.app_christian_profile       enable row level security;
alter table public.app_practice_training_state enable row level security;

revoke all on public.app_course_files            from anon, authenticated;
revoke all on public.app_course_progress         from anon, authenticated;
revoke all on public.app_christian_profile       from anon, authenticated;
revoke all on public.app_practice_training_state from anon, authenticated;
