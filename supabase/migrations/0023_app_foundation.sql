-- ============================================================================
-- 0023_app_foundation.sql
-- RB-01 / DB-3 —— App（AMAS Seminary App）迁入 Supabase Postgres 的基础层。
--
-- 本 migration 只建 schema，不迁移任何一行业务数据（D-29）。
-- 数据迁移在 DB-4..DB-11 分阶段进行，每阶段独立验收与回退。
--
-- 归属：本仓库（amas-website/supabase/migrations）是 AMAS Supabase database 的
--       唯一 migration source of truth（D-27）。App repo 不得建立第二套 migrations。
--
-- 本文件包含：
--   §1  migration 工具 schema（crosswalk / admin manifest / row manifest / baseline）
--   §2  profiles 的 canonical 扩展（bio）—— GATE 0 结论：不建 app_user_profile_ext
--   §3  App 值域枚举（由 SQLite CHECK 约束与后端代码实测取值域推导）
--   §4  app_image_uploads（被 course_catalog / library 引用，须先建）
--   §5  授权边界（fail-closed）
-- ============================================================================


-- ---------------------------------------------------------------------------
-- §1  migration 工具 schema
--
-- 这些是**迁移工具表，不是业务表**。迁移验收后降级为只读审计记录，
-- 永不进入业务查询路径。客户端（anon / authenticated）完全不可见。
-- ---------------------------------------------------------------------------
create schema if not exists migration;
comment on schema migration is
  'RB-01 迁移工具 schema。仅迁移工具与运维可见；业务代码禁止读写。验收后为只读审计。';

revoke all on schema migration from public;
revoke usage on schema migration from anon, authenticated;


-- LEGACY_IDENTITY_CROSSWALK —— DB-1 §2.3。
-- 它是迁移工具，不是第二个身份系统：canonical identity 恒为 profiles.id。
create table if not exists migration.legacy_identity_crosswalk (
  legacy_sqlite_user_id  text primary key,
  supabase_auth_user_id  uuid,
  canonical_profile_id   uuid references public.profiles(id) on delete restrict,
  mapping_method         text not null
                         check (mapping_method in (
                           'provisioned_by_migration',
                           'explicit_operator_link',
                           'email_match_reviewed',
                           'email_match_unreviewed',
                           'unresolved')),
  mapping_confidence     text not null check (mapping_confidence in ('high','medium','low')),
  verified               boolean not null default false,
  verified_by            uuid references public.profiles(id) on delete set null,
  verified_at            timestamptz,
  evidence               jsonb not null default '{}'::jsonb,
  notes                  text,
  created_at             timestamptz not null default now(),

  -- ★ email-only 静默匹配是被明令禁止的自动放行路径（DB-1 §15）。
  --   它可以被记录，但绝不能带着 verified=true 存在——那等于绕过人工复核。
  constraint crosswalk_email_only_requires_review check (
    mapping_method <> 'email_match_unreviewed' or verified = false
  ),
  -- ★ 已解析 = 必须有 canonical_profile_id；否则它没有解析出任何东西。
  constraint crosswalk_resolved_shape check (
    (mapping_method = 'unresolved' and canonical_profile_id is null)
    or (mapping_method <> 'unresolved' and canonical_profile_id is not null)
  ),
  -- ★ verified 三元组同生同灭，杜绝「说验过但没人、没时间」的空壳记录。
  constraint crosswalk_verified_shape check (
    (verified = false and verified_by is null and verified_at is null)
    or (verified = true and verified_by is not null and verified_at is not null)
  )
);
comment on table migration.legacy_identity_crosswalk is
  'DB-1 §2.3 legacy SQLite user id → canonical profiles.id 的解析记录。迁移工具表，非业务身份系统。';
comment on column migration.legacy_identity_crosswalk.mapping_method is
  'email_match_unreviewed 为 low confidence，禁止自动放行，必须转人工复核（DB-1 §2.3）。';

-- 一个 Supabase 账号只能被一条 legacy 记录认领（身份碰撞防线之一）。
create unique index if not exists uq_crosswalk_supabase_user
  on migration.legacy_identity_crosswalk (supabase_auth_user_id)
  where supabase_auth_user_id is not null;
-- 反向：一个 canonical profile 也只能被一条 legacy 记录认领。
create unique index if not exists uq_crosswalk_canonical_profile
  on migration.legacy_identity_crosswalk (canonical_profile_id)
  where canonical_profile_id is not null;
create index if not exists idx_crosswalk_method
  on migration.legacy_identity_crosswalk (mapping_method, verified);


