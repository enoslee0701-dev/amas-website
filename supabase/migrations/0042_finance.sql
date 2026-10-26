-- ============================================================
-- 0042_finance · 费用管理明细
--
-- 2026-10-26 Enos：「一定需要费用管理明细的系统」。
-- 一笔一行的流水账（finance_entries）：
--   charge  应收（学费、教材费…）   payment 已收   waiver 减免   refund 退款
-- 余额 = 应收 − 已收 − 减免 + 退款，按币种分开算（THB / CNY / USD）。
-- 账目只增不删、不改金额：记错了就「作废」并写原因（voided_at / void_reason），原行留着可查。
-- 谁能记：财务、教务、教学主管、超级管理员。学员经 my_finance() 只看自己的。
-- 学员按报名记录（submissions.id）记账，这样还没建学籍的报名人也能先记；建了学籍的经 student_user_id 对到账号（0040）。
-- ============================================================

create or replace function public.is_finance_staff(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_roles r
                  where r.user_id = p_user and r.revoked_at is null
                    and (r.expires_at is null or r.expires_at > now())
                    and r.role in ('finance', 'registrar', 'academic_admin', 'super_admin'));
$$;
revoke execute on function public.is_finance_staff(uuid) from public, anon;
grant execute on function public.is_finance_staff(uuid) to authenticated, service_role;

create table if not exists public.finance_entries (
  id             uuid primary key default gen_random_uuid(),
  submission_id  bigint not null references public.submissions(id) on delete restrict,
  kind           text not null check (kind in ('charge', 'payment', 'waiver', 'refund')),
  category       text not null default '学费' check (length(btrim(category)) between 1 and 30),
  amount         numeric(12, 2) not null check (amount > 0 and amount < 10000000),
  currency       text not null default 'THB' check (currency in ('THB', 'CNY', 'USD')),
  occurred_on    date not null default current_date,
  method         text not null default '' check (method in ('', 'cash', 'bank', 'promptpay', 'wechat', 'alipay', 'other')),
  reference      text not null default '' check (length(reference) <= 80),
  note           text not null default '' check (length(note) <= 500),
  batch_id       uuid,                       -- 整班一起加的应收共用一个批次号
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  voided_at      timestamptz,
  voided_by      uuid references public.profiles(id) on delete set null,
  void_reason    text
);
create index if not exists finance_entries_by_sub on public.finance_entries (submission_id, occurred_on desc);
create index if not exists finance_entries_by_date on public.finance_entries (occurred_on desc);
comment on table public.finance_entries is '费用流水（0042）：只增不删，记错作废并写原因';

-- 只允许「作废」这一种修改；金额、对象、类型等一律不能改；不能删
create or replace function public.finance_entries_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception 'finance entries cannot be deleted; void instead'; end if;
  if old.voided_at is not null then raise exception 'entry already voided'; end if;
  if (new.submission_id, new.kind, new.category, new.amount, new.currency, new.occurred_on, new.method, new.reference, new.note, new.batch_id, new.created_by, new.created_at)
     is distinct from (old.submission_id, old.kind, old.category, old.amount, old.currency, old.occurred_on, old.method, old.reference, old.note, old.batch_id, old.created_by, old.created_at) then
    raise exception 'finance entries are append-only; void and re-enter instead';
  end if;
  if new.voided_at is null or coalesce(btrim(new.void_reason), '') = '' then raise exception 'void requires a reason'; end if;
  new.voided_by := auth.uid();
  return new;
end $$;
drop trigger if exists finance_entries_guard on public.finance_entries;
create trigger finance_entries_guard before update or delete on public.finance_entries
  for each row execute function public.finance_entries_guard();

alter table public.finance_entries enable row level security;
revoke all on public.finance_entries from anon;
revoke delete on public.finance_entries from authenticated;
drop policy if exists fe_select on public.finance_entries;
create policy fe_select on public.finance_entries for select to authenticated using (public.is_finance_staff(auth.uid()));
drop policy if exists fe_insert on public.finance_entries;
create policy fe_insert on public.finance_entries for insert to authenticated
  with check (public.is_finance_staff(auth.uid()) and voided_at is null and created_by = auth.uid());
drop policy if exists fe_void on public.finance_entries;
create policy fe_void on public.finance_entries for update to authenticated
  using (public.is_finance_staff(auth.uid())) with check (public.is_finance_staff(auth.uid()));

-- 财务人员也要能读到学员名单（报名记录）才能记账：只读姓名、班级与对应账号
drop policy if exists sub_finance_select on public.submissions;
create policy sub_finance_select on public.submissions for select to authenticated
  using (public.is_finance_staff(auth.uid()));

-- 学员看自己的账：每笔明细 + 按币种的余额（不含已作废的）
create or replace function public.my_finance()
returns jsonb language sql stable security definer set search_path = '' as $$
  with mine as (
    select e.* from public.finance_entries e
      join public.submissions s on s.id = e.submission_id
     where s.student_user_id = auth.uid() and e.voided_at is null)
  select jsonb_build_object(
    'entries', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'category', category, 'amount', amount, 'currency', currency,
                                                             'occurred_on', occurred_on, 'method', method, 'reference', reference)
                                          order by occurred_on desc, created_at desc) from mine), '[]'::jsonb),
    'balance', coalesce((select jsonb_object_agg(currency, bal) from (
                  select currency, sum(case kind when 'charge' then amount when 'refund' then amount else -amount end) bal
                    from mine group by currency) b), '{}'::jsonb));
$$;
revoke execute on function public.my_finance() from public, anon;
grant execute on function public.my_finance() to authenticated;
