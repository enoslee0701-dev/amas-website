-- ============================================================================
-- 0026_app_community.sql
-- RB-01 / DB-3 —— 社群域与附属域。
--
-- 依赖 0023（枚举 / app_image_uploads）、0024（course_catalog 扩展）、0025（app_rooms）。
-- 只建 schema，不迁移任何一行业务数据（D-29）。
--
--   §1  动态（posts / likes / comments）—— R-10 tombstone
--   §2  好友关系
--   §3  图书馆
--   §4  录音
--   §5  推送令牌
--   §6  公告
--   §7  合作/事奉来件
--   §8  授权边界（fail-closed）
-- ============================================================================


-- ---------------------------------------------------------------------------
-- §1  动态
--
-- R-10：作者注销 → 内容保留、作者置空，**绝不赋予虚构所有者**。
-- 源表 posts.user_id / post_comments.user_id 都是 NOT NULL，
-- 这里放宽为可空 + SET NULL —— 这是 DB-1 §6 明确要求的 tombstone 形态。
--
-- user_name / user_avatar / user_role 是**发帖当时的作者快照**，
-- 刻意保留：它们让 tombstone 后的内容仍有可读的上下文，
-- 但它们不是身份，也不参与任何授权判断。
-- ---------------------------------------------------------------------------
create table if not exists public.app_posts (
  id               uuid primary key,
  user_id          uuid references public.profiles(id) on delete set null,
  user_name        text not null,
  user_avatar      text,
  user_role        text,
  content          text not null,
  -- DB-1 §8 #2：SQLite 用 TEXT 存 JSON；Postgres 用 jsonb。
  -- 注意 jsonb 会规范化 key 顺序，序列化文本不再逐字稳定（迁移校验须用语义哈希）。
  images_json      jsonb not null default '[]'::jsonb,
  category         text,
  shared_room_json jsonb,
  -- 关联课程指向 canonical 目录；课程条目被删则解除关联而非删帖。
  linked_course_id text references public.course_catalog(code) on delete set null,
  -- 源列名是 `timestamp`。它在 Postgres 里是类型名关键字，裸用会撞语法，
  -- 故显式改名为 posted_at（映射见 DB-3 报告 §8 的重命名清单）。
  posted_at        timestamptz not null,
  created_at       timestamptz not null,

  author_state text generated always as
    (case when user_id is null then 'deleted_account' else 'active' end) stored
);
comment on table public.app_posts is
  'App 动态。user_id 可空 + SET NULL 实现 R-10 tombstone：内容保留，作者置空。';
comment on column public.app_posts.user_name is
  '发帖当时的作者名快照。仅供 tombstone 后保留可读上下文，不是身份，不参与授权。';
comment on column public.app_posts.posted_at is
  '源列 posts.timestamp 重命名而来（`timestamp` 在 Postgres 中是类型名关键字）。';

-- 源索引 idx_posts_created_at ON posts(created_at DESC)。
create index if not exists idx_app_posts_created_at
  on public.app_posts (created_at desc);
create index if not exists idx_app_posts_user
  on public.app_posts (user_id);


create table if not exists public.app_post_likes (
  post_id uuid not null references public.app_posts(id) on delete cascade,
  -- 点赞是纯计数信号，无保留价值 → 用户注销直接删除。
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (post_id, user_id)
);
comment on table public.app_post_likes is
  '点赞（计数信号）。用户注销直接删除 —— 它不承载需要保留的内容。';

create index if not exists idx_app_post_likes_user
  on public.app_post_likes (user_id);


create table if not exists public.app_post_comments (
  id          uuid primary key,
  post_id     uuid not null references public.app_posts(id) on delete cascade,
  -- R-10：评论是对话的一部分，删掉会让上下文断裂 → 保留内容，置空作者。
  user_id     uuid references public.profiles(id) on delete set null,
  user_name   text not null,
  user_avatar text,
  user_role   text,
  content     text not null,
  created_at  timestamptz not null,

  author_state text generated always as
    (case when user_id is null then 'deleted_account' else 'active' end) stored
);
comment on table public.app_post_comments is
  'App 评论。user_id 可空 + SET NULL：评论是对话的一部分，删除会让上下文断裂（R-10）。';

