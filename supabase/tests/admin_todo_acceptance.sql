begin;
do $$
declare admin uuid:=gen_random_uuid();stu1 uuid:=gen_random_uuid();stu2 uuid:=gen_random_uuid();fin uuid:=gen_random_uuid();n int;nm text;
begin
 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values(admin,'todo-admin@example.invalid',now(),'{}'),
  (stu1,'todo-a@student.amas.invalid',now(),'{"must_change_password":true}'),(stu2,'todo-b@student.amas.invalid',now(),'{"must_change_password":false}'),
  (fin,'todo-fin@example.invalid',now(),'{}');
 insert into public.user_roles(user_id,role) values(admin,'registrar'),(fin,'finance');
 insert into public.submissions(type,name,cohort,student_user_id) values('application','还没改','10月班',stu1),('application','已改过','10月班',stu2),('application','没开账号','',null);
 perform set_config('amas.test.uid',admin::text,true);perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'aal','aal2')::text,true);
 execute 'set local role authenticated';
 select count(*),max(name) into n,nm from public.admin_initial_password_list();
 if n<>1 or nm<>'还没改' then raise exception 'T01 list wrong % %',n,nm;end if;
 execute 'reset role';
 perform set_config('amas.test.uid',fin::text,true);perform set_config('request.jwt.claims',jsonb_build_object('sub',fin,'aal','aal2')::text,true);
 execute 'set local role authenticated';
 begin perform public.admin_initial_password_list();raise exception 'T02 finance allowed';exception when insufficient_privilege then null;end;
 perform set_config('amas.test.uid',stu1::text,true);perform set_config('request.jwt.claims',jsonb_build_object('sub',stu1,'aal','aal1')::text,true);
 begin perform public.admin_initial_password_list();raise exception 'T03 student allowed';exception when insufficient_privilege then null;end;
 execute 'reset role';
 if has_function_privilege('anon','public.admin_initial_password_list()','execute') then raise exception 'T04 anon can execute';end if;
 raise notice 'ADMIN TODO SQL: 4 PASS';
end $$;
rollback;
