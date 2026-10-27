// Execute the exact reviewed operator SQL against a fresh synthetic DB only.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'amas-attendance-assignment-'));
const plan=fs.readFileSync(path.join(root,'supabase/operations/assign-sunying-october-attendance.sql'),'utf8');
const setup=`
insert into public.submission_cohorts(name) values('10月班') on conflict do nothing;
do $$ declare who uuid:=gen_random_uuid();admin uuid:=gen_random_uuid();sid uuid;begin
 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values(who,'named-clerk@example.invalid',now(),'{"display_name":"孙莹"}'),(admin,'named-admin@example.invalid',now(),'{}');
 update public.profiles set display_name='孙莹' where id=who;
 insert into public.user_roles(user_id,role) values(who,'student'),(admin,'super_admin');
 insert into public.login_aliases(user_id,alias_type,alias_normalized) values(who,'username','SUNYING2026');
 perform set_config('amas.rpc_context','student',true);
 insert into public.student_records(user_id,student_number) values(who,'B26-NAMED-TEST') returning id into sid;
 perform public.activate_student(sid,admin,'synthetic registration','isolated fixture');
 insert into public.submissions(type,name,student_user_id,cohort) values('application','孙莹',who,'10月班');
end $$;`;
const checks=`
do $$ declare who uuid;begin
 select user_id into who from public.login_aliases where alias_normalized='SUNYING2026';
 if not amas_private.attendance_active(who) then raise exception 'Exact target assignment missing';end if;
 if not public.has_active_role(who,'student') or not exists(select 1 from public.student_records where user_id=who and status='active') then raise exception 'Academic identity was changed';end if;
 if (select count(*) from public.audit_logs where target_id=who::text and event_type='attendance.operator_assigned')<>1 then raise exception 'Assignment retry duplicated audit';end if;
 perform set_config('amas.test.uid',who::text,true);perform set_config('request.jwt.claims',jsonb_build_object('sub',who,'aal','aal2')::text,true);
 execute 'set role authenticated';
 if (select array_agg(role) from public.my_roles()) is distinct from array['attendance_clerk'] then raise exception 'Wrong effective workspace';end if;
 perform public.attendance_day('2026-10-27');execute 'reset role';
 raise notice 'PASS named assignment: SUNYING2026, October only, academic identity intact, retry has one audit, effective attendance workspace';
end $$;`;
try{
 const file=path.join(temp,'assignment.sql');fs.writeFileSync(file,setup+'\n'+plan+'\n'+plan+'\n'+checks);
 const r=spawnSync(process.execPath,['scripts/run-sql-local.mjs',file],{cwd:root,env:process.env,stdio:'inherit'});process.exitCode=r.status??1;
}finally{fs.rmSync(temp,{recursive:true,force:true});}
