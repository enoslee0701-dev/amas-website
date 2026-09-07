-- ============================================================================
-- db3_schema_contract.sql
-- RB-01 / DB-3 TASK 15 —— 目标 schema 的契约测试。
--
-- 断言的是**行为**，不是「表建出来了」：
-- 一张建对了名字但 FK 生命周期错了的表，会静默毁掉数据，而 schema 快照看不出来。
--
-- 运行方式（在已应用 0001..0026 的库上）：
--     psql -v ON_ERROR_STOP=1 -f supabase/tests/db3_schema_contract.sql
--
-- 全程在一个事务内，结尾 ROLLBACK —— 不留下任何测试数据（R-7）。
-- 任一断言失败即抛异常，psql 以非零退出。
-- ============================================================================

\set ON_ERROR_STOP on
begin;

create or replace function pg_temp.ck(cond boolean, label text) returns void
language plpgsql as $$
begin
  if cond is not true then
    raise exception 'ASSERTION FAILED: %', label;
  end if;
  raise notice '  PASS  %', label;
end $$;


-- ── 固定装置：两个真实身份 ────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'db3a@test.invalid'),
  ('22222222-2222-2222-2222-222222222222', 'db3b@test.invalid');
insert into public.profiles (id, email, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'db3a@test.invalid', 'A'),
  ('22222222-2222-2222-2222-222222222222', 'db3b@test.invalid', 'B');


-- ══ 1. GATE 0 —— 不得存在 app_user_profile_ext；bio 落在 canonical profiles ══
do $$ begin
  perform pg_temp.ck(to_regclass('public.app_user_profile_ext') is null,
    'GATE 0: app_user_profile_ext 不存在（DO NOT CREATE）');
  perform pg_temp.ck(exists(select 1 from information_schema.columns
     where table_schema='public' and table_name='profiles' and column_name='bio'),
    'GATE 0: bio 落在 canonical profiles');
end $$;

-- bio 长度上限真实生效
do $$ declare ok boolean := false; begin
  begin
    update public.profiles set bio = repeat('x', 501)
     where id = '11111111-1111-1111-1111-111111111111';
  exception when check_violation then ok := true; end;
  perform pg_temp.ck(ok, 'profiles.bio 超过 500 字被拒');
end $$;


-- ══ 2. 身份模型 —— 不存在第二个 user id 空间 ══════════════════════════════
-- 所有承载「人」的列必须 FK 到 profiles(id)。
-- 这里按列名识别身份列（user/by/actor/host/reporter/facilitator/uploader），
-- 与实体间引用（post_id → app_posts 等）区分开。
do $$
declare bad text; n_checked int;
begin
  with identity_cols as (
    select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace ns on ns.oid = t.relnamespace
    join unnest(c.conkey) as k(attnum) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f'
      and ns.nspname in ('public','migration')
      and (t.relname like 'app\_%' or ns.nspname = 'migration')
      and a.atttypid = 'uuid'::regtype
      and (a.attname ~ '(^|_)user(_id)?$' or a.attname in ('user_a','user_b')
        or a.attname ~ '_by$' or a.attname ~ '^(uploader_id|canonical_profile_id|canonical_user_id)$')
  )
  select count(*), string_agg(tbl||'.'||col, ', ') filter
           (where confrelid <> 'public.profiles'::regclass)
    into n_checked, bad
  from identity_cols;

  perform pg_temp.ck(n_checked >= 25,
    '身份唯一性: 已覆盖 '||n_checked||' 个身份 FK（样本足够）');
  perform pg_temp.ck(bad is null,
    coalesce('身份唯一性: 存在指向 profiles 之外的身份 FK -> ' || bad,
             '身份唯一性: 全部身份 FK 都指向 profiles(id)，不存在第二个 user id 空间'));
end $$;


-- ══ 3. 系统哨兵（DB-1 §7）—— 5 个内置房间合法，非法 host 写不进去 ════════
insert into public.app_rooms (id, host_type, host_user_id, created_at)
values ('prayer_room', 'system', null, now());
do $$ begin
  perform pg_temp.ck(exists(select 1 from public.app_rooms
    where id='prayer_room' and host_type='system' and host_user_id is null),
    '哨兵: system 房间无需假用户即可合法存在');
