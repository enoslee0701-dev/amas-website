-- ══════════════════════════════════════════════════════════════════════
-- DB-4 身份 crosswalk 填充  ·  一次性数据脚本
-- ══════════════════════════════════════════════════════════════════════
--
-- ★★ 本文件会写数据库。它刻意**不**放在 supabase/migrations/ 下 ——
--    DB-4 不是 migration apply，**不得产生新的 schema_migrations 版本**。
--    也不放在 supabase/tests/ 下，以免与那批纯 SELECT 探针混淆。
--
-- 保险丝：不显式传 -v i_understand_this_writes=YES 就整体中止。
--
-- 用法：
--   psql "$URL" -v ON_ERROR_STOP=1 -v i_understand_this_writes=YES -f 本文件
--
-- 范围（canonical DB-1 阶段表）：DB-4 = 身份迁移，只写 crosswalk 与审计清单，
-- 业务数据不动、不创建任何 Supabase 身份、无 DDL。
--
-- Supervisor 裁定（2026-09-10）：
--   legacy d470e79a… 的处置 = NO-LINK / UNRESOLVED
--   这**不**主张两个自然人身份已被证明不同；它表示现有证据不足以确立
--   canonical 关联，因此 DB-4 不得把该 legacy 身份与既有 live 用户关联。
--   六个 D-34 测试夹具确认为 TEST FIXTURE，不建 auth.users、不映射既有身份。
--
-- 幂等性：两张表都有唯一键
--   legacy_identity_crosswalk.legacy_sqlite_user_id  (PK)
--   row_manifest (batch, source_table, source_pk)    (uq_row_manifest_source)
-- 本脚本使用 on conflict do nothing，重复执行不会产生额外行，
-- 但**也不会覆盖**既有行 —— 若需改写既有裁定，须显式另行处理。
--
-- PII 取舍：evidence 只记录**观察到的事实性标志**（布尔/枚举），
-- 不把邮箱与显示名再抄一份进 Postgres。legacy id 本身是必需的关联键。
-- ══════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

\if :{?i_understand_this_writes}
\else
  \echo '拒绝执行：缺少 -v i_understand_this_writes=YES'
  \quit
\endif

begin;

-- ── 前置断言（事务内再确认一次，防止门禁与执行之间状态漂移）──────────
do $$
declare a int; b int; c int; u int; p int; r int;
begin
  select count(*) into a from migration.legacy_identity_crosswalk;
  select count(*) into b from migration.admin_role_migration_manifest;
  select count(*) into c from migration.row_manifest;
  if (a, b, c) is distinct from (0, 0, 0) then
    raise exception 'DB-4 前置失败：三张工具表非空 (crosswalk=%, admin=%, row=%)', a, b, c;
  end if;
  select count(*) into u from auth.users;
  select count(*) into p from public.profiles;
  select count(*) into r from public.user_roles;
  if (u, p, r) is distinct from (1, 1, 1) then
    raise exception 'DB-4 前置失败：身份基线非 1/1/1 (users=%, profiles=%, roles=%)', u, p, r;
  end if;
end $$;

-- ── 1. crosswalk：7 行，全部 unresolved ──────────────────────────────
--     表上的 crosswalk_resolved_shape CHECK 要求 unresolved 必须
--     canonical_profile_id IS NULL —— 与本裁定一致。
insert into migration.legacy_identity_crosswalk
  (legacy_sqlite_user_id, supabase_auth_user_id, canonical_profile_id,
   mapping_method, mapping_confidence, verified, verified_by, verified_at,
   evidence, notes)
