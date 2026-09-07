-- ============================================================================
-- db3_rollback.sql
-- RB-01 / DB-3 回退脚本 —— 把库还原到 0022 之后、0023 之前的状态。
--
-- DB-1 §13 要求每个阶段可独立回退。DB-3 只建 schema、未迁移任何业务数据，
-- 因此回退是完全可逆的：删掉本阶段建立的对象即可，Portal 既有资产不受影响。
--
-- ⚠ 一旦进入 DB-4 并开始写入业务数据，本脚本会**连同那些数据一起删除**。
--   届时必须先确认 app_* 表中没有需要保留的内容，再执行。
--
-- 用法：psql -v ON_ERROR_STOP=1 -f supabase/tests/db3_rollback.sql
-- ============================================================================

\set ON_ERROR_STOP on
begin;

-- 0026 社群域
drop table if exists public.app_cooperation_submissions cascade;
drop table if exists public.app_announcements           cascade;
drop table if exists public.app_push_tokens             cascade;
drop table if exists public.app_recordings              cascade;
drop table if exists public.app_library_favorites       cascade;
drop table if exists public.app_library_books           cascade;
drop table if exists public.app_friendships             cascade;
drop table if exists public.app_friend_requests         cascade;
drop table if exists public.app_post_comments           cascade;
drop table if exists public.app_post_likes              cascade;
drop table if exists public.app_posts                   cascade;

-- 0025 房间与祷告域
drop table if exists public.app_prayer_share_reports    cascade;
drop table if exists public.app_prayer_intercessions    cascade;
drop table if exists public.app_prayer_shares           cascade;
drop table if exists public.app_prayer_session_events   cascade;
drop table if exists public.app_prayer_session_items    cascade;
drop table if exists public.app_prayer_sessions         cascade;
drop table if exists public.app_room_realtime_events    cascade;
drop table if exists public.app_room_prayer_topics      cascade;
drop table if exists public.app_room_reading_state      cascade;
drop table if exists public.app_room_presence           cascade;
drop table if exists public.app_room_members            cascade;
drop table if exists public.app_rooms                   cascade;
drop function if exists public.app_rooms_mark_host_orphaned() cascade;

-- 0024 学习域
drop table if exists public.app_practice_training_state cascade;
drop table if exists public.app_christian_profile       cascade;
drop table if exists public.app_course_progress         cascade;
drop table if exists public.app_course_files            cascade;

-- 0024 §1 course_catalog 扩展列（Portal 原表保留，只去掉本阶段加的列）
alter table public.course_catalog drop constraint if exists course_catalog_thumbnail_image_fk;
alter table public.course_catalog drop column if exists created_by_provenance;
alter table public.course_catalog drop column if exists created_at;
alter table public.course_catalog drop column if exists thumbnail_image_id;
alter table public.course_catalog drop column if exists thumbnail_path;

-- 0023 §4 / §3 / §2 / §1
drop table if exists public.app_image_uploads cascade;

drop type if exists app_announcement_type          cascade;
drop type if exists app_push_platform              cascade;
drop type if exists app_prayer_report_status       cascade;
drop type if exists app_prayer_report_reason       cascade;
drop type if exists app_prayer_session_event_type  cascade;
drop type if exists app_prayer_session_status      cascade;
drop type if exists app_room_event_type            cascade;
drop type if exists app_room_member_role           cascade;
drop type if exists app_room_host_type             cascade;

alter table public.profiles drop constraint if exists profiles_bio_length;
alter table public.profiles drop column if exists bio;

drop schema if exists migration cascade;

commit;
\echo '=== DB-3 已回退：App schema 全部移除，Portal 既有资产保持不变 ==='
