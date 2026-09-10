-- ══════════════════════════════════════════════════════════════════════
-- BATCH B  ·  DB-9 系统房间迁移  ·  一次性数据脚本
-- ══════════════════════════════════════════════════════════════════════
--
-- ★★ 本文件会写数据库。不放 supabase/migrations/（不是 migration apply，
--    不得产生新 ledger 版本），也不放 supabase/tests/（那是纯 SELECT 探针）。
--
-- 保险丝：缺 -v i_understand_this_writes=YES 直接中止。
--
-- 范围（Supervisor STAGING-1A11 授权）：
--   迁移 5 个 host_id='system' 的内置房间 → public.app_rooms
--   其余 26 行 DB-9 源行一律 SKIPPED，并在 row_manifest 中留痕
--
-- canonical 语义（0025 三态 host 模型）：
--   host_type='system' · host_user_id=NULL · host_orphaned_at=NULL
--   源库 5 行的 password_hash / salt 实测均为 NULL，原样搬运，不发明值。
--   created_at 源为 epoch 毫秒 integer → to_timestamp(x/1000.0)
--
-- 明令不迁：2 个夹具房间 · 3 room_members · 2 room_prayer_topics ·
--   10 夹具 prayer_shares · 1 夹具 prayer_intercession ·
--   2 孤儿 prayer_shares · 6 room_realtime_events
-- ══════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\if :{?i_understand_this_writes}
\else
  \echo '拒绝执行：缺少 -v i_understand_this_writes=YES'
  \quit
\endif

begin;

-- ── 前置断言 ─────────────────────────────────────────────────────────
do $$
declare n int; bad text := '';
begin
  select count(*) into n from public.app_rooms;                if n<>0 then bad:=bad||format('app_rooms=%s; ',n); end if;
  select count(*) into n from public.app_room_members;         if n<>0 then bad:=bad||format('app_room_members=%s; ',n); end if;
  select count(*) into n from public.app_room_prayer_topics;   if n<>0 then bad:=bad||format('app_room_prayer_topics=%s; ',n); end if;
  select count(*) into n from public.app_prayer_shares;        if n<>0 then bad:=bad||format('app_prayer_shares=%s; ',n); end if;
  select count(*) into n from public.app_prayer_intercessions; if n<>0 then bad:=bad||format('app_prayer_intercessions=%s; ',n); end if;
  select count(*) into n from public.app_room_realtime_events; if n<>0 then bad:=bad||format('app_room_realtime_events=%s; ',n); end if;
  select count(*) into n from migration.row_manifest where batch='DB-9'; if n<>0 then bad:=bad||format('DB-9 manifest=%s; ',n); end if;
  if bad<>'' then raise exception 'BATCH B 前置失败：% ', bad; end if;
end $$;

-- ── 1. 5 个系统房间 ──────────────────────────────────────────────────
insert into public.app_rooms
  (id, host_type, host_user_id, host_orphaned_at, password_hash, password_salt, created_at)
values
  ('bible_reading', 'system'::public.app_room_host_type, null, null, null, null, to_timestamp(1788408535219/1000.0)),
  ('fellowship_room', 'system'::public.app_room_host_type, null, null, null, null, to_timestamp(1788408535219/1000.0)),
  ('praise_room', 'system'::public.app_room_host_type, null, null, null, null, to_timestamp(1788408535219/1000.0)),
  ('prayer_room', 'system'::public.app_room_host_type, null, null, null, null, to_timestamp(1788408535219/1000.0)),
  ('preaching_room', 'system'::public.app_room_host_type, null, null, null, null, to_timestamp(1788408535219/1000.0));

-- ── 2. row_manifest：31 条（5 MIGRATED + 26 SKIPPED）────────────────
--     transformation / identity_mapping 只写机器可判读的原因码与结构说明，
--     不写任何 PII。
insert into migration.row_manifest
  (batch, source_table, source_pk, target_table, target_pk, status,
   transformation, identity_mapping, manual_review)