end $$;

do $$ declare ok boolean := false; begin
  begin
    insert into public.app_rooms (id, host_type, host_user_id, created_at)
    values ('bad_sys', 'system', '11111111-1111-1111-1111-111111111111', now());
  exception when check_violation then ok := true; end;
  perform pg_temp.ck(ok, '哨兵: system 房间带真人 host 被 CHECK 拒绝');
end $$;

do $$ declare ok boolean := false; begin
  begin
    insert into public.app_rooms (id, host_type, host_user_id, created_at)
    values ('bad_user', 'user', null, now());
  exception when check_violation then ok := true; end;
  perform pg_temp.ck(ok, '哨兵: 凭空插入无房主的 user 房间被 CHECK 拒绝');
end $$;

-- 「房主已注销」是唯一合法的无房主 user 房间形态，且不得被伪造成系统房间。
do $$ declare ok boolean := false; begin
  begin
    insert into public.app_rooms (id, host_type, host_user_id, host_orphaned_at, created_at)
    values ('bad_sys2', 'system', null, now(), now());
  exception when check_violation then ok := true; end;
  perform pg_temp.ck(ok, '哨兵: 系统房间不得携带「房主已注销」标记');
end $$;

do $$ declare ok boolean := false; begin
  begin
    insert into public.app_rooms (id, host_type, host_user_id, created_at)
    values ('bad_orphan', 'user', '99999999-9999-9999-9999-999999999999', now());
  exception when foreign_key_violation then ok := true; end;
  perform pg_temp.ck(ok, '哨兵: 指向不存在 profile 的 host 被 FK 拒绝');
end $$;

-- ★ 最关键的一条：字符串哨兵不可能被塞进身份列。
do $$ declare ok boolean := false; begin
  begin
    insert into public.app_rooms (id, host_type, host_user_id, created_at)
    values ('bad_cast', 'user', 'system', now());
  exception when others then ok := true; end;
  perform pg_temp.ck(ok, '哨兵: 字符串 ''system'' 无法进入 uuid 身份列');
end $$;


-- ══ 4. FK 生命周期 —— CASCADE 与 SET NULL 逐条验证真实行为 ════════════════
insert into public.app_rooms (id, host_type, host_user_id, created_at)
values ('r_user', 'user', '11111111-1111-1111-1111-111111111111', now());

insert into public.app_room_members (room_id, user_id, role, joined_at, updated_at)
values ('r_user', '11111111-1111-1111-1111-111111111111', 'moderator', now(), now());

insert into public.app_prayer_shares (id, room_id, user_id, text, is_anonymous, created_at)
values ('share_keep', 'r_user', '11111111-1111-1111-1111-111111111111', '内容应当保留', false, now());

insert into public.app_prayer_intercessions (share_id, user_id, created_at)
values ('share_keep', '11111111-1111-1111-1111-111111111111', now());

insert into public.app_posts (id, user_id, user_name, content, posted_at, created_at)
values ('33333333-3333-3333-3333-333333333333',
        '11111111-1111-1111-1111-111111111111', '快照名', '帖子应当保留', now(), now());

insert into public.app_post_likes (post_id, user_id)
values ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222');

insert into public.app_christian_profile (user_id, state, updated_at)
values ('11111111-1111-1111-1111-111111111111', '{"v":1}'::jsonb, now());

-- 注销用户 A
delete from public.profiles where id = '11111111-1111-1111-1111-111111111111';

