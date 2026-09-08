-- ============================================================================
-- staging_readonly_probe.sql  ·  v2（STAGING-1A 修正版）
-- 远端 amas-staging 的**只读**事实探测包
--
-- ★ 全文件只有 SELECT。无 INSERT / UPDATE / DELETE / DDL / migration /
--   db push / ledger repair。可安全在 staging 上执行。
--
-- ── v2 相对 v1 的修正（Supervisor 指出）─────────────────────────────────
--   1. P4 原用 consume_rpc_context 作 0013 哨兵 —— 错。canonical 是
--      application_protect_locked。原用 history_guard 作 0014 哨兵 —— 错，
--      canonical 是 append_only_guard 的定义演进。
--      → 此前 consume_rpc_context=false / history_guard=false **不得计入 drift**。
--   2. P4 原为 representative sample，现补成 **FULL OBJECT MATRIX**
--      （0011–0026 全部对象，149 条，同名对象归属最早创建它的 migration）。
--   3. 新增 P10：**定义级版本指纹** —— 31 个函数经历 CREATE OR REPLACE 演进，
--      存在性检查对它们无效，必须比对是哪一版。
--
-- 已知前提（Supervisor 独立只读验证）：
--   ledger = 0001..0010 · 0003 HARDENING SENTINEL = MATCH
--   OUT-OF-BAND EXECUTION IS BROAD, NOT LIMITED TO 0012
--   app_* = 0 · public.migration ABSENT  → 0023–0026 **未**应用
--   DO NOT REPAIR LEDGER · DO NOT DB PUSH · DO NOT APPLY 0023–0027
-- ============================================================================


-- ══ P0. 身份与版本 ════════════════════════════════════════════════════════
select current_database() as database, current_user as connected_as,
       version() as pg_version,
       (select setting from pg_settings where name='server_version') as server_version;


-- ══ P1. 迁移 ledger（精确有序）════════════════════════════════════════════
select version, name from supabase_migrations.schema_migrations order by version;
select count(*) as ledger_rows, min(version) as min_v, max(version) as max_v
from supabase_migrations.schema_migrations;


-- ══ P2. 0003 加固哨兵（已 MATCH，保留供复现）══════════════════════════════
-- 0002 版 search_path = public；0003 版 search_path = ''（加固版）。
select p.proname, p.prosecdef as security_definer, p.proconfig as search_path_config,
       md5(pg_get_functiondef(p.oid)) as definition_md5
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('has_active_role','is_admin_any')
order by p.proname;