values
  ('DB-9', 'rooms', 'bible_reading', 'public.app_rooms', 'bible_reading', 'MIGRATED', 'host_type=system; created_at epoch_ms -> timestamptz', 'none (system-hosted room, no identity)', false),
  ('DB-9', 'rooms', 'fellowship_room', 'public.app_rooms', 'fellowship_room', 'MIGRATED', 'host_type=system; created_at epoch_ms -> timestamptz', 'none (system-hosted room, no identity)', false),
  ('DB-9', 'rooms', 'praise_room', 'public.app_rooms', 'praise_room', 'MIGRATED', 'host_type=system; created_at epoch_ms -> timestamptz', 'none (system-hosted room, no identity)', false),
  ('DB-9', 'rooms', 'prayer_room', 'public.app_rooms', 'prayer_room', 'MIGRATED', 'host_type=system; created_at epoch_ms -> timestamptz', 'none (system-hosted room, no identity)', false),
  ('DB-9', 'rooms', 'preaching_room', 'public.app_rooms', 'preaching_room', 'MIGRATED', 'host_type=system; created_at epoch_ms -> timestamptz', 'none (system-hosted room, no identity)', false),
  ('DB-9', 'rooms', 'sec2_r1_1788408464067', 'public.app_rooms', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'host identity excluded from canonical identity (D-34)', false),
  ('DB-9', 'rooms', 'sec2_r2_1788408464067', 'public.app_rooms', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'host identity excluded from canonical identity (D-34)', false),
  ('DB-9', 'room_members', 'sec2_r1_1788408464067|1cb28215-30f6-408d-a68e-ae1178ef0c46', 'public.app_room_members', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'target user_id is NOT NULL; no canonical profile exists', false),
  ('DB-9', 'room_members', 'sec2_r1_1788408464067|dc4c6c4d-1ebd-4021-9b81-d9f5e31f38d2', 'public.app_room_members', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'target user_id is NOT NULL; no canonical profile exists', false),
  ('DB-9', 'room_members', 'sec2_r2_1788408464067|dc4c6c4d-1ebd-4021-9b81-d9f5e31f38d2', 'public.app_room_members', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'target user_id is NOT NULL; no canonical profile exists', false),
  ('DB-9', 'room_prayer_topics', '2fa6be1a578ff1aa27', 'public.app_room_prayer_topics', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'room_prayer_topics', 'dfd8fd12f8b290ad03', 'public.app_room_prayer_topics', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', '1013a5683b195c40c6', 'public.app_prayer_shares', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', '19081f47eaee8f9e58', 'public.app_prayer_shares', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', '4a68f2703d721ca4d0', 'public.app_prayer_shares', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', '4f8eafb9289a4f16e7', 'public.app_prayer_shares', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', '6e2ea8175cfd06963d', 'public.app_prayer_shares', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', 'b83d8d4cfa766b99bd', 'public.app_prayer_shares', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', 'be7642c223daaf7179', 'public.app_prayer_shares', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', 'e244e6338439082206', 'public.app_prayer_shares', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', 'e70a18de93cb19778d', 'public.app_prayer_shares', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', 'f8878cb635371f4c5b', 'public.app_prayer_shares', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'parent room excluded', false),
  ('DB-9', 'prayer_shares', '14ac1aea70639211c5', 'public.app_prayer_shares', null, 'SKIPPED', 'ORPHAN_MISSING_ROOM_PARENT', 'room_id is NOT NULL FK; referenced room absent in source', false),
  ('DB-9', 'prayer_shares', 'ac06bdcf6d62b1f150', 'public.app_prayer_shares', null, 'SKIPPED', 'ORPHAN_MISSING_ROOM_PARENT', 'room_id is NOT NULL FK; referenced room absent in source', false),
  ('DB-9', 'prayer_intercessions', '4a68f2703d721ca4d0|dc4c6c4d-1ebd-4021-9b81-d9f5e31f38d2', 'public.app_prayer_intercessions', null, 'SKIPPED', 'TEST_FIXTURE_DERIVED', 'target user_id is NOT NULL; no canonical profile exists', false),
  ('DB-9', 'room_realtime_events', '89', 'public.app_room_realtime_events', null, 'SKIPPED', 'EPHEMERAL_EVENT_DO_NOT_MIGRATE', 'canonical contract: presence/events not migrated', false),
  ('DB-9', 'room_realtime_events', '90', 'public.app_room_realtime_events', null, 'SKIPPED', 'EPHEMERAL_EVENT_DO_NOT_MIGRATE', 'canonical contract: presence/events not migrated', false),
  ('DB-9', 'room_realtime_events', '91', 'public.app_room_realtime_events', null, 'SKIPPED', 'EPHEMERAL_EVENT_DO_NOT_MIGRATE', 'canonical contract: presence/events not migrated', false),
  ('DB-9', 'room_realtime_events', '92', 'public.app_room_realtime_events', null, 'SKIPPED', 'EPHEMERAL_EVENT_DO_NOT_MIGRATE', 'canonical contract: presence/events not migrated', false),
  ('DB-9', 'room_realtime_events', '93', 'public.app_room_realtime_events', null, 'SKIPPED', 'EPHEMERAL_EVENT_DO_NOT_MIGRATE', 'canonical contract: presence/events not migrated', false),
  ('DB-9', 'room_realtime_events', '94', 'public.app_room_realtime_events', null, 'SKIPPED', 'EPHEMERAL_EVENT_DO_NOT_MIGRATE', 'canonical contract: presence/events not migrated', false);

