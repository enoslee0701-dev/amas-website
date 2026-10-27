-- Run only in an isolated test database. Synthetic identities; rollback at end.
begin;
do $$
declare fin uuid:=gen_random_uuid(); reg uuid:=gen_random_uuid(); stu uuid:=gen_random_uuid();
 sub bigint; other_sub bigint; req uuid:=gen_random_uuid(); void_req uuid:=gen_random_uuid();
 body jsonb; result jsonb; initial jsonb; n int; e uuid; probe_entry uuid; page jsonb; cursor_time timestamptz; cursor_id uuid;
 snap timestamptz; seen uuid[]:='{}'; row jsonb;
begin
 insert into auth.users(id,email,email_confirmed_at) values(fin,'finance-new@example.invalid',now()),(reg,'registrar-new@example.invalid',now()),(stu,'student-new@example.invalid',now());
 insert into public.user_roles(user_id,role) values(fin,'finance'),(reg,'registrar'),(stu,'student');
 insert into public.submissions(type,name,contact,data,school_form,student_user_id)
 values('application','Finance Test','private-contact','{"health":"private"}','{"family":"private"}',stu) returning id into sub;
 insert into public.submissions(type,name) values('application','Other Student') returning id into other_sub;
 perform set_config('amas.test.uid',fin::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',fin,'aal','aal1')::text,true);
 execute 'set role authenticated';
 select count(*) into n from public.submissions where id=sub;
 if n<>0 then raise exception 'FAIL F01 finance can read raw application data';end if;
 begin
  insert into public.finance_entries(submission_id,kind,amount,created_by) values(sub,'charge',100,fin);
  raise exception 'FAIL F02 direct client insert bypasses controlled API';
 exception when insufficient_privilege then null;end;
 begin
  perform public.finance_record(req,'[]');raise exception 'FAIL F03 MFA enabled accepts aal1';
 exception when insufficient_privilege then null;end;
 raise notice 'PASS F01-F03 raw sensitive rows hidden, direct write revoked, MFA enabled rejects aal1';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',fin,'aal','aal2')::text,true);
 body:=jsonb_build_array(jsonb_build_object('submission_id',sub,'kind','charge','category','学费','amount',100,'currency','THB','occurred_on','2026-10-27','created_by',reg));
 initial:=public.finance_record(req,body);
 if initial->>'ok'<>'true' then raise exception 'FAIL F04 record failed %',initial;end if;
 result:=public.finance_record(req,body);
 if result<>initial then raise exception 'FAIL F05 retry did not return original result';end if;
 e:=(result->'ids'->>0)::uuid;
 select count(*) into n from public.finance_entries where request_id=req and created_by=fin;
 if n<>1 then raise exception 'FAIL F06 retry duplicates or actor spoofing accepted';end if;
 result:=public.finance_record(req,jsonb_set(body,'{0,amount}','101'));
 if result->>'error'<>'request_conflict' then raise exception 'FAIL F07 changed payload reused request';end if;
 result:=public.finance_record(gen_random_uuid(),body||jsonb_build_array(jsonb_build_object('submission_id',other_sub,'kind','charge','amount',-1,'currency','THB','occurred_on','2026-10-27')));
 if result->>'ok'<>'false' then raise exception 'FAIL F08 invalid batch accepted';end if;
 select count(*) into n from public.finance_entries;
 if n<>1 then raise exception 'FAIL F08 partial batch committed';end if;
 raise notice 'PASS F04-F08 replay is idempotent, actor is token-only, changed payload conflicts, invalid batch is atomic';
 result:=public.finance_people_page();
 if result::text like '%private%' or result::text like '%school_form%' or result::text like '%contact%' then raise exception 'FAIL F09 projection leaks sensitive fields';end if;
 if result->'rows'->0->>'name'<>'Finance Test' then raise exception 'FAIL F09 minimal people projection missing';end if;
 result:=public.finance_void(void_req,e,'重复录入');
 if result->>'ok'<>'true' or public.finance_void(void_req,e,'重复录入')<>result then raise exception 'FAIL F10 void retry failed';end if;
 if public.finance_void(gen_random_uuid(),e,'再次作废')->>'error'<>'already_voided' then raise exception 'FAIL F10 repeated independent void accepted';end if;
 if public.finance_void(gen_random_uuid(),e,'')->>'error'<>'reason_required' then raise exception 'FAIL F10 missing reason accepted';end if;
 execute 'reset role';
 begin
  insert into public.finance_entries(submission_id,kind,amount,created_by) values(other_sub,'charge',1,fin) returning id into probe_entry;
  update public.finance_entries set request_id=req,voided_at=now(),void_reason='identity mutation probe' where id=probe_entry;
  raise exception 'FAIL F10b finance request identity was mutable';
 exception when raise_exception then
  if sqlerrm<>'finance request identity is immutable' then raise;end if;
 end;
 select count(*) into n from public.audit_logs where event_type='finance.void' and target_id=e::text;
 if n<>1 then raise exception 'FAIL F10 void audit duplicated';end if;
 raise notice 'PASS F09-F10 minimal projection; void is reasoned, idempotent and audited once; request identity immutable';
 insert into public.finance_entries(submission_id,kind,amount,currency,created_by)
 select sub,'charge',1,'THB',fin from generate_series(1,1001);
 insert into public.finance_entries(submission_id,kind,amount,currency,created_by) values(other_sub,'payment',20,'CNY',fin);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',fin,'aal','aal2')::text,true);
 execute 'set role authenticated';
 result:=public.finance_totals();
 if (result->'THB'->>'charge')::numeric<>1001 or (result->'CNY'->>'payment')::numeric<>20 then raise exception 'FAIL F11 totals truncated or currencies mixed %',result;end if;
 loop
  page:=public.finance_entries_page(cursor_time,cursor_id,snap,null,null,200);
  if snap is null then snap:=(page->>'snapshot')::timestamptz;end if;
  for row in select value from jsonb_array_elements(page->'rows') loop
   if (row->>'id')::uuid=any(seen) then raise exception 'FAIL F12 duplicate page row';end if;
   seen:=array_append(seen,(row->>'id')::uuid);
  end loop;
  exit when page->'next'='null'::jsonb;
  cursor_time:=(page->'next'->>'created_at')::timestamptz;cursor_id:=(page->'next'->>'id')::uuid;
 end loop;
 if cardinality(seen)<>1003 then raise exception 'FAIL F12 missing detail rows %',cardinality(seen);end if;
 raise notice 'PASS F11-F12 >1000 records fully aggregated; stable tied-timestamp pagination has no gaps/duplicates';
 execute 'reset role';
 perform set_config('amas.test.uid',reg::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',reg,'aal','aal2')::text,true);
 execute 'set role authenticated';
 if public.finance_record(req,body)->>'error'<>'request_conflict' then raise exception 'FAIL F13 request reusable by another actor';end if;
 execute 'reset role';
 update public.user_roles set revoked_at=now() where user_id=fin and role='finance';
 perform set_config('amas.test.uid',fin::text,true);perform set_config('request.jwt.claims',jsonb_build_object('sub',fin,'aal','aal2')::text,true);
 execute 'set role authenticated';
 begin perform public.finance_totals();raise exception 'FAIL F14 revoked finance retains access';exception when insufficient_privilege then null;end;
 execute 'reset role';
 update public.user_roles set revoked_at=null,expires_at=now()-interval '1 hour' where user_id=fin and role='finance';
 execute 'set role authenticated';
 begin perform public.finance_totals();raise exception 'FAIL F15 expired finance retains access';exception when insufficient_privilege then null;end;
 execute 'reset role';
 update public.user_roles set expires_at=null where user_id=fin and role='finance';
 update public.portal_settings set value='false' where key='mfa_required';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',fin,'aal','aal1')::text,true);
 execute 'set role authenticated';
 if (public.finance_totals()->'THB'->>'charge')::numeric<>1001 then raise exception 'FAIL F16 explicit MFA-off does not allow aal1';end if;
 execute 'reset role';
 perform set_config('amas.test.uid',stu::text,true);perform set_config('request.jwt.claims',jsonb_build_object('sub',stu,'aal','aal1')::text,true);
 execute 'set role authenticated';
 begin perform public.finance_totals();raise exception 'FAIL F17 student reads all finance';exception when insufficient_privilege then null;end;
 if (public.my_finance()->'balance'->>'THB')::numeric<>1001 or public.my_finance()->'balance'?'CNY' then raise exception 'FAIL F18 own balance/cross-student isolation broken';end if;
 execute 'reset role';
 raise notice 'PASS F13-F18 actor conflict, revoked/expired roles, MFA switch, student own-only visibility';
 raise notice 'FINANCE ACCEPTANCE PASSED';
end $$;
rollback;