do $$ begin
  -- 保留 + 置空（R-10 tombstone）
  perform pg_temp.ck(exists(select 1 from public.app_prayer_shares
      where id='share_keep' and user_id is null),
    'R-10: 祷告分享内容保留、作者置空');
  perform pg_temp.ck((select author_state from public.app_prayer_shares where id='share_keep')
      = 'deleted_account',
    'R-10: 祷告分享 author_state 自动变为 deleted_account');
  perform pg_temp.ck(exists(select 1 from public.app_posts
      where id='33333333-3333-3333-3333-333333333333' and user_id is null
        and author_state='deleted_account' and user_name='快照名'),
    'R-10: 动态保留、作者置空、作者快照仍在');
  -- ★ 房主注销必须能够成功，且房间保留、不被误判为系统房间。
  perform pg_temp.ck(exists(select 1 from public.app_rooms
      where id='r_user' and host_type='user'
        and host_user_id is null and host_orphaned_at is not null),
    'R-10: 房主注销后房间保留，标记为「房主已注销」，且未变成系统房间');

  -- 直接删除（无保留价值）
  perform pg_temp.ck(not exists(select 1 from public.app_room_members
      where room_id='r_user'),
    'CASCADE: room membership 随人消失');
  perform pg_temp.ck(not exists(select 1 from public.app_prayer_intercessions
      where share_id='share_keep'),
    'CASCADE: 代祷计数信号随人删除');
  perform pg_temp.ck(not exists(select 1 from public.app_christian_profile),
    'CASCADE: 成长档案随人删除');

  -- 与被注销者无关的行不受影响
  perform pg_temp.ck(exists(select 1 from public.app_post_likes
      where user_id='22222222-2222-2222-2222-222222222222'),
    '他人的点赞不受影响');
end $$;

-- 注销之后，库里不得留下任何违反三形态约束的房间行。
do $$
declare n int;
begin
  select count(*) into n from public.app_rooms
   where not ((host_type='system' and host_user_id is null     and host_orphaned_at is null)
           or (host_type='user'   and host_user_id is not null and host_orphaned_at is null)
           or (host_type='user'   and host_user_id is null     and host_orphaned_at is not null));
  perform pg_temp.ck(n = 0, 'app_rooms 不存在违反 host_shape 的行');
end $$;


-- ══ 5. 类型契约（DB-1 §8）══════════════════════════════════════════════════
do $$ begin
  perform pg_temp.ck((select data_type from information_schema.columns
     where table_schema='public' and table_name='app_prayer_shares'
       and column_name='is_anonymous') = 'boolean',
    '类型 #1: 0/1 布尔已转为真 boolean');
  perform pg_temp.ck((select data_type from information_schema.columns
     where table_schema='public' and table_name='app_christian_profile'
       and column_name='state') = 'jsonb',
    '类型 #2: JSON blob 存为 jsonb');
  perform pg_temp.ck((select data_type from information_schema.columns
     where table_schema='public' and table_name='app_posts'
       and column_name='created_at') = 'timestamp with time zone',
    '类型 #3: epoch ms 目标列是 timestamptz');
end $$;

-- 枚举把值域外的值挡在数据库层
do $$ declare ok boolean := false; begin
  begin
    insert into public.app_push_tokens (user_id, token, platform, registered_at)
    values ('22222222-2222-2222-2222-222222222222', 't', 'symbian', now());
  exception when others then ok := true; end;
  perform pg_temp.ck(ok, '类型 #4: 枚举拒绝值域外的值');
end $$;

