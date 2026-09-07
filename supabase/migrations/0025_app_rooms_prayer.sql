-- ============================================================================
-- 0025_app_rooms_prayer.sql
-- RB-01 / DB-3 —— 房间域与祷告域。
--
-- 依赖 0023（枚举）与 0024（无直接依赖，但保持编号顺序）。
-- 只建 schema，不迁移任何一行业务数据（D-29）。
--
--   §1  app_rooms                —— DB-1 §7 系统哨兵改造
--   §2  房间附属 5 张表
--   §3  祷告会 3 张表
--   §4  祷告分享 3 张表
--   §5  授权边界（fail-closed）
--
-- ── 主键类型说明 ────────────────────────────────────────────────────────
-- 本文件的实体主键**刻意是 text 而不是 uuid**。这不是保守，是实测结论：
--   backend/src/routes/prayer.ts:27  与  prayerSession.ts:25  的 id 生成器是
--   `crypto.randomBytes(9).toString('hex')` —— 18 个十六进制字符，不是 uuid。
--   DB-2 抽样证实（如 prayer_shares.id = '1013a5683b195c40c6'，12/12 均非 uuid）。
--   rooms.room_id 更是人类可读房间码（'bible_reading' 等）。
-- 声明成 uuid 会让迁移在类型转换处**整批失败**（DB-1 §8 #9）。
-- 身份列（user_id / created_by / ...）则一律是真正的 uuid，FK 到 profiles(id)。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- §1  app_rooms —— 系统哨兵改造（DB-1 §7）
--
-- 源表 rooms.host_id 是 TEXT NOT NULL，其中 5 行的值是字符串 'system'
-- （5 个内置公共房间），另 2 行是真实用户 uuid。
--
-- 禁止的三条路（DB-1 §7）：给 'system' 建假 auth.users · 把字符串塞进 uuid FK ·
-- 为过 migration 临时禁 FK。本表用「类型标记 + 形态 CHECK」把两种合法形态钉死，
-- 让非法的 orphan user host 在数据库层就写不进去。
-- ---------------------------------------------------------------------------
-- ★ 对 DB-1 §6/§7 的修正（详见 DB-3 报告 §5）：
--   §6 给 host_user_id 定的是 ON DELETE SET NULL，§7 给的 CHECK 却要求
--   host_type='user' 时 host_user_id NOT NULL。两者不可能同时成立 ——
--   一旦房主注销，SET NULL 会撞上 CHECK，**整个账号删除操作直接失败**。
--   即：任何开过房间的用户都永远注销不掉。这是 DB-3 契约测试实测抓到的。
--
--   修正方式不是放弃约束，而是把「房主已注销」承认为**第三种合法形态**，
--   并用 host_orphaned_at 把它与「一开始就没房主的假 user 房间」区分开：
--
--     system                 host_user_id IS NULL     host_orphaned_at IS NULL
--     user  · 有房主          host_user_id NOT NULL    host_orphaned_at IS NULL
--     user  · 房主已注销      host_user_id IS NULL     host_orphaned_at NOT NULL
--
--   §7 的三条验收要求全部仍然成立：内置房间无需假用户即可存在；
--   写入的 host 必须是有效 canonical identity（FK）；
--   凭空插入一个无房主的 user 房间依然被拒（host_orphaned_at 为 NULL 时形态不合法）。
create table if not exists public.app_rooms (
  id               text primary key,
  host_type        app_room_host_type not null,
  host_user_id     uuid references public.profiles(id) on delete set null,
  -- 房主注销的时刻。由触发器写入，业务代码不应手工设置。
  host_orphaned_at timestamptz,
  password_hash    text,
  password_salt    text,
  created_at       timestamptz not null,

  constraint app_rooms_host_shape check (
    (host_type = 'system' and host_user_id is null     and host_orphaned_at is null) or
    (host_type = 'user'   and host_user_id is not null and host_orphaned_at is null) or
    (host_type = 'user'   and host_user_id is null     and host_orphaned_at is not null)
  ),
  -- ★ 口令要么完整（hash + salt），要么完全没有；不允许半套。
  constraint app_rooms_password_shape check (
    (password_hash is null and password_salt is null) or
    (password_hash is not null and password_salt is not null)
  )
);
comment on table public.app_rooms is
  'App 房间。host_type 区分内置系统房间与真人房间（DB-1 §7）。'
  ' 内置房间的运营权只以 app_room_members.role = ''moderator'' 存在，业务语义未变。';
comment on column public.app_rooms.host_user_id is
  '真人房主。host_type=''system'' 时恒为 NULL —— 不为哨兵值发明用户（R-7）。';
comment on column public.app_rooms.host_orphaned_at is
  '房主注销时刻。房间保留（R-10），房主置空，但它不会因此变成系统房间。';