-- ── 3. 事务内硬断言 ─────────────────────────────────────────────────
do $$
declare bad text := ''; n int; m int; s int;
begin
  select count(*) into n from public.app_rooms;
  if n <> 5 then bad := bad || format('app_rooms=%s(期望5); ', n); end if;
  select count(*) into n from public.app_rooms where host_type <> 'system';
  if n <> 0 then bad := bad || format('非 system host 的房间=%s(期望0); ', n); end if;
  select count(*) into n from public.app_rooms where host_user_id is not null or host_orphaned_at is not null;
  if n <> 0 then bad := bad || format('host_user_id/host_orphaned_at 非空=%s(期望0); ', n); end if;

  select count(*) into n from public.app_room_members;         if n<>0 then bad:=bad||format('app_room_members=%s; ',n); end if;
  select count(*) into n from public.app_room_prayer_topics;   if n<>0 then bad:=bad||format('app_room_prayer_topics=%s; ',n); end if;
  select count(*) into n from public.app_prayer_shares;        if n<>0 then bad:=bad||format('app_prayer_shares=%s; ',n); end if;
  select count(*) into n from public.app_prayer_intercessions; if n<>0 then bad:=bad||format('app_prayer_intercessions=%s; ',n); end if;
  select count(*) into n from public.app_room_realtime_events; if n<>0 then bad:=bad||format('app_room_realtime_events=%s; ',n); end if;

  select count(*) filter (where status='MIGRATED'), count(*) filter (where status='SKIPPED'), count(*)
    into m, s, n from migration.row_manifest where batch='DB-9';
  if (m, s, n) is distinct from (5, 26, 31) then
    bad := bad || format('DB-9 manifest=%s/%s/%s(期望 5/26/31); ', m, s, n); end if;
  select count(*) into n from migration.row_manifest where batch='DB-9' and manual_review;
  if n <> 0 then bad := bad || format('manifest manual_review=true 行数=%s(期望0); ', n); end if;

  -- 身份与既有业务态不得被本批次触碰
  select count(*) into n from auth.users;              if n<>1 then bad:=bad||format('auth.users=%s; ',n); end if;
  select count(*) into n from public.profiles;         if n<>1 then bad:=bad||format('profiles=%s; ',n); end if;
  select count(*) into n from public.user_roles;       if n<>1 then bad:=bad||format('user_roles=%s; ',n); end if;
  select count(*) into n from public.course_catalog;   if n<>67 then bad:=bad||format('course_catalog=%s; ',n); end if;
  select count(*) into n from public.program_catalog;  if n<>9 then bad:=bad||format('program_catalog=%s; ',n); end if;
  select count(*) into n from supabase_migrations.schema_migrations; if n<>26 then bad:=bad||format('ledger=%s; ',n); end if;

  if bad <> '' then raise exception 'BATCH B 事务内断言失败，整体回滚: %', bad; end if;
  raise notice 'BATCH B 断言全过：app_rooms=5 全 system · 其余 5 张房间/祷告表仍为 0 · DB-9 manifest 5/26/31 · 身份 1/1/1 · cc67 pc9 ledger26';
end $$;

commit;
select 'BATCH-B|COMMITTED' as result;