-- 主键类型必须与真实 id 生成器一致，否则迁移在转换处整批失败
do $$ begin
  perform pg_temp.ck((select data_type from information_schema.columns
     where table_schema='public' and table_name='app_prayer_shares' and column_name='id') = 'text',
    '类型 #9: 非 uuid 的 18 位 hex 主键声明为 text');
  perform pg_temp.ck((select data_type from information_schema.columns
     where table_schema='public' and table_name='app_posts' and column_name='id') = 'uuid',
    '类型 #9: randomUUID 生成的主键声明为 uuid');
  -- 反证：真实的 prayer_shares.id 形态确实不是合法 uuid
  perform pg_temp.ck(
    (select count(*) from (values ('1013a5683b195c40c6')) v(x)
      where x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') = 0,
    '类型 #9: 实测 id 样本确非 uuid（若声明为 uuid 将整批转换失败）');
end $$;

-- identity 列取代 AUTOINCREMENT
do $$ declare a bigint; b bigint; begin
  insert into public.app_room_realtime_events (room_id, event_type, created_at)
    values ('prayer_room','session.changed',now()) returning id into a;
  insert into public.app_room_realtime_events (room_id, event_type, created_at)
    values ('prayer_room','prayer.changed',now()) returning id into b;
  perform pg_temp.ck(b > a, '类型 #12: identity 列递增且可经 RETURNING 取回');
end $$;


-- ══ 6. 幂等（DB-1 §8 #5/#6）—— ON CONFLICT 必须有真实的冲突目标 ═══════════
insert into public.app_rooms (id, host_type, created_at) values ('r_idem','system',now());
insert into public.app_prayer_shares (id, room_id, user_id, text, created_at, client_request_id)
values ('idem_1','r_idem','22222222-2222-2222-2222-222222222222','原文',now(),'req-A');

-- ★ DB-1 §8 #6 的陷阱，在此固化为测试：
--   部分唯一索引若不带 WHERE 谓词，**不能**作为 ON CONFLICT 的冲突目标。
--   SQLite 的「任意约束冲突即忽略」范围更宽，直译过去会在运行时抛错而不是去重。
--   DB-12 的 DAL 改造必须写出完整谓词，否则每一次幂等重放都会变成 500。
do $$ declare ok boolean := false; begin
  begin
    insert into public.app_prayer_shares (id, room_id, user_id, text, created_at, client_request_id)
    values ('idem_x','r_idem','22222222-2222-2222-2222-222222222222','重放',now(),'req-A')
    on conflict (room_id, user_id, client_request_id) do nothing;
  exception when others then ok := true; end;
  perform pg_temp.ck(ok, '幂等: 缺 WHERE 谓词的 ON CONFLICT 被拒（DB-12 必须写全谓词）');
end $$;

do $$ declare n int; begin
  insert into public.app_prayer_shares (id, room_id, user_id, text, created_at, client_request_id)
  values ('idem_2','r_idem','22222222-2222-2222-2222-222222222222','重放',now(),'req-A')
  on conflict (room_id, user_id, client_request_id) where client_request_id is not null
  do nothing;
  select count(*) into n from public.app_prayer_shares where client_request_id='req-A';
  perform pg_temp.ck(n = 1, '幂等: 带谓词时相同 client_request_id 的重放被正确去重');
end $$;

do $$ declare n int; begin
  insert into public.app_prayer_shares (id, room_id, user_id, text, created_at, client_request_id)
  values ('null_1','r_idem','22222222-2222-2222-2222-222222222222','无幂等键',now(),null);
  insert into public.app_prayer_shares (id, room_id, user_id, text, created_at, client_request_id)
  values ('null_2','r_idem','22222222-2222-2222-2222-222222222222','无幂等键',now(),null);
  select count(*) into n from public.app_prayer_shares where client_request_id is null and room_id='r_idem';
  perform pg_temp.ck(n = 2, '幂等: 无幂等键的分享不被误去重（部分索引语义正确）');
end $$;


-- ══ 7. 循环引用的 DEFERRABLE FK ═══════════════════════════════════════════
do $$ begin
  insert into public.app_prayer_sessions
    (id, room_id, status, current_item_id, created_at, updated_at)
  values ('sess_1','r_idem','scheduled','item_1',now(),now());   -- 此刻 item 尚不存在
  insert into public.app_prayer_session_items (id, session_id, position, title, created_at)
  values ('item_1','sess_1',1,'第一项',now());
  perform pg_temp.ck(true, 'DEFERRABLE: 会话与条目的循环引用可在同一事务内成立');
end $$;

do $$ declare ok boolean := false; begin
  begin
    insert into public.app_prayer_sessions (id, room_id, status, current_item_id, created_at, updated_at)
      values ('sess_bad','r_idem','scheduled','never_exists',now(),now());
    -- 强制在事务结束前检查延迟约束
    set constraints public.app_prayer_sessions_current_item_fk immediate;
  exception when foreign_key_violation then ok := true; end;
  perform pg_temp.ck(ok, 'DEFERRABLE: 悬空的 current_item_id 最终仍被 FK 拒绝');
end $$;

-- 一个房间同时只能有一场进行中的祷告会
do $$ declare ok boolean := false; begin
  insert into public.app_prayer_sessions (id, room_id, status, started_at, created_at, updated_at)
    values ('sess_a','r_idem','active',now(),now(),now());
  begin
    insert into public.app_prayer_sessions (id, room_id, status, started_at, created_at, updated_at)
      values ('sess_b','r_idem','active',now(),now(),now());
  exception when unique_violation then ok := true; end;
  perform pg_temp.ck(ok, '房间内同时只允许一场 active 祷告会');
end $$;

-- 生命周期形态
do $$ declare ok boolean := false; begin
  begin
    insert into public.app_prayer_sessions (id, room_id, status, created_at, updated_at)
      values ('sess_c','r_idem','active',now(),now());          -- active 却无 started_at
  exception when check_violation then ok := true; end;
  perform pg_temp.ck(ok, '生命周期: active 会话必须有 started_at');
end $$;


-- ══ 8. 迁移工具表的护栏 ═══════════════════════════════════════════════════
do $$ declare ok boolean := false; begin
  begin
    insert into migration.legacy_identity_crosswalk
      (legacy_sqlite_user_id, canonical_profile_id, mapping_method, mapping_confidence, verified,
       verified_by, verified_at)
    values ('L1','22222222-2222-2222-2222-222222222222','email_match_unreviewed','low',true,
            '22222222-2222-2222-2222-222222222222', now());
  exception when check_violation then ok := true; end;
  perform pg_temp.ck(ok, 'crosswalk: email-only 匹配不得带 verified=true 落库');
end $$;

do $$ declare ok boolean := false; begin
  begin
    insert into migration.admin_role_migration_manifest
      (legacy_user_id, legacy_role, target_roles, review_status)
    values ('L2','admin','{super_admin}','RESOLVED');           -- 缺裁定依据与裁定人
  exception when check_violation then ok := true; end;
  perform pg_temp.ck(ok, 'admin manifest: RESOLVED 必须附裁定依据与裁定人');
end $$;

do $$ declare ok boolean := false; begin
  begin
    insert into migration.admin_role_migration_manifest
      (legacy_user_id, legacy_role, target_roles, review_status)
    values ('L3','admin','{god_mode}','NEEDS_MANUAL_REVIEW');
  exception when check_violation then ok := true; end;
  perform pg_temp.ck(ok, 'admin manifest: 不存在的角色名被拒绝');
end $$;

do $$ declare ok boolean := false; begin
  begin
    insert into migration.row_manifest (batch, source_table, source_pk, target_table, status)
    values ('B1','users','u1','profiles','DONE');               -- 非法状态
  exception when check_violation then ok := true; end;
  perform pg_temp.ck(ok, 'row manifest: 状态值域被钉死');
end $$;

do $$ begin
  perform pg_temp.ck(exists(select 1 from migration.schema_baseline where contract_version='DB-3.0'),
    'TASK 18: schema 版本基线已登记');
end $$;


-- ══ 9. 授权边界 —— fail-closed ════════════════════════════════════════════
do $$
declare leaked text;
begin
  select string_agg(distinct table_name, ', ') into leaked
  from information_schema.role_table_grants
  where table_schema='public' and table_name like 'app\_%'
    and grantee in ('anon','authenticated');
  perform pg_temp.ck(leaked is null,
    coalesce('fail-closed: 以下 app_* 表对客户端有权限 -> ' || leaked,
             'fail-closed: 所有 app_* 表对 anon/authenticated 无任何权限'));
end $$;

do $$
declare n int;
begin
  select count(*) into n from pg_class c
   join pg_namespace ns on ns.oid=c.relnamespace
   where ns.nspname='public' and c.relname like 'app\_%' and c.relkind='r'
     and c.relrowsecurity = false;
  perform pg_temp.ck(n = 0, 'fail-closed: 所有 app_* 表已启用 RLS');
end $$;

do $$ begin
  perform pg_temp.ck(not has_schema_privilege('anon','migration','USAGE'),
    'fail-closed: anon 无 migration schema 访问权');
  perform pg_temp.ck(not has_schema_privilege('authenticated','migration','USAGE'),
    'fail-closed: authenticated 无 migration schema 访问权');
end $$;


-- ══ 10. 课程 —— 不存在第二套目录 ══════════════════════════════════════════
do $$ begin
  perform pg_temp.ck(to_regclass('public.app_courses') is null
                 and to_regclass('public.app_course_catalog') is null,
    '课程: 未创建第二套课程目录');
  perform pg_temp.ck((select confrelid::regclass::text from pg_constraint
     where conrelid='public.app_course_progress'::regclass and contype='f'
       and conkey = array[(select attnum from pg_attribute
                            where attrelid='public.app_course_progress'::regclass
                              and attname='course_code')]) = 'course_catalog',
    '课程: 学习进度直接 FK 到 canonical course_catalog');
  perform pg_temp.ck(exists(select 1 from information_schema.columns
     where table_schema='public' and table_name='course_catalog'
       and column_name='created_by_provenance'),
    'D-28: created_by 以 provenance 列承接');
  perform pg_temp.ck(not exists(select 1 from pg_constraint
     where conrelid='public.course_catalog'::regclass and contype='f'
       and conkey = array[(select attnum from pg_attribute
                            where attrelid='public.course_catalog'::regclass
                              and attname='created_by_provenance')]),
    'D-28: provenance 列刻意没有身份 FK');
end $$;

-- 目录条目仍有学习进度时不得被删除。
--
-- ★ 版本可移植性（DB-3.5 实测）：RESTRICT 违反抛出的 SQLSTATE 随 PG 版本不同 ——
--     PostgreSQL 17.6（Supabase 目标版本）：23503 foreign_key_violation
--     PostgreSQL 18.6                    ：23001 restrict_violation（18 才引入的独立条件）
--   两版的**行为完全一致**（删除都被挡住），只有错误码不同。
--   因此这里断言的是「删除被阻止 + 行仍在」这一行为本身，
--   同时把实际 SQLSTATE 记入 NOTICE 供 DB-12 的异常处理参考。
--   —— 这不是放宽：多了一条「父行必须仍然存在」的断言，比原来更严。
do $$
declare blocked boolean := false; s text; survived boolean;
begin
  insert into public.course_catalog (code, title_zh, category) values ('c_db3test','测试','bible_basics');
  insert into public.app_course_progress (user_id, course_code, progress, updated_at)
    values ('22222222-2222-2222-2222-222222222222','c_db3test',10,now());
  begin
    delete from public.course_catalog where code='c_db3test';
  exception when restrict_violation or foreign_key_violation then
    blocked := true;
    get stacked diagnostics s = returned_sqlstate;
  end;
  perform pg_temp.ck(blocked,
    '课程: RESTRICT 阻止删除仍有学习进度的目录条目（sqlstate='||coalesce(s,'none')||'）');

  select exists(select 1 from public.course_catalog where code='c_db3test') into survived;
  perform pg_temp.ck(survived, '课程: 被 RESTRICT 拦下的目录条目确实仍然存在');
end $$;


-- ══ 11. Portal 既有资产未被破坏 ═══════════════════════════════════════════
do $$
declare missing text;
begin
  select string_agg(t, ', ') into missing from unnest(array[
    'profiles','user_roles','submissions','applications','program_catalog',
    'course_catalog','student_records','student_status_history',
    'student_number_registry','application_hq_approvals','hq_approval_internal'
  ]) t where to_regclass('public.'||t) is null;
  perform pg_temp.ck(missing is null,
    coalesce('Portal: 以下既有表缺失 -> '||missing, 'Portal: 抽查的既有表全部完好'));
end $$;

do $$ begin
  perform pg_temp.ck(public.is_admin_any('22222222-2222-2222-2222-222222222222') = false,
    'Portal: 无角色账号不是管理员（fail-closed 未被破坏）');
  perform pg_temp.ck(public.is_assigned_teacher(
      '22222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222') = false,
    'Portal: 占位授权函数仍然 fail-closed');
end $$;


rollback;
\echo '=== DB-3 SCHEMA CONTRACT TESTS: 全部断言通过（已回滚，无残留数据）==='