-- 源索引 idx_post_comments_post ON post_comments(post_id, created_at)。
create index if not exists idx_app_post_comments_post
  on public.app_post_comments (post_id, created_at);
create index if not exists idx_app_post_comments_user
  on public.app_post_comments (user_id);


-- ---------------------------------------------------------------------------
-- §2  好友关系
--
-- 关系随人消失 → 双侧 CASCADE，不留 tombstone：
-- 「一段与已注销账号的好友关系」不是需要保留的内容。
-- ---------------------------------------------------------------------------
create table if not exists public.app_friend_requests (
  id           uuid primary key,
  from_user_id uuid not null references public.profiles(id) on delete cascade,
  to_user_id   uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null,
  unique (from_user_id, to_user_id),
  constraint app_friend_requests_not_self check (from_user_id <> to_user_id)
);
comment on table public.app_friend_requests is
  '好友请求。双侧 CASCADE：关系请求随人消失。源库无自我请求约束，此处补上。';

-- 源索引 idx_friend_requests_from 已被 UNIQUE(from,to) 的索引前缀覆盖，不重复创建。
-- 源索引 idx_friend_requests_to 无前缀可用，须独立创建。
create index if not exists idx_app_friend_requests_to
  on public.app_friend_requests (to_user_id);


create table if not exists public.app_friendships (
  user_a     uuid not null references public.profiles(id) on delete cascade,
  user_b     uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null,
  primary key (user_a, user_b),
  constraint app_friendships_not_self check (user_a <> user_b)
);
comment on table public.app_friendships is
  '好友关系。双侧 CASCADE。'
  ' 刻意不加 user_a < user_b 的规范序约束：源库未强制该不变式，'
  ' 加了会让不符合该序的历史行在迁移时整批失败。规范化属 DAL 改造（DB-12）范围。';

create index if not exists idx_app_friendships_user_b
  on public.app_friendships (user_b);


-- ---------------------------------------------------------------------------
-- §3  图书馆
-- ---------------------------------------------------------------------------
create table if not exists public.app_library_books (
  id             uuid primary key,
  title          text not null,
  author         text,
  category       text,
  cover_image_id uuid references public.app_image_uploads(id) on delete set null,
  cover_url      text,
  publisher      text,
  year           integer,
  description    text,
  added_at       timestamptz not null,
  -- 藏书是机构资源，录入者注销不应删书。
  added_by       uuid references public.profiles(id) on delete set null
);
comment on table public.app_library_books is
  'App 图书馆藏书。无 owner 语义：added_by 只是录入者，SET NULL 后藏书仍在。';

-- 源索引 idx_library_books_added_at ON library_books(added_at DESC)。
create index if not exists idx_app_library_books_added_at
  on public.app_library_books (added_at desc);
create index if not exists idx_app_library_books_cover
  on public.app_library_books (cover_image_id);


create table if not exists public.app_library_favorites (
  -- 个人书签：人走即删。
  user_id      uuid not null references public.profiles(id) on delete cascade,
  book_id      uuid not null references public.app_library_books(id) on delete cascade,
  favorited_at timestamptz not null,
  primary key (user_id, book_id)
);
comment on table public.app_library_favorites is
  '个人收藏书签。用户注销直接删除。';

create index if not exists idx_app_library_favorites_book
  on public.app_library_favorites (book_id);


-- ---------------------------------------------------------------------------
-- §4  录音
--
-- 录音可能是群体活动的产物（房间祷告会等），因此保留 + tombstone，
-- 而不是随上传者一起删除。
-- ---------------------------------------------------------------------------
create table if not exists public.app_recordings (
  id          uuid primary key,
  filename    text not null,
  mime        text not null,
  size_bytes  bigint not null check (size_bytes >= 0),
  duration_ms bigint not null default 0 check (duration_ms >= 0),
  room_id     text references public.app_rooms(id) on delete set null,
  user_id     uuid references public.profiles(id) on delete set null,
  uploaded_at timestamptz not null,

  author_state text generated always as
    (case when user_id is null then 'deleted_account' else 'active' end) stored
);
comment on table public.app_recordings is
  '录音。user_id SET NULL + tombstone：录音可能是群体活动产物，不随上传者消失。';