-- ══ P4. FULL OBJECT MATRIX —— 0011–0026 全部对象（149 条）═════════════════
-- ledger 停在 0010，故下列每一项若 present=true 即为带外执行证据。
-- ⚠ 对 kind='function' 且属于 P10 演进集合的条目，present=true **只说明同名函数在**，
--   不能据此认定该 migration 已执行 —— 版本判定看 P10。
with expected(migration, kind, objname) as (values
  ('0011','function','review_application'),
  ('0012','table','application_hq_approvals'),
  ('0012','table','hq_approval_internal'),
  ('0012','table','student_number_registry'),
  ('0012','table','student_records'),
  ('0012','table','student_status_history'),
  ('0012','type','hq_approval_status'),
  ('0012','type','student_status'),
  ('0012','function','activate_student'),
  ('0012','function','admissions_ready_for_enrollment'),
  ('0012','function','append_only_guard'),
  ('0012','function','confirm_hq_approval'),
  ('0012','function','correct_student_number'),
  ('0012','function','create_student_record'),
  ('0012','function','my_student_record'),
  ('0012','function','my_student_timeline'),
  ('0012','function','normalize_student_number'),
  ('0012','function','student_guard'),
  ('0012','function','sync_alias_on_role_revoke'),
  ('0012','trigger','hq_approvals_set_updated_at'),
  ('0012','trigger','ssh_append_only'),
  ('0012','trigger','student_records_guard'),
  ('0012','trigger','student_records_set_updated_at'),
  ('0012','trigger','user_roles_alias_sync'),
  ('0012','policy','hq_appr_select'),
  ('0012','policy','hq_internal_select'),
  ('0012','policy','ssh_select'),
  ('0012','policy','student_admin_select'),
  ('0012','policy','student_self_select'),
  ('0012','index','ssh_by_student'),
  ('0012','index','student_records_status'),
  ('0013','function','application_protect_locked'),
  ('0015','table','student_number_void_requests'),
  ('0015','type','number_void_status'),
  ('0015','type','student_number_state'),
  ('0015','function','approve_student_number_void'),
  ('0015','function','pending_number_void_requests'),
  ('0015','function','reject_student_number_void'),
  ('0015','function','request_student_number_void'),
  ('0015','function','student_number_has_irreversible_records'),
  ('0015','policy','snvr_admin_select'),
  ('0015','index','snvr_by_status'),
  ('0015','index','snvr_one_pending'),
  ('0015','index','student_number_by_normalized'),
  ('0015','index','student_number_occupied_unique'),
  ('0016','table','course_catalog'),
  ('0016','type','course_availability'),
  ('0016','type','course_category'),
  ('0016','function','course_catalog_guard'),
  ('0016','trigger','course_catalog_guard_t'),
  ('0016','policy','course_catalog_read'),
  ('0016','index','course_catalog_cat'),
  ('0017','function','my_action_items'),
  ('0017','function','my_learning'),
  ('0017','function','my_student_capabilities'),
  ('0017','function','my_student_profile'),
  ('0017','function','update_my_contact'),
  ('0018','table','irreversible_record_sources'),
  ('0018','type','irreversible_verdict'),
  ('0020','table','recovery_flows'),
  ('0020','type','recovery_flow_status'),
  ('0020','function','claim_recovery_flow'),
  ('0020','function','complete_recovery_flow'),
  ('0020','function','fail_recovery_flow'),
  ('0020','function','my_recovery_flow'),
  ('0020','function','start_recovery_flow'),
  ('0020','trigger','recovery_flows_set_updated_at'),
  ('0020','policy','recovery_flows_self_select'),
  ('0020','index','recovery_flows_lookup'),
  ('0020','index','recovery_flows_one_active'),
  ('0021','function','reap_stale_recovery_flows'),
  ('0023','table','app_image_uploads'),
  ('0023','schema','migration'),
  ('0023','type','app_announcement_type'),
  ('0023','type','app_prayer_report_reason'),
  ('0023','type','app_prayer_report_status'),
  ('0023','type','app_prayer_session_event_type'),
  ('0023','type','app_prayer_session_status'),
  ('0023','type','app_push_platform'),
  ('0023','type','app_room_event_type'),
  ('0023','type','app_room_host_type'),
  ('0023','type','app_room_member_role'),
  ('0023','index','idx_app_image_uploads_uploader'),
  ('0023','index','idx_crosswalk_method'),
  ('0023','index','idx_row_manifest_table_status'),
  ('0023','index','uq_crosswalk_canonical_profile'),
  ('0023','index','uq_crosswalk_supabase_user'),
  ('0023','index','uq_row_manifest_source'),
  ('0024','table','app_christian_profile'),
  ('0024','table','app_course_files'),
  ('0024','table','app_course_progress'),
  ('0024','table','app_practice_training_state'),
  ('0024','index','idx_app_course_files_course'),
  ('0024','index','idx_app_course_files_uploader'),
  ('0024','index','idx_app_course_progress_course'),
  ('0025','table','app_prayer_intercessions'),
  ('0025','table','app_prayer_session_events'),
  ('0025','table','app_prayer_session_items'),
  ('0025','table','app_prayer_sessions'),
  ('0025','table','app_prayer_share_reports'),
  ('0025','table','app_prayer_shares'),
  ('0025','table','app_room_members'),
  ('0025','table','app_room_prayer_topics'),
  ('0025','table','app_room_presence'),
  ('0025','table','app_room_reading_state'),
  ('0025','table','app_room_realtime_events'),
  ('0025','table','app_rooms'),
  ('0025','function','app_rooms_mark_host_orphaned'),
  ('0025','trigger','app_rooms_host_orphaned'),
  ('0025','index','idx_app_prayer_intercessions_user'),
  ('0025','index','idx_app_prayer_session_events_actor'),
  ('0025','index','idx_app_prayer_session_events_session'),
  ('0025','index','idx_app_prayer_sessions_creator'),
  ('0025','index','idx_app_prayer_sessions_room'),
  ('0025','index','idx_app_prayer_share_reports_open'),
  ('0025','index','idx_app_prayer_shares_room'),
  ('0025','index','idx_app_prayer_shares_user'),
  ('0025','index','idx_app_room_members_user'),
  ('0025','index','idx_app_room_prayer_topics_room'),
  ('0025','index','idx_app_room_presence_seen'),
  ('0025','index','idx_app_room_realtime_events_room'),
  ('0025','index','idx_app_rooms_host'),
  ('0025','index','uq_app_prayer_sessions_active_per_room'),
  ('0025','index','uq_app_prayer_shares_idem'),
  ('0026','table','app_announcements'),
  ('0026','table','app_cooperation_submissions'),
  ('0026','table','app_friend_requests'),
  ('0026','table','app_friendships'),
  ('0026','table','app_library_books'),
  ('0026','table','app_library_favorites'),
  ('0026','table','app_post_comments'),
  ('0026','table','app_post_likes'),
  ('0026','table','app_posts'),
  ('0026','table','app_push_tokens'),
  ('0026','table','app_recordings'),
  ('0026','index','idx_app_announcements_published_at'),
  ('0026','index','idx_app_cooperation_received_at'),
  ('0026','index','idx_app_friend_requests_to'),
  ('0026','index','idx_app_friendships_user_b'),
  ('0026','index','idx_app_library_books_added_at'),
  ('0026','index','idx_app_library_books_cover'),
  ('0026','index','idx_app_library_favorites_book'),
  ('0026','index','idx_app_post_comments_post'),
  ('0026','index','idx_app_post_comments_user'),
  ('0026','index','idx_app_post_likes_user'),
  ('0026','index','idx_app_posts_created_at'),
  ('0026','index','idx_app_posts_user'),
  ('0026','index','idx_app_recordings_room'),
  ('0026','index','idx_app_recordings_user')
)
select e.migration, e.kind, e.objname,
  case e.kind
    when 'table'    then (to_regclass('public.'||e.objname) is not null)
    when 'type'     then exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
                                  where n.nspname='public' and t.typname=e.objname)
    when 'function' then exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                                  where n.nspname='public' and p.proname=e.objname)
    when 'trigger'  then exists (select 1 from pg_trigger g where not g.tgisinternal and g.tgname=e.objname)
    when 'policy'   then exists (select 1 from pg_policies q where q.schemaname='public' and q.policyname=e.objname)
    when 'index'    then (to_regclass('public.'||e.objname) is not null)
    when 'schema'   then exists (select 1 from pg_namespace n where n.nspname=e.objname)
  end as present