-- ADMIN_ROLE_MIGRATION_MANIFEST —— DB-1 §3.2。
-- 迁移工具**不提供**「默认目标角色」参数：不得猜测权限（D-18）。
create table if not exists migration.admin_role_migration_manifest (
  legacy_user_id     text primary key,
  canonical_user_id  uuid references public.profiles(id) on delete restrict,
  legacy_role        text not null,
  target_roles       text[] not null default '{}',
  mapping_basis      text,
  review_status      text not null
                     check (review_status in ('RESOLVED','NEEDS_MANUAL_REVIEW')),
  reviewed_by        uuid references public.profiles(id) on delete set null,
  reviewed_at        timestamptz,
  notes              text,

  -- ★ RESOLVED 必须留下裁定依据与裁定人，否则「已裁定」只是无证据的声明。
  constraint admin_manifest_resolved_requires_evidence check (
    review_status <> 'RESOLVED'
    or (mapping_basis is not null and reviewed_by is not null and reviewed_at is not null)
  ),
  -- ★ target_roles 只能取 Portal 既有 user_role 值域内的名字。
  --   用 text[] 而非 user_role[]，是为了让「尚未裁定」能表达为空数组；
  --   值域仍被钉死，防止写入不存在的角色名。
  constraint admin_manifest_target_roles_domain check (
    target_roles <@ array['applicant','student','teacher','mentor','registrar',
                          'finance','content_admin','academic_admin','super_admin']::text[]
  )
);
comment on table migration.admin_role_migration_manifest is
  'DB-1 §3.2 legacy admin 账号逐人角色裁定。任一行非 RESOLVED，角色迁移阶段即停止（D-18）。';
comment on column migration.admin_role_migration_manifest.target_roles is
  '空数组 = 尚未裁定。禁止任何全局默认映射：admin→content_admin 是降权，admin→super_admin 是提权。';


-- ROW_MANIFEST —— DB-1 §11。row-level accountability，不接受汇总式「N rows imported」。
create table if not exists migration.row_manifest (
  id                bigint generated always as identity primary key,
  batch             text not null,
  source_table      text not null,
  source_pk         text not null,
  target_table      text not null,
  target_pk         text,
  status            text not null
                    check (status in ('PENDING','MIGRATED','SKIPPED','FAILED','MANUAL_REVIEW')),
  transformation    text,
  identity_mapping  text,
  source_checksum   text,
  target_checksum   text,
  error             text,
  manual_review     boolean not null default false,
  reviewed_by       uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now()
);
comment on table migration.row_manifest is
  'DB-1 §11 逐行迁移账本。阶段结束时 PENDING 必须为 0；存在 FAILED / MANUAL_REVIEW 则该阶段不得标记完成。';

create index if not exists idx_row_manifest_table_status
  on migration.row_manifest (source_table, status);
create unique index if not exists uq_row_manifest_source
  on migration.row_manifest (batch, source_table, source_pk);


-- SCHEMA_BASELINE —— DB-3 TASK 18。
-- Postgres 没有 SQLite 的 PRAGMA 运行期探测（DB-1 §8 #11），
-- schema 形态改由版本化 migration + 本表的显式断言承担。
create table if not exists migration.schema_baseline (
  contract_version     text primary key,
  migration_files      text not null,
  source_sqlite_sha256 text,
  source_table_count   integer,
  applied_at           timestamptz not null default now(),
  notes                text
);
comment on table migration.schema_baseline is
  'DB-3 TASK 18 目标 schema 契约版本基线。记录本次 schema 对应的 SQLite 源基线，供 schema 漂移检测比对。';

insert into migration.schema_baseline
  (contract_version, migration_files, source_sqlite_sha256, source_table_count, notes)
values
  ('DB-3.0', '0023_app_foundation .. 0026_app_community',
   '0798526d34a24c75696a305d65eafe2e',
   32,
   'DB-2 只读审计基线（450560 bytes，32 业务表 / 285 行）。DB-3 只建 schema，未迁移任何业务数据。')
on conflict (contract_version) do nothing;