create index if not exists idx_app_recordings_room
  on public.app_recordings (room_id, uploaded_at desc);
create index if not exists idx_app_recordings_user
  on public.app_recordings (user_id);


-- ---------------------------------------------------------------------------
-- §5  推送令牌
-- ---------------------------------------------------------------------------
create table if not exists public.app_push_tokens (
  -- 设备令牌，人走即失效 → CASCADE。
  user_id       uuid not null references public.profiles(id) on delete cascade,
  token         text not null,
  platform      app_push_platform not null,
  registered_at timestamptz not null,
  primary key (user_id, token)
);
comment on table public.app_push_tokens is
  '推送令牌。用户注销直接删除 —— 令牌对已注销账号无意义且属敏感设备标识。';

-- 源索引 idx_push_tokens_user ON push_tokens(user_id) 与 PK 的前缀完全重复，
-- 不在 Postgres 侧重建（见 DB-3 报告 §12 的索引裁定）。


-- ---------------------------------------------------------------------------
-- §6  公告
-- ---------------------------------------------------------------------------
create table if not exists public.app_announcements (
  id           uuid primary key,
  title        text not null,
  content      text not null,
  type         app_announcement_type not null default 'normal',
  published_at timestamptz not null,
  -- 公告是机构发声，不随发布者消失。
  published_by uuid references public.profiles(id) on delete set null
);
comment on table public.app_announcements is
  'App 公告。published_by SET NULL：公告是机构发声，发布者注销后公告仍然成立。';

-- 源索引 idx_announcements_published_at ON announcements(published_at DESC)。
create index if not exists idx_app_announcements_published_at
  on public.app_announcements (published_at desc);


-- ---------------------------------------------------------------------------
-- §7  合作 / 事奉来件
--
-- ★ 刻意**不**并入 Portal 既有的 public.submissions：
--   Portal submissions 是官网收件箱（招生/咨询），
--   App cooperation_submissions 是同工合作与事奉申请，语义不同。
--   合并会让两条业务流的处理规则互相污染（DB-1 §5 #33）。
-- ---------------------------------------------------------------------------
create table if not exists public.app_cooperation_submissions (
  id           uuid primary key,
  name         text not null,
  email        text not null,
  organization text,
  message      text,
  type         text,
  received_at  timestamptz not null
);
comment on table public.app_cooperation_submissions is
  'App 同工合作 / 事奉申请来件。与 Portal public.submissions 语义不同，刻意不合并（DB-1 §5 #33）。';

-- 源索引 idx_cooperation_received_at ON cooperation_submissions(received_at DESC)。
create index if not exists idx_app_cooperation_received_at
  on public.app_cooperation_submissions (received_at desc);


-- ---------------------------------------------------------------------------
-- §8  授权边界（fail-closed）—— 理由见 0023 §5
--
-- 特别注意 app_cooperation_submissions：它含来件人的姓名与邮箱，
-- 任何对 anon/authenticated 的放行都是个人信息泄露，必须保持 fail-closed。
-- ---------------------------------------------------------------------------
alter table public.app_posts                   enable row level security;
alter table public.app_post_likes              enable row level security;
alter table public.app_post_comments           enable row level security;
alter table public.app_friend_requests         enable row level security;
alter table public.app_friendships             enable row level security;
alter table public.app_library_books           enable row level security;
alter table public.app_library_favorites       enable row level security;
alter table public.app_recordings              enable row level security;
alter table public.app_push_tokens             enable row level security;
alter table public.app_announcements           enable row level security;
alter table public.app_cooperation_submissions enable row level security;

revoke all on public.app_posts                   from anon, authenticated;
revoke all on public.app_post_likes              from anon, authenticated;
revoke all on public.app_post_comments           from anon, authenticated;
revoke all on public.app_friend_requests         from anon, authenticated;
revoke all on public.app_friendships             from anon, authenticated;
revoke all on public.app_library_books           from anon, authenticated;
revoke all on public.app_library_favorites       from anon, authenticated;
revoke all on public.app_recordings              from anon, authenticated;
revoke all on public.app_push_tokens             from anon, authenticated;
revoke all on public.app_announcements           from anon, authenticated;
revoke all on public.app_cooperation_submissions from anon, authenticated;
