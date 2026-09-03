-- ============================================================
-- 0015_student_number_states · 学号状态模型 + 纯行政误录纠错（双人控制）
--
-- 甲方决策（2026-09-03）：把两个被混为一谈的业务事件彻底分开。
--
--   A｜真实使用过的学号 —— 该号确实由 AMAS 总校分配给该学生。无论此后换号、退学、
--      注销账号还是状态变化，都是历史身份标识，**永久占用**，状态记为 retired。
--
--   B｜纯行政误录 —— 总校分配的是 AMAS0013，registrar 手误录成 AMAS0012；
--      AMAS0012 从未真正属于该学生。允许 void_clerical_error 使其重回可分配状态。
--
-- 因此弃用含义模糊的 released_*（它同时被用来表示"旧号废弃"和"错误录入撤销"）。
--
-- 状态模型：
--   reserved / assigned / retired          → 永久占用号码
--   voided_clerical_error                  → 保留历史，但不再占用分配资格
--
-- 唯一性因此从"主键"改为"部分唯一索引"：同一号码可以有多行历史，
-- 但处于占用态的行至多一行。旧的 registry / history 记录一律保留，绝不删除。
--
-- 刻意不采用"建档后 N 小时内可释放"作为判据：
--   建档 2 小时后已真实使用过号码 ≠ 可以释放；
--   建档 4 天后才发现纯录入错误 ≠ 不能纠正。
-- 真正的边界是「是否仍处于 pre_enrolled，且该号从未成为真实正式身份」。
-- 时间只记录、只用于异常检测，不作决定性规则。
--
-- 双人控制：释放一个曾出现过的学号属于身份标识级高风险操作，不得由单个管理员静默完成。
--   registrar 发起 → super_admin 确认，或 super_admin 发起 → registrar 确认；
--   发起人与确认人不得为同一人，且两者之中必须有 super_admin。
-- ============================================================