values
  -- ① 形似真实的 legacy 身份。confidence 取 'low' 是刻意的：
  --    裁定是「证据不足以确立关联」，不是「已证明不是同一人」。
  --    用 high 会把一个未知伪装成已知。
  ('d470e79a-f155-44c5-aaaf-cc299fc04d4b', null, null,
   'unresolved', 'low', false, null, null,
   jsonb_build_object(
     'classification',              'POTENTIAL_REAL_USER',
     'decision',                    'NO-LINK / UNRESOLVED',
     'decision_source',             'SUPERVISOR 2026-09-10',
     'email_match_observed',        true,
     'display_name_match_observed', true,
     'uuid_differs',                true,
     'role_differs',                true,
     'legacy_role',                 'student',
     'live_role',                   'applicant',
     'business_content_owned',      0,
     'auto_link_forbidden_by',      'D-35 + crosswalk_email_only_requires_review'),
   'D-35 潜在真实用户。同邮箱且同显示名，但 UUID 与角色均不同。'
   '现有证据不足以确立 canonical 关联，故不与既有 live 用户关联。'
   '本行不主张两个自然人身份不同。该 legacy 身份在源库中不拥有任何业务内容行。'),

  -- ②–④ @amas.test 测试夹具
  ('6ea90950-d17f-457d-9d16-693a159592a2', null, null,
   'unresolved', 'high', false, null, null,
   jsonb_build_object('classification','TEST_FIXTURE','email_domain','amas.test',
                      'decision','EXCLUDED_FROM_CANONICAL_IDENTITY',
                      'decision_source','D-34'),
   'D-34 测试夹具，不建 auth.users、不映射既有身份。'),
  ('9492e7f2-7b60-48f7-88da-7f5bb428b779', null, null,
   'unresolved', 'high', false, null, null,
   jsonb_build_object('classification','TEST_FIXTURE','email_domain','amas.test',
                      'decision','EXCLUDED_FROM_CANONICAL_IDENTITY',
                      'decision_source','D-34'),
   'D-34 测试夹具，不建 auth.users、不映射既有身份。'),
  ('5b3896e6-4c53-46d8-8479-38a8d1bb07b5', null, null,
   'unresolved', 'high', false, null, null,
   jsonb_build_object('classification','TEST_FIXTURE','email_domain','amas.test',
                      'decision','EXCLUDED_FROM_CANONICAL_IDENTITY',
                      'decision_source','D-34'),
   'D-34 测试夹具，不建 auth.users、不映射既有身份。'),

  -- ⑤–⑦ @amas.local 测试夹具（SEC-2 验收留下）
  ('1cb28215-30f6-408d-a68e-ae1178ef0c46', null, null,
   'unresolved', 'high', false, null, null,
   jsonb_build_object('classification','TEST_FIXTURE','email_domain','amas.local',
                      'origin','SEC-2 acceptance',
                      'decision','EXCLUDED_FROM_CANONICAL_IDENTITY',
                      'decision_source','D-34'),
   'D-34 测试夹具（SEC-2 验收留下），不建 auth.users、不映射既有身份。'),
  ('dc4c6c4d-1ebd-4021-9b81-d9f5e31f38d2', null, null,
   'unresolved', 'high', false, null, null,
   jsonb_build_object('classification','TEST_FIXTURE','email_domain','amas.local',
                      'origin','SEC-2 acceptance',
                      'decision','EXCLUDED_FROM_CANONICAL_IDENTITY',
                      'decision_source','D-34'),
   'D-34 测试夹具（SEC-2 验收留下），不建 auth.users、不映射既有身份。'),
  ('1c028145-14de-494a-a08d-fdba2ff4c13d', null, null,
   'unresolved', 'high', false, null, null,
   jsonb_build_object('classification','TEST_FIXTURE','email_domain','amas.local',
                      'origin','SEC-2 acceptance',
                      'decision','EXCLUDED_FROM_CANONICAL_IDENTITY',
                      'decision_source','D-34'),
   'D-34 测试夹具（SEC-2 验收留下），不建 auth.users、不映射既有身份。')
on conflict (legacy_sqlite_user_id) do nothing;

-- ── 2. row_manifest：7 条审计行 ──────────────────────────────────────
--     status 用 SKIPPED —— 没有任何身份被迁移；写入的是解析记录本身。
--     manual_review=false —— 复核已由 Supervisor 完成并裁定，不是待办。
insert into migration.row_manifest
  (batch, source_table, source_pk, target_table, target_pk,
   status, transformation, identity_mapping, manual_review)
select 'DB-4', 'users', x.legacy_id,
       'migration.legacy_identity_crosswalk', x.legacy_id,
       'SKIPPED',
       'identity crosswalk only; no auth.users created; no business rows migrated',
       x.mapping,
       false
