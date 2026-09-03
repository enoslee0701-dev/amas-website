-- ============================================================
-- 0018_irreversible_record_registry · PORTAL-2B 2B-11
--
-- 背景：0015 的学号纠错依赖 student_number_has_irreversible_records() 判断
--   "这个学号是否已经产生了不可逆的正式记录"。当时那个函数里只有两条检查，
--   靠一句注释提醒"今后新增正式记录表要来这里加"。
--   **安全机制不能靠开发者记得。** 一旦有人新建 grades 表却忘了登记，
--   纠错流程会静默漏判，把已产生正式效力的学号释放出去——而且不会有任何报错。
--
-- 本迁移把它升级为**强制接口**：
--   1. 建立 irreversible_record_sources 登记表：每一类正式记录必须在此登记，
--      说明它是否构成学号的不可逆记录、以及如何检查。
--   2. 检查函数改为**遍历登记表**动态求值，不再写死。
--   3. 建立 guard：任何"看起来像正式记录"的新表若未登记，自动化测试立即失败
--      （见 supabase/tests/portal2b_irreversible_guard.sql）。
--
-- 刻意不做动态插件系统：登记表 + 一条会失败的测试，已经足以让遗漏无法静默通过。
-- ============================================================

do $$ begin
  create type irreversible_verdict as enum ('yes','no','pending_decision');
exception when duplicate_object then null; end $$;

create table if not exists public.irreversible_record_sources (
  source_key    text primary key,            -- 稳定标识，例：'grades'
  table_name    text,                        -- 对应的表（尚未建立时可空）
  record_kind   text not null,               -- grade | earned_credit | transcript | certificate |
                                             -- financial_receipt | graduation_record | official_enrollment | other
  is_irreversible irreversible_verdict not null,
  -- 当 is_irreversible='yes' 时必须给出判定 SQL：接受一个 normalized 学号，返回 boolean
  check_sql     text,
  rationale     text not null,               -- 为什么是/不是不可逆记录
  registered_by text not null,               -- 登记它的 migration 编号
  registered_at timestamptz not null default now(),
  constraint irr_needs_check
    check (is_irreversible <> 'yes' or (check_sql is not null and table_name is not null))
);
comment on table public.irreversible_record_sources is
  '正式业务记录登记簿（2B-11）。凡新增 grade / earned_credit / transcript / certificate / '
  'financial_receipt / graduation_record / official enrollment 类记录的 migration，'
  '必须在此登记并回答"它是否构成 student number 的不可逆记录"。'
  '未登记会被 portal2b_irreversible_guard.sql 检出并使验收失败。';

revoke all on public.irreversible_record_sources from anon, authenticated;
alter table public.irreversible_record_sources enable row level security;

-- ---------- 当前已知来源 ----------
insert into public.irreversible_record_sources
  (source_key, table_name, record_kind, is_irreversible, check_sql, rationale, registered_by)
values
  ('student_active_status', 'student_records', 'official_enrollment', 'yes',
   $chk$select exists (select 1 from public.student_records s
                        where s.student_number_normalized = $1
                          and (s.status = 'active' or s.activated_at is not null))$chk$,
   '学籍进入 active 即成为正式身份，该学号已对外生效，不可作为误录撤销。', '0018'),

  ('student_activation_history', 'student_status_history', 'official_enrollment', 'yes',
   $chk$select exists (select 1 from public.student_status_history h
                        join public.student_records s on s.id = h.student_id
                        where s.student_number_normalized = $1 and h.to_status = 'active')$chk$,
   '曾经进入过 active 同样构成正式身份，即使当前状态已变。', '0018'),

  ('applications', 'applications', 'other', 'no', null,
   '招生申请发生在建档之前，不与学号绑定，不构成学号的不可逆记录。', '0018'),

  ('course_catalog', 'course_catalog', 'other', 'no', null,
   '课程目录是全局只读参考数据，与个人学号无关。', '0018')
on conflict (source_key) do nothing;

-- ---------- 检查函数：改为遍历登记表 ----------
create or replace function public.student_number_has_irreversible_records(p_normalized text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare r record; hit boolean;
begin
  if p_normalized is null then return false; end if;

  for r in
    select source_key, check_sql from public.irreversible_record_sources
     where is_irreversible = 'yes'
  loop
    -- 登记表只有 service_role 可写，check_sql 不是用户输入
    execute r.check_sql into hit using p_normalized;
    if coalesce(hit, false) then return true; end if;
  end loop;

  -- ★ 未决状态一律按"有不可逆记录"处理：宁可拒绝一次合法纠错，
  --   也不能把已产生正式效力的学号错误释放（fail closed）。
  if exists (select 1 from public.irreversible_record_sources
              where is_irreversible = 'pending_decision') then
    return true;
  end if;

  return false;
end $$;
revoke execute on function public.student_number_has_irreversible_records(text) from public, anon, authenticated;
grant execute on function public.student_number_has_irreversible_records(text) to service_role;

comment on function public.student_number_has_irreversible_records is
  '学号纠错的安全闸门（0018 起改为遍历 irreversible_record_sources 动态求值）。'
  '存在 pending_decision 的来源时一律 fail closed，返回 true。';