from expected e
order by e.migration, e.kind, e.objname;

-- 汇总（便于快速看 drift 广度）
with expected(migration, kind, objname) as (values
  ('0011','function','review_application'),
  ('0012','table','application_hq_approvals'),
  ('0012','table','hq_approval_internal'),
  ('0012','table','student_number_registry'),
  ('0012','table','student_records'),
  ('0012','table','student_status_history'),
  ('0012','type','hq_approval_status'),
  ('0012','type','student_status'),
  ('0012','function','activate_student'),
  ('0012','function','admissions_ready_for_enrollment'),
  ('0012','function','append_only_guard'),
  ('0012','function','confirm_hq_approval'),
  ('0012','function','correct_student_number'),
  ('0012','function','create_student_record'),
  ('0012','function','my_student_record'),
  ('0012','function','my_student_timeline'),
  ('0012','function','normalize_student_number'),
  ('0012','function','student_guard'),
  ('0012','function','sync_alias_on_role_revoke'),
  ('0012','trigger','hq_approvals_set_updated_at'),
  ('0012','trigger','ssh_append_only'),
  ('0012','trigger','student_records_guard'),
  ('0012','trigger','student_records_set_updated_at'),
  ('0012','trigger','user_roles_alias_sync'),
  ('0012','policy','hq_appr_select'),
  ('0012','policy','hq_internal_select'),
  ('0012','policy','ssh_select'),
  ('0012','policy','student_admin_select'),
  ('0012','policy','student_self_select'),
  ('0012','index','ssh_by_student'),
  ('0012','index','student_records_status'),
  ('0013','function','application_protect_locked'),
  ('0015','table','student_number_void_requests'),
  ('0015','type','number_void_status'),
  ('0015','type','student_number_state'),
  ('0015','function','approve_student_number_void'),
  ('0015','function','pending_number_void_requests'),
  ('0015','function','reject_student_number_void'),
  ('0015','function','request_student_number_void'),
  ('0015','function','student_number_has_irreversible_records'),
  ('0015','policy','snvr_admin_select'),
  ('0015','index','snvr_by_status'),
  ('0015','index','snvr_one_pending'),
  ('0015','index','student_number_by_normalized'),
  ('0015','index','student_number_occupied_unique'),
  ('0016','table','course_catalog'),
  ('0016','type','course_availability'),
  ('0016','type','course_category'),
  ('0016','function','course_catalog_guard'),
  ('0016','trigger','course_catalog_guard_t'),
  ('0016','policy','course_catalog_read'),
  ('0016','index','course_catalog_cat'),
  ('0017','function','my_action_items'),
  ('0017','function','my_learning'),
  ('0017','function','my_student_capabilities'),
  ('0017','function','my_student_profile'),
  ('0017','function','update_my_contact'),
  ('0018','table','irreversible_record_sources'),
  ('0018','type','irreversible_verdict'),
  ('0020','table','recovery_flows'),
  ('0020','type','recovery_flow_status'),
  ('0020','function','claim_recovery_flow'),
  ('0020','function','complete_recovery_flow'),
  ('0020','function','fail_recovery_flow'),
  ('0020','function','my_recovery_flow'),
  ('0020','function','start_recovery_flow'),
  ('0020','trigger','recovery_flows_set_updated_at'),
  ('0020','policy','recovery_flows_self_select'),
  ('0020','index','recovery_flows_lookup'),
  ('0020','index','recovery_flows_one_active'),
  ('0021','function','reap_stale_recovery_flows'),
  ('0023','table','app_image_uploads'),
  ('0023','schema','migration'),
  ('0023','type','app_announcement_type'),
  ('0023','type','app_prayer_report_reason'),
  ('0023','type','app_prayer_report_status'),
  ('0023','type','app_prayer_session_event_type'),
  ('0023','type','app_prayer_session_status'),
  ('0023','type','app_push_platform'),
  ('0023','type','app_room_event_type'),
  ('0023','type','app_room_host_type'),
  ('0023','type','app_room_member_role'),
  ('0023','index','idx_app_image_uploads_uploader'),
  ('0023','index','idx_crosswalk_method'),
  ('0023','index','idx_row_manifest_table_status'),
  ('0023','index','uq_crosswalk_canonical_profile'),
  ('0023','index','uq_crosswalk_supabase_user'),
  ('0023','index','uq_row_manifest_source'),
  ('0024','table','app_christian_profile'),
  ('0024','table','app_course_files'),
  ('0024','table','app_course_progress'),
  ('0024','table','app_practice_training_state'),
  ('0024','index','idx_app_course_files_course'),
  ('0024','index','idx_app_course_files_uploader'),
  ('0024','index','idx_app_course_progress_course'),
  ('0025','table','app_prayer_intercessions'),
  ('0025','table','app_prayer_session_events'),
  ('0025','table','app_prayer_session_items'),
  ('0025','table','app_prayer_sessions'),
  ('0025','table','app_prayer_share_reports'),
  ('0025','table','app_prayer_shares'),
  ('0025','table','app_room_members'),
  ('0025','table','app_room_prayer_topics'),
  ('0025','table','app_room_presence'),
  ('0025','table','app_room_reading_state'),
  ('0025','table','app_room_realtime_events'),
  ('0025','table','app_rooms'),
  ('0025','function','app_rooms_mark_host_orphaned'),
  ('0025','trigger','app_rooms_host_orphaned'),
  ('0025','index','idx_app_prayer_intercessions_user'),
  ('0025','index','idx_app_prayer_session_events_actor'),
  ('0025','index','idx_app_prayer_session_events_session'),
  ('0025','index','idx_app_prayer_sessions_creator'),
  ('0025','index','idx_app_prayer_sessions_room'),
  ('0025','index','idx_app_prayer_share_reports_open'),
  ('0025','index','idx_app_prayer_shares_room'),
  ('0025','index','idx_app_prayer_shares_user'),
  ('0025','index','idx_app_room_members_user'),
  ('0025','index','idx_app_room_prayer_topics_room'),
  ('0025','index','idx_app_room_presence_seen'),
  ('0025','index','idx_app_room_realtime_events_room'),
  ('0025','index','idx_app_rooms_host'),
  ('0025','index','uq_app_prayer_sessions_active_per_room'),
  ('0025','index','uq_app_prayer_shares_idem'),
  ('0026','table','app_announcements'),
  ('0026','table','app_cooperation_submissions'),
  ('0026','table','app_friend_requests'),
  ('0026','table','app_friendships'),
  ('0026','table','app_library_books'),
  ('0026','table','app_library_favorites'),
  ('0026','table','app_post_comments'),
  ('0026','table','app_post_likes'),
  ('0026','table','app_posts'),
  ('0026','table','app_push_tokens'),
  ('0026','table','app_recordings'),
  ('0026','index','idx_app_announcements_published_at'),
  ('0026','index','idx_app_cooperation_received_at'),
  ('0026','index','idx_app_friend_requests_to'),
  ('0026','index','idx_app_friendships_user_b'),
  ('0026','index','idx_app_library_books_added_at'),
  ('0026','index','idx_app_library_books_cover'),
  ('0026','index','idx_app_library_favorites_book'),
  ('0026','index','idx_app_post_comments_post'),
  ('0026','index','idx_app_post_comments_user'),
  ('0026','index','idx_app_post_likes_user'),
  ('0026','index','idx_app_posts_created_at'),
  ('0026','index','idx_app_posts_user'),
  ('0026','index','idx_app_recordings_room'),
  ('0026','index','idx_app_recordings_user')
)
select e.migration,
       count(*) as expected_objects,
       count(*) filter (where
         case e.kind
           when 'table'    then (to_regclass('public.'||e.objname) is not null)
           when 'type'     then exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname=e.objname)
           when 'function' then exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=e.objname)
           when 'trigger'  then exists (select 1 from pg_trigger g where not g.tgisinternal and g.tgname=e.objname)
           when 'policy'   then exists (select 1 from pg_policies q where q.schemaname='public' and q.policyname=e.objname)
           when 'index'    then (to_regclass('public.'||e.objname) is not null)
    when 'schema'   then exists (select 1 from pg_namespace n where n.nspname=e.objname)
         end) as present_objects
