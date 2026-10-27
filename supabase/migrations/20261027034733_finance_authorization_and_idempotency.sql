-- Finance API: minimal people data, server aggregates, bounded detail pages,
-- transactional idempotency, and the same MFA switch as the portal.
-- No existing entries are changed or deleted.
create schema if not exists amas_private;
revoke all on schema amas_private from public, anon, authenticated;
create table if not exists amas_private.finance_requests (
  id uuid primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  operation text not null check (operation in ('record','void')),
  payload jsonb not null,
  result jsonb,
  created_at timestamptz not null default now()
);
create index if not exists finance_requests_actor on amas_private.finance_requests(actor_id) where actor_id is not null;
alter table amas_private.finance_requests enable row level security;
revoke all on amas_private.finance_requests from public, anon, authenticated;
alter table public.finance_entries add column if not exists request_id uuid
  references amas_private.finance_requests(id) on delete restrict;
create unique index if not exists finance_entries_request_person
  on public.finance_entries(request_id, submission_id) where request_id is not null;
create index if not exists finance_entries_cursor on public.finance_entries(created_at desc, id desc);

create or replace function amas_private.finance_request_identity_guard()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.request_id is distinct from old.request_id then raise exception 'finance request identity is immutable';end if;
 return new;
end $$;
revoke all on function amas_private.finance_request_identity_guard() from public,anon,authenticated;
drop trigger if exists finance_request_identity on public.finance_entries;
create trigger finance_request_identity before update on public.finance_entries
 for each row execute function amas_private.finance_request_identity_guard();

create or replace function amas_private.finance_actor()
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid();
begin
  if actor is null or not public.is_finance_staff(actor) then
    raise exception using errcode='42501', message='forbidden';
  end if;
  if not public.request_is_aal2() then
    raise exception using errcode='42501', message='mfa_required';
  end if;
  return actor;
end $$;
revoke all on function amas_private.finance_actor() from public, anon, authenticated;

-- RLS cannot restrict columns by application role. Finance no longer reads the
-- raw submissions row; only the explicitly projected API below is available.
drop policy if exists sub_finance_select on public.submissions;
-- Block bypassing the transactional API even when a role is otherwise valid.
revoke insert, update, delete on public.finance_entries from anon, authenticated;
drop policy if exists fe_select on public.finance_entries;
create policy fe_select on public.finance_entries for select to authenticated
 using ((select public.is_finance_staff(auth.uid()) and public.request_is_aal2()));

create or replace function public.finance_people_page(p_after bigint default 0, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; lim int := least(greatest(coalesce(p_limit,200),1),200);
begin
  perform amas_private.finance_actor();
  if p_after is null or p_after < 0 then raise exception 'invalid cursor'; end if;
  with candidates as (
    select s.id,s.name,s.cohort from public.submissions s
     where s.id > p_after and (s.type='application' or exists(select 1 from public.finance_entries e where e.submission_id=s.id))
     order by s.id limit lim+1
  ), page as (select * from candidates order by id limit lim), sums as (
    select e.submission_id,e.currency,
      sum(case when e.kind='charge' then e.amount else 0 end) charge,
      sum(case when e.kind='payment' then e.amount else 0 end) payment,
      sum(case when e.kind='waiver' then e.amount else 0 end) waiver,
      sum(case when e.kind='refund' then e.amount else 0 end) refund
    from public.finance_entries e join page p on p.id=e.submission_id
    where e.voided_at is null group by e.submission_id,e.currency
  ), balances as (
    select submission_id,jsonb_object_agg(currency,jsonb_build_object('charge',charge,'payment',payment,'waiver',waiver,'refund',refund)) value
      from sums group by submission_id
  ) select jsonb_build_object('rows',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'cohort',p.cohort,'balances',coalesce(b.value,'{}'::jsonb)) order by p.id) from page p left join balances b on b.submission_id=p.id),'[]'::jsonb),
     'next_after',case when (select count(*) from candidates)>lim then (select max(id) from page) else null end) into result;
  return result;