do $$ begin
  create type student_number_state as enum
    ('reserved','assigned','retired','voided_clerical_error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type number_void_status as enum ('pending','approved','rejected','cancelled');
exception when duplicate_object then null; end $$;

-- ============================================================
-- 1. registry 结构调整
-- ============================================================
-- student_records 不能再外键引用 normalized（该列不再唯一）；
-- student_records.student_number_normalized 自身的 unique 约束仍在，一人一号不变。
alter table public.student_records
  drop constraint if exists student_records_student_number_normalized_fkey;

alter table public.student_number_registry
  add column if not exists id uuid not null default gen_random_uuid(),
  add column if not exists state student_number_state not null default 'assigned',
  add column if not exists retired_at timestamptz,
  add column if not exists retire_reason text,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references public.profiles(id) on delete set null,
  add column if not exists void_reason text,
  add column if not exists void_evidence_reference text,
  add column if not exists replacement_normalized text;

-- 历史数据迁移：旧的 released_* 语义一律视为 A 类（真实用过 → retired）。
-- 保守方向：宁可多占用一个号，也不能把真实身份标识错误地释放出去。
update public.student_number_registry
   set state = 'retired',
       retired_at = coalesce(retired_at, released_at),
       retire_reason = coalesce(retire_reason, release_reason)
 where released_at is not null and state = 'assigned';

alter table public.student_number_registry drop constraint if exists student_number_registry_pkey;
alter table public.student_number_registry add primary key (id);
alter table public.student_number_registry drop column if exists released_at;
alter table public.student_number_registry drop column if exists release_reason;

-- ★ 唯一性规则：只有占用态才阻止再分配；voided_clerical_error 不占用
drop index if exists public.student_number_occupied_unique;
create unique index student_number_occupied_unique
  on public.student_number_registry (normalized)
  where state in ('reserved','assigned','retired');

create index if not exists student_number_by_normalized
  on public.student_number_registry (normalized, state);

comment on table public.student_number_registry is
  '学号登记簿。reserved/assigned/retired 永久占用号码；voided_clerical_error 只保留历史、不占用。
   历史行永不删除；释放只能经 request_/approve_student_number_void 双人流程，且必须是纯行政误录。';
comment on column public.student_number_registry.state is
  'reserved|assigned|retired 占用；voided_clerical_error 不占用（纯行政误录已撤销）';

-- ============================================================
-- 2. 不可逆正式业务记录检查（纠错条件 7）
-- ============================================================
-- 目前系统尚无成绩、学分、证书、缴费等正式业务记录，因此没有任何来源会返回 true。
-- ★ 今后**任何**产生不可逆正式记录的表（成绩单、学分认定、证书签发、收据…）
--   都必须在此登记，否则纠错流程会漏判、把已产生正式效力的学号错误释放。
create or replace function public.student_number_has_irreversible_records(p_normalized text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_hit boolean := false;
begin
  -- 已进入 active 的学籍本身就是不可逆的正式身份
  select exists (
    select 1 from public.student_records s
     where s.student_number_normalized = p_normalized
       and (s.status = 'active' or s.activated_at is not null)
  ) into v_hit;
  if v_hit then return true; end if;

  -- 曾经进入过 active 的历史同样构成正式身份（即便当前被改回其他状态）
  select exists (
    select 1 from public.student_status_history h
      join public.student_records s on s.id = h.student_id
     where s.student_number_normalized = p_normalized and h.to_status = 'active'
  ) into v_hit;
  return v_hit;

  -- 【扩展点】成绩 / 学分 / 证书 / 缴费等表建立后，必须在此追加检查。
end $$;
revoke execute on function public.student_number_has_irreversible_records(text) from public, anon, authenticated;
grant execute on function public.student_number_has_irreversible_records(text) to service_role;

-- ============================================================
-- 3. 纠错申请表（双人控制的载体）
-- ============================================================
create table if not exists public.student_number_void_requests (
  id                     uuid primary key default gen_random_uuid(),
  student_id             uuid not null references public.student_records(id) on delete cascade,
  wrong_original         text not null,
  wrong_normalized       text not null,
  replacement_original   text not null,
  replacement_normalized text not null,
  reason                 text not null,
  evidence_reference     text not null,      -- 条件 6：HQ/registrar 依据，证明是录入错误而非重新分配
  status                 number_void_status not null default 'pending',
  initiated_by           uuid references public.profiles(id) on delete set null,
  initiated_at           timestamptz not null default now(),
  decided_by             uuid references public.profiles(id) on delete set null,
  decided_at             timestamptz,
  decision_note          text
);
comment on table public.student_number_void_requests is
  '学号纯行政误录纠错申请。发起与确认必须是不同的人，且两者之中须有 super_admin。';

-- 同一学生同时只能有一份待确认申请
create unique index if not exists snvr_one_pending
  on public.student_number_void_requests (student_id) where status = 'pending';
create index if not exists snvr_by_status
  on public.student_number_void_requests (status, initiated_at desc);

alter table public.student_number_void_requests enable row level security;
revoke all on public.student_number_void_requests from anon, authenticated;
grant select (id, student_id, wrong_original, replacement_original, reason, evidence_reference,
              status, initiated_by, initiated_at, decided_by, decided_at)
  on public.student_number_void_requests to authenticated;
drop policy if exists snvr_admin_select on public.student_number_void_requests;
create policy snvr_admin_select on public.student_number_void_requests
  for select to authenticated using (public.is_admin_any(auth.uid()));

-- registry 依旧对所有客户端完全不可读（避免全量学号被拉走）
revoke all on public.student_number_registry from anon, authenticated;

-- ============================================================
-- 4. 既有 RPC 适配新状态模型
-- ============================================================
-- 建档：登记为 assigned；冲突判定改由部分唯一索引给出
create or replace function public.create_student_record(
  p_app uuid, p_actor uuid,
  p_student_number text default null,
  p_program_code text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.applications;
  hq public.application_hq_approvals;
  v_norm text; v_program text; v_id uuid; v_other int;
begin
  perform set_config('amas.rpc_context', 'student', true);
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;

  select * into a from public.applications where id = p_app for update;
  if not found then raise exception 'not_found'; end if;
  if a.status <> 'accepted' then raise exception 'application not accepted'; end if;

  select * into hq from public.application_hq_approvals where application_id = p_app for update;
  if not found or hq.status <> 'approved' then
    return jsonb_build_object('ok', false, 'error', 'hq_approval_required');
  end if;

  if exists (select 1 from public.student_records where user_id = a.applicant_id) then
    return jsonb_build_object('ok', false, 'error', 'student_already_exists');
  end if;

  v_norm := public.normalize_student_number(p_student_number);
  if v_norm is not null then
    begin
      insert into public.student_number_registry (normalized, original, first_assigned_to, state)
      values (v_norm, p_student_number, a.applicant_id, 'assigned');
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'student_number_taken');
    end;
  end if;

  v_program := coalesce(p_program_code, a.form_data #>> '{programs,0}');
  if v_program is not null and not exists (select 1 from public.program_catalog where code = v_program) then
    raise exception 'unknown program %', v_program;
  end if;

  insert into public.student_records
    (user_id, application_id, status, student_number, student_number_normalized,
     program_code, pathway, hq_approval_reference, created_by)
  values (a.applicant_id, p_app, 'pre_enrolled', p_student_number, v_norm,
          v_program, a.pathway, hq.approval_reference, p_actor)
  returning id into v_id;

  insert into public.student_status_history (student_id, from_status, to_status, actor_id, actor_role)
  values (v_id, null, 'pre_enrolled', p_actor, 'admin');

  insert into public.user_roles (user_id, role, granted_by)
  values (a.applicant_id, 'student', p_actor) on conflict do nothing;

  if v_norm is not null then
    insert into public.login_aliases (user_id, alias_type, alias_normalized, created_by)
    values (a.applicant_id, 'student_number', v_norm, p_actor)
    on conflict (alias_normalized) do nothing;
  end if;

  select count(*) into v_other from public.applications
   where applicant_id = a.applicant_id and id <> p_app
     and status not in ('rejected','withdrawn');
  if v_other = 0 then
    update public.user_roles set revoked_at = now()
     where user_id = a.applicant_id and role = 'applicant' and revoked_at is null;
  end if;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_actor, 'admin', 'student_record_created', 'student_records', v_id::text, 'academic',
          jsonb_build_object('application', p_app),
          jsonb_build_object('status','pre_enrolled','student_number', p_student_number,
                             'program', v_program, 'applicant_role_revoked', v_other = 0),
          hq.approval_reference);

  return jsonb_build_object('ok', true, 'student_id', v_id, 'status', 'pre_enrolled',
                            'applicant_role_revoked', v_other = 0);
end $$;
revoke execute on function public.create_student_record(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.create_student_record(uuid,uuid,text,text) to service_role;

-- 换号（A 类）：旧号 → retired，永久占用；这不是纠错通道
create or replace function public.correct_student_number(
  p_student uuid, p_actor uuid, p_new_number text, p_reason text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.student_records; v_norm text;
begin
  perform set_config('amas.rpc_context', 'student', true);
  if not public.is_admin_any(p_actor) then raise exception 'actor lacks admin role'; end if;
  if coalesce(trim(p_reason),'') = '' then raise exception 'reason required'; end if;

  v_norm := public.normalize_student_number(p_new_number);
  if v_norm is null then raise exception 'student number required'; end if;

  select * into s from public.student_records where id = p_student for update;
  if not found then raise exception 'not_found'; end if;
  if s.student_number_normalized is not distinct from v_norm then
    return jsonb_build_object('ok', false, 'error', 'unchanged');
  end if;

  begin
    insert into public.student_number_registry (normalized, original, first_assigned_to, state)
    values (v_norm, p_new_number, s.user_id, 'assigned');
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'student_number_taken');
  end;

  -- 旧号：真实使用过 → retired（永久占用）。纯行政误录请走 void 流程，不要走这里。
  if s.student_number_normalized is not null then
    update public.student_number_registry
       set state = 'retired', retired_at = now(), retire_reason = p_reason
     where normalized = s.student_number_normalized
       and state in ('reserved','assigned');
    update public.login_aliases set revoked_at = now()
     where alias_normalized = s.student_number_normalized and revoked_at is null;
  end if;

  update public.student_records
     set student_number = p_new_number, student_number_normalized = v_norm
   where id = p_student;

  insert into public.login_aliases (user_id, alias_type, alias_normalized, created_by)
  values (s.user_id, 'student_number', v_norm, p_actor)
  on conflict (alias_normalized) do nothing;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_actor, 'admin', 'student_number_corrected', 'student_records', p_student::text, 'academic',
          jsonb_build_object('student_number', s.student_number, 'old_state', 'retired'),
          jsonb_build_object('student_number', p_new_number), p_reason);

  return jsonb_build_object('ok', true, 'student_number', p_new_number, 'old_number_state', 'retired');
end $$;
revoke execute on function public.correct_student_number(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.correct_student_number(uuid,uuid,text,text) to service_role;

-- ============================================================
-- 5. 纠错流程：发起
-- ============================================================
create or replace function public.request_student_number_void(
  p_student uuid, p_actor uuid, p_replacement_number text, p_reason text, p_evidence text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s public.student_records;
  v_new text; v_id uuid;
begin
  -- 发起人必须是 registrar 或 super_admin
  if not (public.has_active_role(p_actor,'registrar') or public.has_active_role(p_actor,'super_admin')) then
    raise exception 'actor lacks admin role';
  end if;
  if coalesce(trim(p_reason),'')   = '' then raise exception 'reason required'; end if;
  if coalesce(trim(p_evidence),'') = '' then raise exception 'evidence required'; end if;   -- 条件 6

  v_new := public.normalize_student_number(p_replacement_number);
  if v_new is null then raise exception 'replacement number required'; end if;              -- 条件 3

  select * into s from public.student_records where id = p_student for update;
  if not found then raise exception 'not_found'; end if;
  if s.student_number_normalized is null then
    return jsonb_build_object('ok', false, 'error', 'no_current_number');
  end if;
  if s.student_number_normalized = v_new then
    return jsonb_build_object('ok', false, 'error', 'unchanged');
  end if;

  -- 条件 1 / 2：仍是 pre_enrolled，且从未进入过 active
  if s.status <> 'pre_enrolled' then
    return jsonb_build_object('ok', false, 'error', 'student_not_pre_enrolled', 'status', s.status);
  end if;
  -- 条件 7（含"曾经 active"判定）
  if public.student_number_has_irreversible_records(s.student_number_normalized) then
    return jsonb_build_object('ok', false, 'error', 'number_has_official_records');
  end if;

  -- 替代号必须当前可分配
  if exists (select 1 from public.student_number_registry
              where normalized = v_new and state in ('reserved','assigned','retired')) then
    return jsonb_build_object('ok', false, 'error', 'replacement_number_taken');
  end if;

  begin
    insert into public.student_number_void_requests
      (student_id, wrong_original, wrong_normalized, replacement_original, replacement_normalized,
       reason, evidence_reference, initiated_by)
    values (p_student, s.student_number, s.student_number_normalized, p_replacement_number, v_new,
            p_reason, p_evidence, p_actor)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'request_already_pending');
  end;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_actor, 'admin', 'student_number_void_requested', 'student_records', p_student::text, 'academic',
          jsonb_build_object('student_number', s.student_number),
          jsonb_build_object('replacement', p_replacement_number, 'evidence', p_evidence,
                             'request_id', v_id), p_reason);

  return jsonb_build_object('ok', true, 'request_id', v_id, 'status', 'pending');
end $$;
revoke execute on function public.request_student_number_void(uuid,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.request_student_number_void(uuid,uuid,text,text,text) to service_role;

-- ============================================================
-- 6. 纠错流程：确认（第二人）—— 全部条件在此原子重验
-- ============================================================
create or replace function public.approve_student_number_void(
  p_request uuid, p_actor uuid, p_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  r public.student_number_void_requests;
  s public.student_records;
begin
  perform set_config('amas.rpc_context', 'student', true);

  if not (public.has_active_role(p_actor,'registrar') or public.has_active_role(p_actor,'super_admin')) then
    raise exception 'actor lacks admin role';
  end if;

  select * into r from public.student_number_void_requests where id = p_request for update;
  if not found then raise exception 'not_found'; end if;
  if r.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'invalid_state', 'status', r.status);
  end if;

  -- ★ 双人控制：发起人与确认人不得为同一人
  if r.initiated_by is not null and r.initiated_by = p_actor then
    return jsonb_build_object('ok', false, 'error', 'same_actor_not_allowed');
  end if;
  -- ★ 两者之中必须有 super_admin（registrar↔super_admin 两种顺序都满足）
  if not (public.has_active_role(p_actor,'super_admin')
          or (r.initiated_by is not null and public.has_active_role(r.initiated_by,'super_admin'))) then
    return jsonb_build_object('ok', false, 'error', 'super_admin_required');
  end if;

  select * into s from public.student_records where id = r.student_id for update;
  if not found then raise exception 'not_found'; end if;

  -- 条件在确认时刻再验一次：申请提交后学生可能已被激活
  if s.status <> 'pre_enrolled' then
    return jsonb_build_object('ok', false, 'error', 'student_not_pre_enrolled', 'status', s.status);
  end if;
  if s.student_number_normalized is distinct from r.wrong_normalized then
    return jsonb_build_object('ok', false, 'error', 'number_changed_since_request');
  end if;
  if public.student_number_has_irreversible_records(r.wrong_normalized) then
    return jsonb_build_object('ok', false, 'error', 'number_has_official_records');
  end if;

  -- 替代号登记：与其他管理员并发抢同一号码时，只有一个能成功（部分唯一索引裁决）
  begin
    insert into public.student_number_registry (normalized, original, first_assigned_to, state)
    values (r.replacement_normalized, r.replacement_original, s.user_id, 'assigned');
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'replacement_number_taken');
  end;

  -- 误录号：保留历史行，改为不占用态；绝不删除
  update public.student_number_registry
     set state = 'voided_clerical_error',
         voided_at = now(), voided_by = p_actor,
         void_reason = r.reason, void_evidence_reference = r.evidence_reference,
         replacement_normalized = r.replacement_normalized
   where normalized = r.wrong_normalized
     and state in ('reserved','assigned');

  -- 别名同事务更新
  update public.login_aliases set revoked_at = now()
   where alias_normalized = r.wrong_normalized and revoked_at is null;
  insert into public.login_aliases (user_id, alias_type, alias_normalized, created_by)
  values (s.user_id, 'student_number', r.replacement_normalized, p_actor)
  on conflict (alias_normalized) do nothing;

  update public.student_records
     set student_number = r.replacement_original,
         student_number_normalized = r.replacement_normalized
   where id = r.student_id;

  update public.student_number_void_requests
     set status = 'approved', decided_by = p_actor, decided_at = now(), decision_note = p_note
   where id = p_request;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_actor, 'admin', 'student_number_void_approved', 'student_records', r.student_id::text, 'academic',
          jsonb_build_object('student_number', r.wrong_original, 'state', 'voided_clerical_error'),
          jsonb_build_object('student_number', r.replacement_original, 'state', 'assigned',
                             'request_id', p_request, 'initiated_by', r.initiated_by,
                             'evidence', r.evidence_reference),
          r.reason);

  return jsonb_build_object('ok', true, 'student_number', r.replacement_original,
                            'voided_number', r.wrong_original);
end $$;
revoke execute on function public.approve_student_number_void(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.approve_student_number_void(uuid,uuid,text) to service_role;

-- ============================================================
-- 7. 纠错流程：驳回 / 撤回
-- ============================================================
create or replace function public.reject_student_number_void(
  p_request uuid, p_actor uuid, p_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.student_number_void_requests;
begin
  if not (public.has_active_role(p_actor,'registrar') or public.has_active_role(p_actor,'super_admin')) then
    raise exception 'actor lacks admin role';
  end if;
  select * into r from public.student_number_void_requests where id = p_request for update;
  if not found then raise exception 'not_found'; end if;
  if r.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', 'invalid_state', 'status', r.status);
  end if;

  -- 发起人可以撤回自己的申请；他人只能驳回
  update public.student_number_void_requests
     set status = case when r.initiated_by = p_actor then 'cancelled' else 'rejected' end,
         decided_by = p_actor, decided_at = now(), decision_note = p_note
   where id = p_request;

  insert into public.audit_logs (actor_id, actor_role, event_type, target_type, target_id, category,
                                 old_value, new_value, reason)
  values (p_actor, 'admin',
          case when r.initiated_by = p_actor then 'student_number_void_cancelled'
               else 'student_number_void_rejected' end,
          'student_records', r.student_id::text, 'academic',
          jsonb_build_object('status','pending'),
          jsonb_build_object('request_id', p_request), p_note);

  return jsonb_build_object('ok', true,
    'status', case when r.initiated_by = p_actor then 'cancelled' else 'rejected' end);
end $$;
revoke execute on function public.reject_student_number_void(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.reject_student_number_void(uuid,uuid,text) to service_role;

-- ============================================================
-- 8. 管理端查询：待确认的纠错申请
-- ============================================================
create or replace function public.pending_number_void_requests()
returns table (
  id uuid, student_id uuid, display_name text,
  wrong_original text, replacement_original text,
  reason text, evidence_reference text,
  initiated_by uuid, initiator_name text, initiated_at timestamptz,
  can_i_approve boolean
)
language sql stable security definer set search_path = '' as $$
  select r.id, r.student_id, p.display_name,
         r.wrong_original, r.replacement_original,
         r.reason, r.evidence_reference,
         r.initiated_by, ip.display_name, r.initiated_at,
         -- 前端据此隐藏按钮；真正的门禁在 approve RPC 内，不依赖这一列
         (r.initiated_by is distinct from auth.uid())
           and (public.has_active_role(auth.uid(),'super_admin')
                or (r.initiated_by is not null and public.has_active_role(r.initiated_by,'super_admin')))
  from public.student_number_void_requests r
  join public.student_records s on s.id = r.student_id
  join public.profiles p on p.id = s.user_id
  left join public.profiles ip on ip.id = r.initiated_by
  where r.status = 'pending' and public.is_admin_any(auth.uid())
  order by r.initiated_at;
$$;
revoke execute on function public.pending_number_void_requests() from public, anon;
grant execute on function public.pending_number_void_requests() to authenticated;