from (values
  ('d470e79a-f155-44c5-aaaf-cc299fc04d4b', 'unresolved / NO-LINK (POTENTIAL_REAL_USER, evidence insufficient)'),
  ('6ea90950-d17f-457d-9d16-693a159592a2', 'unresolved / TEST_FIXTURE (D-34)'),
  ('9492e7f2-7b60-48f7-88da-7f5bb428b779', 'unresolved / TEST_FIXTURE (D-34)'),
  ('5b3896e6-4c53-46d8-8479-38a8d1bb07b5', 'unresolved / TEST_FIXTURE (D-34)'),
  ('1cb28215-30f6-408d-a68e-ae1178ef0c46', 'unresolved / TEST_FIXTURE (D-34)'),
  ('dc4c6c4d-1ebd-4021-9b81-d9f5e31f38d2', 'unresolved / TEST_FIXTURE (D-34)'),
  ('1c028145-14de-494a-a08d-fdba2ff4c13d', 'unresolved / TEST_FIXTURE (D-34)')
) as x(legacy_id, mapping)
on conflict (batch, source_table, source_pk) do nothing;

-- ── 3. admin_role_migration_manifest 收 0 行 ─────────────────────────
--     源库 7 人全部 role='student'，无 admin/teacher，故本表无内容。

-- ── 4. 事务内硬断言：任一不符即整体回滚 ─────────────────────────────
do $$
declare bad text := '';
        n_cw int; n_dist int; n_unrev int; n_cprof int; n_sauth int; n_ver int;
        n_rm int; n_adm int; n_u int; n_p int; n_r int; n_app int;
begin
  select count(*), count(distinct legacy_sqlite_user_id),
         count(*) filter (where mapping_method = 'email_match_unreviewed'),
         count(*) filter (where canonical_profile_id is not null),
         count(*) filter (where supabase_auth_user_id is not null),
         count(*) filter (where verified)
    into n_cw, n_dist, n_unrev, n_cprof, n_sauth, n_ver
    from migration.legacy_identity_crosswalk;

  if n_cw    <> 7 then bad := bad || format('crosswalk 行数=%s(期望7); ', n_cw); end if;
  if n_dist  <> 7 then bad := bad || format('distinct legacy id=%s(期望7); ', n_dist); end if;
  if n_unrev <> 0 then bad := bad || format('email_match_unreviewed=%s(期望0); ', n_unrev); end if;
  if n_cprof <> 0 then bad := bad || format('canonical_profile_id 非空=%s(期望0); ', n_cprof); end if;
  if n_sauth <> 0 then bad := bad || format('supabase_auth_user_id 非空=%s(期望0); ', n_sauth); end if;
  if n_ver   <> 0 then bad := bad || format('verified=true 行数=%s(期望0); ', n_ver); end if;

  select count(*) into n_rm from migration.row_manifest where batch = 'DB-4';
  if n_rm <> 7 then bad := bad || format('DB-4 batch row_manifest=%s(期望7); ', n_rm); end if;

  select count(*) into n_adm from migration.admin_role_migration_manifest;
  if n_adm <> 0 then bad := bad || format('admin_role_migration_manifest=%s(期望0); ', n_adm); end if;

  select count(*) into n_u from auth.users;
  select count(*) into n_p from public.profiles;
  select count(*) into n_r from public.user_roles;
  if (n_u, n_p, n_r) is distinct from (1, 1, 1) then
    bad := bad || format('身份基线被改动 (users=%s, profiles=%s, roles=%s); ', n_u, n_p, n_r); end if;

  -- 28 张 app_* 业务表必须仍然全为 0 行
  select coalesce(sum(cnt), 0) into n_app from (
    select (xpath('/row/c/text()',
             query_to_xml(format('select count(*) as c from public.%I', c.relname),
                          false, true, '')))[1]::text::int as cnt
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'app\_%'
  ) t;
  if n_app <> 0 then bad := bad || format('app_* 业务表总行数=%s(期望0); ', n_app); end if;

  if bad <> '' then
    raise exception 'DB-4 事务内断言失败，整体回滚: %', bad;
  end if;

  raise notice 'DB-4 事务内断言全过：crosswalk=7/7 unresolved · row_manifest(DB-4)=7 · admin_manifest=0 · 身份 1/1/1 · app_* 合计 0 行';
end $$;

commit;

select 'DB-4|COMMITTED' as result;