from expected e group by e.migration order by e.migration;


-- ══ P10. ★ 定义级版本指纹 ═══════════════════════════════════════════════
-- 31 个函数在 0001–0026 中经历过 CREATE OR REPLACE 演进，
-- **存在性检查对它们无效** —— 同名函数在，不代表是哪一版。
--
-- 下表给出「final canonical 版本独有、早期版本没有」的判别子串。
--   has_final_version = true   远端已是 final 版
--   has_final_version = false  远端停在某个更早的版本（须逐个定版）
--
-- ⚠ 优先看 final_migration >= 0011 的 15 行：它们的 final 版落在 ledger 之外，
--   是本轮 reconciliation 的核心未知量。
-- ⚠ 0003 那一组（has_active_role / is_admin_any / my_roles / my_profile /
--   current_user_has_role / is_assigned_* / is_enrolled_student /
--   handle_user_email_confirmed / protect_profile_fields / set_updated_at）
--   的版本差异只在 search_path（public → ''），不在函数体内，已由 P2/P6 覆盖；
--   Supervisor 已报告全部 SECURITY DEFINER = search_path ""，故该组视为 MATCH。
with evo(final_migration, fname, discriminator) as (values
  ('0005','auth_rate_check',                        'bigint'),
  ('0006','handle_new_user',                        'user_roles'),
  ('0009','submit_application',                     'amas.rpc_context'),
  ('0009','withdraw_application',                   'amas.rpc_context'),
  ('0010','application_validate_form',              'application_validate_program'),
  ('0011','review_application',                     'locked_fields'),
  ('0013','application_protect_locked',             'set_config'),
  ('0014','append_only_guard',                      'append-only'),
  ('0015','correct_student_number',                 'old_number_state'),
  ('0015','create_student_record',                  'assigned'),
  ('0018','student_number_has_irreversible_records','irreversible_record_sources'),
  ('0019','my_action_items',                        'union all select'),
  ('0019','my_learning',                            'has_active_role'),
  ('0019','my_student_capabilities',                'has_active_role'),
  ('0019','my_student_profile',                     'has_active_role'),
  ('0019','my_student_record',                      'has_active_role'),
  ('0019','my_student_timeline',                    'has_active_role'),
  ('0021','claim_recovery_flow',                    'reap_stale_recovery_flows'),
  ('0021','my_recovery_flow',                       'reap_reason'),
  ('0021','start_recovery_flow',                    'reap_stale_recovery_flows')
)
select
  e.final_migration,
  e.fname,
  (p.oid is not null)                                        as function_exists,
  case when p.oid is null then null
       else position(e.discriminator in pg_get_functiondef(p.oid)) > 0 end
                                                             as has_final_version,
  case when p.oid is null then null
       else md5(pg_get_functiondef(p.oid)) end               as definition_md5,
  p.prosecdef                                                as security_definer,
  p.proconfig                                                as search_path_config