end $$;

create or replace function public.finance_totals(p_cohort text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  perform amas_private.finance_actor();
  select coalesce(jsonb_object_agg(currency,to_jsonb(t)-'currency'),'{}'::jsonb) into result from (
    select e.currency,
      sum(case when e.kind='charge' then e.amount else 0 end) charge,
      sum(case when e.kind='payment' then e.amount else 0 end) payment,
      sum(case when e.kind='waiver' then e.amount else 0 end) waiver,
      sum(case when e.kind='refund' then e.amount else 0 end) refund
    from public.finance_entries e join public.submissions s on s.id=e.submission_id
    where e.voided_at is null and (p_cohort is null or s.cohort=p_cohort) group by e.currency
  ) t;
  return result;
end $$;

create or replace function public.finance_entries_page(
  p_before_created timestamptz default null, p_before_id uuid default null,
  p_snapshot timestamptz default null, p_cohort text default null,
  p_submission bigint default null, p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; lim int := least(greatest(coalesce(p_limit,100),1),200);
  snapshot timestamptz := coalesce(p_snapshot,statement_timestamp());
begin
  perform amas_private.finance_actor();
  if (p_before_created is null) <> (p_before_id is null) then raise exception 'invalid cursor'; end if;
  with candidates as (
    select e.id,e.submission_id,e.kind,e.category,e.amount,e.currency,e.occurred_on,e.method,e.reference,e.note,
           e.created_at,e.voided_at,e.void_reason
    from public.finance_entries e join public.submissions s on s.id=e.submission_id
    where e.created_at<=snapshot and (p_cohort is null or s.cohort=p_cohort)
      and (p_submission is null or e.submission_id=p_submission)
      and (p_before_created is null or (e.created_at,e.id)<(p_before_created,p_before_id))
    order by e.created_at desc,e.id desc limit lim+1
  ), page as (select * from candidates order by created_at desc,id desc limit lim)
  select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc,p.id desc) from page p),'[]'::jsonb),
    'snapshot',snapshot,'next',case when (select count(*) from candidates)>lim then
      (select jsonb_build_object('created_at',created_at,'id',id) from page order by created_at,id limit 1) else null end) into result;
  return result;
end $$;