-- ---------------------------------------------------------------------------
-- §2  profiles canonical 扩展
--
-- GATE 0 结论：`app_user_profile_ext` = DO NOT CREATE。
--
-- SQLite users 10 列逐项归宿（完整证据见 DB-3 报告 GATE 0）：
--   id            → auth.users.id = profiles.id（经 crosswalk 解析）
--   email         → auth.users.email（canonical）+ profiles.email
--   name          → profiles.display_name
--   password_hash → DO NOT MIGRATE（AUTH-M7 已删除 legacy 认证；Supabase 持凭据）
--   salt          → DO NOT MIGRATE（同上）
--   role          → user_roles（经 §3.2 manifest 逐人裁定）
--   degree        → DO NOT MIGRATE（用户自填展示字段，实测 7/7 全 NULL；
--                   权威学籍是 student_records.program_code → program_catalog(code)）
--   avatar        → profiles.avatar_path（需归一为 storage path；实测 7/7 全 NULL）
--   bio           → profiles.bio（本节新增：通用档案属性，非 App 专属）
--   created_at    → profiles.created_at（epoch ms → to_timestamp(v/1000.0)）
--
-- 唯一无处安放的字段是 bio；它是通用个人简介，落在 profiles 的语义范围内，
-- 因此以一列扩展 canonical schema，而不是新建一张 App 专属扩展表。
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists bio text;

comment on column public.profiles.bio is
  '个人简介。承接 App SQLite users.bio。长度上限与 App 后端校验一致（≤500）。';

do $$ begin
  alter table public.profiles
    add constraint profiles_bio_length check (bio is null or char_length(bio) <= 500);
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------------
-- §3  App 值域枚举
--
-- 来源：SQLite CHECK(col IN (...)) 约束，以及无 CHECK 但由后端代码钉死取值的列。
-- DB-1 §8 #4：原生 enum 会让值域外的历史值**插入即失败**，
-- 因此每个枚举的值域都经过全表实测扫描确认无越界值。
-- ---------------------------------------------------------------------------
do $$ begin create type app_room_host_type as enum ('system','user');
exception when duplicate_object then null; end $$;

-- 实测：room_members.role 现有值仅 {'member'}；'moderator' 由
-- backend/scripts/room-moderator.ts 显式授予（见 backend/src/diagnostics/systemRooms.ts:40）。
do $$ begin create type app_room_member_role as enum ('member','moderator');
exception when duplicate_object then null; end $$;

do $$ begin create type app_room_event_type as enum
  ('session.changed','prayer.changed','theme.changed','moderation.changed');
exception when duplicate_object then null; end $$;

do $$ begin create type app_prayer_session_status as enum ('scheduled','active','ended');
exception when duplicate_object then null; end $$;

do $$ begin create type app_prayer_session_event_type as enum
  ('created','started','item_changed','facilitator_changed','ended');
exception when duplicate_object then null; end $$;

do $$ begin create type app_prayer_report_reason as enum
  ('privacy','harassment','spam','unsafe','other');
exception when duplicate_object then null; end $$;

do $$ begin create type app_prayer_report_status as enum ('open','reviewed','dismissed');
exception when duplicate_object then null; end $$;

do $$ begin create type app_push_platform as enum ('ios','android','web');
exception when duplicate_object then null; end $$;

do $$ begin create type app_announcement_type as enum ('important','normal');
exception when duplicate_object then null; end $$;


-- ---------------------------------------------------------------------------
-- §4  app_image_uploads
--
-- 先于 course_catalog 扩展与 app_library_books 建立，因为二者都引用它。
--
-- `app_` 前缀表示归属 App 业务域，**不代表第二个身份空间**：
-- 所有 owner 列一律 FK 到 profiles(id)。
-- ---------------------------------------------------------------------------
create table if not exists public.app_image_uploads (
  id           uuid primary key,
  filename     text not null,
  mime         text not null,
  size_bytes   bigint not null check (size_bytes >= 0),
  purpose      text,
  -- R-10：上传者注销后图片保留（可能被他人内容引用，删除会产生断链）。
  uploaded_by  uuid references public.profiles(id) on delete set null,
  uploaded_at  timestamptz not null
);
comment on table public.app_image_uploads is
  'App 图片上传记录。uploaded_by 可空并 SET NULL：图片可能被他人内容引用，作者注销不得断链（R-10 / DB-1 §6）。';

create index if not exists idx_app_image_uploads_uploader
  on public.app_image_uploads (uploaded_by, uploaded_at desc);


-- ---------------------------------------------------------------------------
-- §5  授权边界（fail-closed）
--
-- App 的访问路径是 Express 后端（服务端持特权连接），客户端不直连这些表。
-- 因此这里**启用 RLS 但不建任何放行 policy**：anon / authenticated 一律无权。
--
-- 这是刻意的 R-5 fail-closed。在 App 真正需要客户端直连之前，
-- 写任何「看起来对」的 policy 都属于 R-2 的「权限展示 ≠ 权限控制」。
-- 客户端直连所需的 policy 由后续 migration 在有明确需求时显式添加。
-- ---------------------------------------------------------------------------
alter table public.app_image_uploads enable row level security;
revoke all on public.app_image_uploads from anon, authenticated;