from evo e
left join lateral (
  select pp.oid, pp.prosecdef, pp.proconfig
  from pg_proc pp join pg_namespace nn on nn.oid = pp.pronamespace
  where nn.nspname = 'public' and pp.proname = e.fname
  limit 1
) p on true
order by e.final_migration, e.fname;


-- ══ P5. 全量对象计数（与 canonical 期望态对拍）═══════════════════════════
select 'tables' as kind, count(*) as n
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
union all
select 'app_ tables', count(*)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'app\_%'
union all
select 'enums', count(*)
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typtype = 'e'
union all
select 'functions', count(*)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
union all
select 'security definer functions', count(*)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef
union all
select 'rls policies', count(*) from pg_policies where schemaname = 'public'
union all
select 'triggers', count(*) from pg_trigger where not tgisinternal
union all
select 'foreign keys', count(*) from pg_constraint where contype = 'f';


-- ══ P6. SECURITY DEFINER 函数的 search_path / ACL / 定义哈希 ═════════════
select
  p.proname,
  p.prosecdef                                          as security_definer,
  coalesce(array_to_string(p.proconfig, ','), '(none)') as search_path_config,
  md5(pg_get_functiondef(p.oid))                        as definition_md5,
  coalesce(array_to_string(p.proacl::text[], ' '), '(default: PUBLIC EXECUTE)') as acl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