create or replace function public.finance_record(p_request uuid, p_entries jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
<<record_op>>
declare actor uuid; canonical jsonb; n int; existing amas_private.finance_requests%rowtype; result jsonb;
begin
  actor := amas_private.finance_actor();
  if p_request is null or jsonb_typeof(p_entries) is distinct from 'array' then
    return jsonb_build_object('ok',false,'error','validation_failed');
  end if;
  n := jsonb_array_length(p_entries);
  if n<1 or n>500 or exists(select 1 from jsonb_array_elements(p_entries) e where jsonb_typeof(e) is distinct from 'object') then
    return jsonb_build_object('ok',false,'error','validation_failed');
  end if;
  select jsonb_agg(jsonb_build_object('submission_id',submission_id,'kind',kind,'category',coalesce(nullif(btrim(category),''),'学费'),
    'amount',amount,'currency',currency,'occurred_on',occurred_on,'method',coalesce(method,''),'reference',coalesce(reference,''),'note',coalesce(note,'')) order by submission_id)
    into canonical from jsonb_to_recordset(p_entries) as r(submission_id bigint,kind text,category text,amount numeric,currency text,occurred_on date,method text,reference text,note text);
  if (select count(distinct (e->>'submission_id')::bigint) from jsonb_array_elements(canonical) e)<>n
    or exists(select 1 from jsonb_to_recordset(canonical) as r(submission_id bigint,kind text,amount numeric,currency text,occurred_on date)
      where submission_id is null or kind is null or kind not in ('charge','payment','waiver','refund')
      or amount is null or amount<=0 or amount>=10000000 or amount<>round(amount,2)
      or currency is null or currency not in ('THB','CNY','USD') or occurred_on is null
      or not exists(select 1 from public.submissions s where s.id=r.submission_id and s.type='application')) then
    return jsonb_build_object('ok',false,'error','validation_failed');
  end if;
  -- Concurrent retries block on the primary key. A changed payload/actor never
  -- reuses another operation's result, and all inserts commit in one transaction.
  insert into amas_private.finance_requests(id,actor_id,operation,payload)
    values(p_request,actor,'record',canonical) on conflict(id) do nothing;
  select * into existing from amas_private.finance_requests where id=p_request for update;
  if existing.actor_id is distinct from actor or existing.operation<>'record' or existing.payload<>canonical then
    return jsonb_build_object('ok',false,'error','request_conflict');
  end if;
  if existing.result is not null then return existing.result; end if;
  with written as (
    insert into public.finance_entries(submission_id,kind,category,amount,currency,occurred_on,method,reference,note,batch_id,created_by,request_id)
      select submission_id,kind,category,amount,currency,occurred_on,method,reference,note,
        case when n>1 then p_request else null end,actor,p_request
      from jsonb_to_recordset(canonical) as r(submission_id bigint,kind text,category text,amount numeric,currency text,occurred_on date,method text,reference text,note text)
      returning id
  ) select jsonb_build_object('ok',true,'count',count(*),'ids',jsonb_agg(id)) into result from written;
  update amas_private.finance_requests set result=record_op.result where id=p_request;
  insert into public.audit_logs(actor_id,event_type,target_type,target_id,category,new_value)
    values(actor,'finance.record','finance_request',p_request::text,'finance',jsonb_build_object('count',n,'ids',result->'ids'));
  return result;
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or check_violation or not_null_violation then
  return jsonb_build_object('ok',false,'error','validation_failed');
end $$;

create or replace function public.finance_void(p_request uuid,p_entry uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
<<void_op>>
declare actor uuid; payload jsonb; existing amas_private.finance_requests%rowtype; result jsonb; entry public.finance_entries%rowtype;
begin
  actor := amas_private.finance_actor();
  if p_request is null or p_entry is null or coalesce(length(btrim(p_reason)),0) not between 1 and 500 then
    return jsonb_build_object('ok',false,'error','reason_required');
  end if;
  payload := jsonb_build_object('entry',p_entry,'reason',btrim(p_reason));
  insert into amas_private.finance_requests(id,actor_id,operation,payload)
    values(p_request,actor,'void',payload) on conflict(id) do nothing;
  select * into existing from amas_private.finance_requests where id=p_request for update;
  if existing.actor_id is distinct from actor or existing.operation<>'void' or existing.payload<>payload then
    return jsonb_build_object('ok',false,'error','request_conflict');
  end if;
  if existing.result is not null then return existing.result; end if;
  select * into entry from public.finance_entries where id=p_entry for update;
  if not found then result:=jsonb_build_object('ok',false,'error','not_found');
  elsif entry.voided_at is not null then result:=jsonb_build_object('ok',false,'error','already_voided');
  else
    update public.finance_entries set voided_at=now(),void_reason=btrim(p_reason) where id=p_entry;
    result:=jsonb_build_object('ok',true,'count',1);
    insert into public.audit_logs(actor_id,event_type,target_type,target_id,category,reason)
      values(actor,'finance.void','finance_entry',p_entry::text,'finance',btrim(p_reason));
  end if;
  update amas_private.finance_requests set result=void_op.result where id=p_request;
  return result;
end $$;

-- Explicit API grants; no helper or idempotency ledger is client-readable.
revoke all on function public.finance_people_page(bigint,int),public.finance_totals(text),
 public.finance_entries_page(timestamptz,uuid,timestamptz,text,bigint,int),
 public.finance_record(uuid,jsonb),public.finance_void(uuid,uuid,text) from public,anon;
grant execute on function public.finance_people_page(bigint,int),public.finance_totals(text),
 public.finance_entries_page(timestamptz,uuid,timestamptz,text,bigint,int),
 public.finance_record(uuid,jsonb),public.finance_void(uuid,uuid,text) to authenticated;