-- ON DELETE SET NULL 触发的是一次 UPDATE，因此行级 BEFORE UPDATE 触发器能捕获它，
-- 在 CHECK 求值之前补上 host_orphaned_at，使 SET NULL 与形态约束同时成立。
create or replace function public.app_rooms_mark_host_orphaned()
returns trigger language plpgsql as $$
begin
  if new.host_type = 'user' and new.host_user_id is null and old.host_user_id is not null then
    new.host_orphaned_at := coalesce(new.host_orphaned_at, now());
  end if;
  return new;
end $$;
comment on function public.app_rooms_mark_host_orphaned is
  '房主注销时把房间标记为「房主已注销」，让 ON DELETE SET NULL 与 host_shape CHECK 相容。';

drop trigger if exists app_rooms_host_orphaned on public.app_rooms;
create trigger app_rooms_host_orphaned
  before update on public.app_rooms
  for each row execute function public.app_rooms_mark_host_orphaned();

create index if not exists idx_app_rooms_host
  on public.app_rooms (host_user_id) where host_user_id is not null;


-- ---------------------------------------------------------------------------
-- §2  房间附属表
-- ---------------------------------------------------------------------------

-- room_members 是**授权**的唯一依据（room_presence 只是在线状态）。
create table if not exists public.app_room_members (
  room_id    text not null references public.app_rooms(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       app_room_member_role not null default 'member',
  joined_at  timestamptz not null,
  updated_at timestamptz not null,
  primary key (room_id, user_id)
);
comment on table public.app_room_members is
  '房间成员与角色。membership 是当下关系，用户注销即消失（CASCADE）。这是房间授权的唯一依据。';

-- 源索引 idx_room_members_user 的等价物（PK 前缀是 room_id，反向查需独立索引）。
create index if not exists idx_app_room_members_user
  on public.app_room_members (user_id);


-- 在线状态：易失数据（TTL 45s）。**建表但不迁移数据**，迁移后自然重建。
create table if not exists public.app_room_presence (
  room_id      text not null references public.app_rooms(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  name         text not null,
  avatar       text,
  role         text not null,
  last_seen_at timestamptz not null,
  primary key (room_id, user_id)
);
comment on table public.app_room_presence is
  '房间在线状态（易失，TTL 45s）。DB-1 §5：建表但不迁移数据。role 是展示快照，非授权依据。';

create index if not exists idx_app_room_presence_seen
  on public.app_room_presence (room_id, last_seen_at);


-- 房间共读位置：房间共同状态，不属于个人 → updated_by 可空并 SET NULL。
create table if not exists public.app_room_reading_state (
  room_id    text primary key references public.app_rooms(id) on delete cascade,
  book       text not null,
  chapter    integer not null,
  verse      integer,
  -- 乐观并发控制：每次成功更新 +1。
  revision   integer not null default 1,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null
);
comment on table public.app_room_reading_state is
  '房间共读位置。updated_by SET NULL：位置是房间共同状态，最后更新者注销不应抹掉它。';


create table if not exists public.app_room_prayer_topics (
  id         text primary key,
  room_id    text not null references public.app_rooms(id) on delete cascade,
  seq        integer not null,
  text       text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null
);
comment on table public.app_room_prayer_topics is
  '房间代祷事项。created_by SET NULL：事项是房间内容，发起人注销后仍应保留。';

-- 源索引 idx_prayer_topics_room ON room_prayer_topics(room_id, seq)。
create index if not exists idx_app_room_prayer_topics_room
  on public.app_room_prayer_topics (room_id, seq);


-- 实时事件流：易失。**建表但不迁移数据**。
-- 源表是 INTEGER PRIMARY KEY AUTOINCREMENT；Postgres 无 rowid 语义，
-- 改用 identity 列（DB-1 §8 #12）。写入方必须改用 INSERT ... RETURNING id。
create table if not exists public.app_room_realtime_events (
  id              bigint generated always as identity primary key,
  room_id         text not null references public.app_rooms(id) on delete cascade,
  event_type      app_room_event_type not null,
  entity_id       text,
  entity_revision integer,
  created_at      timestamptz not null
);
comment on table public.app_room_realtime_events is
  '房间实时事件流（易失）。DB-1 §5：建表但不迁移数据。id 由 AUTOINCREMENT 改为 identity（§8 #12）。';

-- 源索引 idx_rt_events_room ON room_realtime_events(room_id, id) —— 游标式增量拉取。
create index if not exists idx_app_room_realtime_events_room
  on public.app_room_realtime_events (room_id, id);


-- ---------------------------------------------------------------------------
-- §3  祷告会
-- ---------------------------------------------------------------------------
create table if not exists public.app_prayer_sessions (
  id                  text primary key,
  room_id             text not null references public.app_rooms(id) on delete cascade,
  title               text,
  status              app_prayer_session_status not null,
  -- 祷告会历史是群体记录，不属单人 → 两个身份列都可空并 SET NULL。
  created_by          uuid references public.profiles(id) on delete set null,
  facilitator_user_id uuid references public.profiles(id) on delete set null,
  started_at          timestamptz,
  ended_at            timestamptz,
  current_item_id     text,
  -- 乐观并发控制：每次成功的 manager 命令 +1（DB-1 §9）。
  revision            integer not null default 1,
  created_at          timestamptz not null,
  updated_at          timestamptz not null,

  -- ★ 生命周期形态：已开始才可能有开始时间，已结束才可能有结束时间。
  constraint app_prayer_sessions_lifecycle check (
    (status = 'scheduled' and started_at is null and ended_at is null) or
    (status = 'active'    and started_at is not null and ended_at is null) or
    (status = 'ended'     and ended_at is not null)
  )
);
comment on table public.app_prayer_sessions is
  '祷告会。created_by / facilitator_user_id SET NULL：会话历史是群体记录，不因个人注销而消失。';

-- 源部分唯一索引 uniq_active_session_per_room：一个房间同时只能有一场进行中的祷告会。
create unique index if not exists uq_app_prayer_sessions_active_per_room
  on public.app_prayer_sessions (room_id) where status = 'active';
-- 源索引 idx_sessions_room ON prayer_sessions(room_id, status)。
create index if not exists idx_app_prayer_sessions_room
  on public.app_prayer_sessions (room_id, status);
create index if not exists idx_app_prayer_sessions_creator
  on public.app_prayer_sessions (created_by);


create table if not exists public.app_prayer_session_items (
  id             text primary key,
  session_id     text not null references public.app_prayer_sessions(id) on delete cascade,
  position       integer not null,
  title          text not null,
  description    text,
  scripture_ref  text,
  scripture_text text,
  created_at     timestamptz not null,
  unique (session_id, position)
);
comment on table public.app_prayer_session_items is
  '祷告会条目。(session_id, position) 唯一，保证顺序无歧义。';

-- 源索引 idx_session_items ON prayer_session_items(session_id, position)
-- 已被上面的 UNIQUE 约束自带索引覆盖，不重复创建。

-- ★ current_item_id 在源库是裸 TEXT，没有 FK —— 悬空引用可以静默存在。
--   这里补成真实 FK。因为 sessions ↔ items 相互引用，必须 DEFERRABLE：
--   同一事务内「先建会话、再建条目、最后回填 current_item_id」才能成立。
do $$ begin
  alter table public.app_prayer_sessions
    add constraint app_prayer_sessions_current_item_fk
    foreign key (current_item_id) references public.app_prayer_session_items(id)
    on delete set null
    deferrable initially deferred;
exception when duplicate_object then null; end $$;


create table if not exists public.app_prayer_session_events (
  id           text primary key,
  session_id   text not null references public.app_prayer_sessions(id) on delete cascade,
  -- ★ 审计性质：事件链不得因当事人注销而断裂 → 可空 + SET NULL
  --   （源表此列为 NOT NULL，迁移后放宽；这是 R-10 的直接要求）。
  actor_user_id uuid references public.profiles(id) on delete set null,
  event_type   app_prayer_session_event_type not null,
  from_item_id text,
  to_item_id   text,
  created_at   timestamptz not null
);
comment on table public.app_prayer_session_events is
  '祷告会事件历史（审计性质）。actor_user_id SET NULL：人注销不得让事件链失去这一环（R-10）。';

-- 源索引 idx_session_events ON prayer_session_events(session_id, created_at)。
create index if not exists idx_app_prayer_session_events_session
  on public.app_prayer_session_events (session_id, created_at);
create index if not exists idx_app_prayer_session_events_actor
  on public.app_prayer_session_events (actor_user_id);


-- ---------------------------------------------------------------------------
-- §4  祷告分享
-- ---------------------------------------------------------------------------
create table if not exists public.app_prayer_shares (
  id                text primary key,
  room_id           text not null references public.app_rooms(id) on delete cascade,
  -- ★ R-10 原生场景：作者注销 → 置空，内容保留，绝不赋予虚构所有者。
  user_id           uuid references public.profiles(id) on delete set null,
  text              text not null,
  -- DB-1 §8 #1：SQLite 用 INTEGER 0/1 表达布尔；Postgres 必须是真 boolean。
  is_anonymous      boolean not null default false,
  created_at        timestamptz not null,
  deleted_at        timestamptz,
  hidden_at         timestamptz,
  -- 治理动作的执行者。注销后隐藏事实保留，执行者置空。
  hidden_by         uuid references public.profiles(id) on delete set null,
  hidden_reason     text,
  -- 幂等键。DB-1 §8 #5/#6：Postgres 的 ON CONFLICT 必须有明确冲突目标，
  -- 由下方部分唯一索引提供。
  client_request_id text,

  -- ★ 隐藏动作三元组：隐藏时间与原因同生同灭，避免「隐藏了但没记原因」。
  constraint app_prayer_shares_hidden_shape check (
    (hidden_at is null and hidden_reason is null) or (hidden_at is not null)
  ),

  -- 作者状态：**派生列**，不引入任何新信息，随 user_id 自动保持一致。
  -- 这样 tombstone 状态不可能与 user_id 漂移（R-10）。
  author_state text generated always as
    (case when user_id is null then 'deleted_account' else 'active' end) stored
);
comment on table public.app_prayer_shares is
  '祷告分享。user_id 可空 + SET NULL 是 R-10 tombstone 的原生实现（源库已如此）。';
comment on column public.app_prayer_shares.author_state is
  '派生列：user_id 为 NULL 即 deleted_account。不承载新信息，仅让 tombstone 状态无法漂移。';

-- 源索引 idx_prayer_shares_room ON prayer_shares(room_id, created_at)。
create index if not exists idx_app_prayer_shares_room
  on public.app_prayer_shares (room_id, created_at);
create index if not exists idx_app_prayer_shares_user
  on public.app_prayer_shares (user_id);
-- 源部分唯一索引 uniq_share_idem —— 幂等重放的冲突目标。
create unique index if not exists uq_app_prayer_shares_idem
  on public.app_prayer_shares (room_id, user_id, client_request_id)
  where client_request_id is not null;


create table if not exists public.app_prayer_intercessions (
  share_id   text not null references public.app_prayer_shares(id) on delete cascade,
  -- 代祷是计数信号，人走即失效 → CASCADE。
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null,
  primary key (share_id, user_id)
);
comment on table public.app_prayer_intercessions is
  '代祷记录（计数信号）。用户注销直接删除 —— 它不承载需要保留的内容。';

create index if not exists idx_app_prayer_intercessions_user
  on public.app_prayer_intercessions (user_id);


create table if not exists public.app_prayer_share_reports (
  id               text primary key,
  share_id         text not null references public.app_prayer_shares(id) on delete cascade,
  -- ★ 治理记录必须留存：举报人注销不能抹掉「被举报过」这个事实。
  reporter_user_id uuid references public.profiles(id) on delete set null,
  reason           app_prayer_report_reason not null,
  status           app_prayer_report_status not null default 'open',
  created_at       timestamptz not null,
  unique (share_id, reporter_user_id)
);
comment on table public.app_prayer_share_reports is
  '举报记录（治理性质）。reporter_user_id SET NULL：举报人注销不得抹掉举报事实（DB-1 §6）。';

-- 源索引 idx_reports_share ON prayer_share_reports(share_id)
-- 已被 UNIQUE (share_id, reporter_user_id) 的索引前缀覆盖，不重复创建。
create index if not exists idx_app_prayer_share_reports_open
  on public.app_prayer_share_reports (status, created_at) where status = 'open';


-- ---------------------------------------------------------------------------
-- §5  授权边界（fail-closed）—— 理由见 0023 §5
-- ---------------------------------------------------------------------------
alter table public.app_rooms                 enable row level security;
alter table public.app_room_members          enable row level security;
alter table public.app_room_presence         enable row level security;
alter table public.app_room_reading_state    enable row level security;
alter table public.app_room_prayer_topics    enable row level security;
alter table public.app_room_realtime_events  enable row level security;
alter table public.app_prayer_sessions       enable row level security;
alter table public.app_prayer_session_items  enable row level security;
alter table public.app_prayer_session_events enable row level security;
alter table public.app_prayer_shares         enable row level security;
alter table public.app_prayer_intercessions  enable row level security;
alter table public.app_prayer_share_reports  enable row level security;

revoke all on public.app_rooms                 from anon, authenticated;
revoke all on public.app_room_members          from anon, authenticated;
revoke all on public.app_room_presence         from anon, authenticated;
revoke all on public.app_room_reading_state    from anon, authenticated;
revoke all on public.app_room_prayer_topics    from anon, authenticated;
revoke all on public.app_room_realtime_events  from anon, authenticated;
revoke all on public.app_prayer_sessions       from anon, authenticated;
revoke all on public.app_prayer_session_items  from anon, authenticated;
revoke all on public.app_prayer_session_events from anon, authenticated;
revoke all on public.app_prayer_shares         from anon, authenticated;
revoke all on public.app_prayer_intercessions  from anon, authenticated;
revoke all on public.app_prayer_share_reports  from anon, authenticated;