order by p.proname;


-- ══ P7. 引用 is_admin_any 的 RLS 策略（0027 实际影响面）══════════════════
-- Supervisor 已实测 = 17 条（0027 patch 注释里的 13 已 STALE）。此查询供复现。
select
  schemaname, tablename, policyname, cmd,
  (coalesce(qual, '')       like '%is_admin_any(auth.uid())%') as calls_with_auth_uid,
  (coalesce(with_check, '') like '%is_admin_any%')             as in_with_check
from pg_policies
where schemaname = 'public'
  and (coalesce(qual, '') like '%is_admin_any%'
    or coalesce(with_check, '') like '%is_admin_any%')
order by tablename, policyname;

select
  count(*) as policies_calling_is_admin_any,
  count(*) filter (where coalesce(qual, '') like '%is_admin_any(auth.uid())%') as with_auth_uid
from pg_policies
where schemaname = 'public'
  and (coalesce(qual, '') like '%is_admin_any%'
    or coalesce(with_check, '') like '%is_admin_any%');


-- ══ P8. 人口（只计数，不取任何 PII）══════════════════════════════════════
select 'auth.users' as t, count(*) as n from auth.users
union all select 'profiles',   count(*) from public.profiles
union all select 'user_roles', count(*) from public.user_roles;

select role::text as role, count(*) as n from public.user_roles group by 1 order by 1;

-- 结构性线索（不取邮箱 / 姓名等任何内容）
select
  count(*)                                                as total,
  count(*) filter (where email_confirmed_at is not null)  as confirmed,
  count(*) filter (where last_sign_in_at is not null)     as has_signed_in,
  min(created_at)                                         as earliest_created,
  max(created_at)                                         as latest_created
from auth.users;

-- ★ 该账号是否产生过任何业务足迹 —— 判 fixture / 真人的关键补充证据。
--   全 0 = 从未被使用过，倾向 fixture；任一非 0 = 有真实活动，倾向真人。
select 'applications' as t, count(*) as n from public.applications
union all select 'student_records',  count(*) from public.student_records
union all select 'submissions',      count(*) from public.submissions
union all select 'audit_logs',       count(*) from public.audit_logs
union all select 'security_events',  count(*) from public.security_events
union all select 'recovery_flows',   count(*) from public.recovery_flows;


-- ══ P9. 备份能力（只读探测，不创建任何备份）══════════════════════════════
-- ⚠ wal_level / archive_mode 只说明「平台具备做备份的技术前提」，
--   **不等于** hosted backup / restore 已经可用、保留期多久、恢复要多久。
--   那三项必须在 Supabase 控制台 / Management API 侧确认。
select
  (select count(*) from pg_extension where extname = 'pg_cron') as has_pg_cron,
  (select setting from pg_settings where name = 'wal_level')     as wal_level,
  (select setting from pg_settings where name = 'archive_mode')  as archive_mode;
