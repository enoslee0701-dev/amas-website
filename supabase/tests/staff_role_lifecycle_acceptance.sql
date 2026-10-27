begin;
do $$
declare admin uuid:=gen_random_uuid(); who uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); unverified uuid:=gen_random_uuid(); r jsonb; role_name text; state_name text; n int; before_count int; expiration timestamptz:=now()+interval '1 day';
begin
 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
 (admin,'roles-root@example.invalid',now(),'{"display_name":"职分系统管理员"}'),
 (who,'roles-target@example.invalid',now(),'{"display_name":"职分专员"}'),
 (other,'roles-other@example.invalid',now(),'{"display_name":"职分其他同学"}'),
 (unverified,'roles-unverified@example.invalid',null,'{}');
 insert into public.user_roles(user_id,role) values(admin,'super_admin');
 insert into public.login_aliases(user_id,alias_type,alias_normalized) values(who,'staff_number','ROLE-TEST-2026');
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'aal','aal2')::text,true);
 perform set_config('amas.test.uid',admin::text,true);
 execute 'set role authenticated';
 foreach role_name in array array['registrar','academic_admin','mentor','finance','content_admin'] loop
  r:=public.admin_set_staff_role(who,role_name,true,'测试职分配置',expiration);
  if r->>'ok'<>'true' or not public.has_active_role(who,role_name) then raise exception 'R01 grant failed: % %',role_name,r;end if;
 end loop;
 r:=public.admin_staff_accounts('role-test-2026');
 if jsonb_array_length(r->'rows')<>1 or r#>>'{rows,0,user_id}'<>who::text then raise exception 'R02 login lookup failed %',r;end if;
 r:=public.admin_staff_accounts('职分专员');
 if jsonb_array_length(r->'rows')<>1 then raise exception 'R02 exact name lookup failed';end if;
 r:=public.admin_staff_accounts('roles-target@EXAMPLE.invalid');
 if jsonb_array_length(r->'rows')<>1 then raise exception 'R02 exact email lookup failed';end if;
 foreach role_name in array array['super_admin','teacher','student','applicant'] loop
  r:=public.admin_set_staff_role(who,role_name,true,'试图跳过专门流程');
  if r->>'error'<>'role_not_manageable' then raise exception 'R03 unmanaged role grant allowed: %',role_name;end if;
 end loop;
 r:=public.admin_set_staff_role(admin,'finance',true,'不能修改自己');
 if r->>'error'<>'cannot_change_self' then raise exception 'R04 self grant allowed';end if;
 r:=public.admin_set_staff_role(who,'finance',true,'','infinity');
 if r->>'error'<>'reason_required' then raise exception 'R04 reason omitted';end if;
 r:=public.admin_set_staff_role(who,'finance',true,'过期时间',now()-interval '1 day');
 if r->>'error'<>'invalid_expiry' then raise exception 'R04 past expiry accepted';end if;
 r:=public.admin_set_staff_role(who,'finance',true,'无限时间','infinity');
 if r->>'error'<>'invalid_expiry' then raise exception 'R04 infinite expiry accepted';end if;
 r:=public.admin_set_staff_role(who,'finance',true,'重复配置',expiration);
 if r->>'unchanged'<>'true' then raise exception 'R05 exact replay not idempotent';end if;
 execute 'reset role';
 select count(*) into n from public.audit_logs where target_id=who::text and event_type='role_granted';
 if n<>5 then raise exception 'R05 duplicate audit count %',n;end if;
 update public.user_roles set expires_at=now()-interval '1 day' where user_id=who and role='finance' and revoked_at is null;
 execute 'set role authenticated';
 r:=public.admin_set_staff_role(who,'finance',true,'到期续任',expiration);
 if r->>'ok'<>'true' or not public.has_active_role(who,'finance') then raise exception 'R06 expired row prevents renewal %',r;end if;
 r:=public.admin_set_staff_role(who,'finance',false,'卸任');
 if r->>'ok'<>'true' or public.has_active_role(who,'finance') then raise exception 'R06 revoke failed';end if;
 r:=public.admin_set_staff_role(who,'finance',false,'重试卸任');
 if r->>'unchanged'<>'true' then raise exception 'R06 revoke retry not idempotent';end if;
 r:=public.admin_set_account_access(who,false,'离岗停用');
 if r->>'ok'<>'true' or public.has_active_role(who,'registrar') then raise exception 'R07 disabled account still holds authority';end if;
 r:=public.admin_set_staff_role(who,'finance',true,'停用账号');
 if r->>'error'<>'inactive_account' then raise exception 'R07 disabled target gets grant';end if;
 r:=public.admin_set_account_access(who,true,'返回岗位');
 if r->>'ok'<>'true' or not public.has_active_role(who,'registrar') then raise exception 'R07 restore lost original role';end if;
 r:=public.admin_set_account_access(unverified,true,'未验证邮箱');
 if r->>'error'<>'email_not_verified' then raise exception 'R07 bypassed email verification';end if;
 execute 'reset role';
 -- Effective account status must be evaluated from current DB state, not cached JWT roles.
 foreach role_name in array array['applicant','student','teacher','mentor','registrar','finance','content_admin','academic_admin','super_admin'] loop
  update public.user_roles set revoked_at=now() where user_id=other and revoked_at is null;
  insert into public.user_roles(user_id,role) values(other,role_name::public.user_role);
  foreach state_name in array array['pending_email','locked','suspended','disabled'] loop
   perform set_config('amas.test.uid',admin::text,true);
   update public.profiles set account_status=state_name::public.account_status where id=other;
   if public.has_active_role(other,role_name) then raise exception 'R08 inactive % with % still effective',state_name,role_name;end if;
   perform set_config('amas.test.uid',other::text,true);
   perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'aal','aal2','app_metadata',jsonb_build_object('roles',jsonb_build_array(role_name)))::text,true);
   execute 'set role authenticated';
   if exists(select 1 from public.my_roles()) then raise exception 'R08 inactive user sees effective roles';end if;
   begin perform public.admin_staff_accounts();raise exception 'R08 disabled role reads staff directory';exception when insufficient_privilege then null;end;
   begin perform public.admin_set_staff_role(who,'finance',true,'旧令牌');raise exception 'R08 disabled actor grants roles';exception when insufficient_privilege then null;end;
   execute 'reset role';
  end loop;
  perform set_config('amas.test.uid',admin::text,true);
  update public.profiles set account_status='active' where id=other;
  if not public.has_active_role(other,role_name) then raise exception 'R08 active role missing';end if;
 end loop;
 update public.user_roles set revoked_at=now() where user_id=other and revoked_at is null;
 -- Root accounts cannot be disabled through routine staff operations.
 insert into public.user_roles(user_id,role) values(other,'super_admin');
 perform set_config('amas.test.uid',admin::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'aal','aal2')::text,true);
 execute 'set role authenticated';
 update public.profiles set account_status='disabled',email='self-bypass@example.invalid' where id=admin;
 if not public.has_active_role(admin,'super_admin') or (select email from public.profiles where id=admin)<>'roles-root@example.invalid' then raise exception 'R09 direct self update bypasses protected account fields';end if;
 r:=public.admin_set_account_access(other,false,'保护管理员');
 if r->>'error'<>'protected_account' then raise exception 'R09 root account not protected';end if;
 execute 'reset role';
 -- Auth-owned trigger chains must still synchronize verified identity data for the same UID.
 perform set_config('amas.test.uid',admin::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'aal','aal2')::text,true);
 update auth.users set email='roles-root-updated@example.invalid' where id=admin;
 if (select email from public.profiles where id=admin)<>'roles-root-updated@example.invalid' then raise exception 'R09 trusted auth email sync was blocked by self-protection';end if;
 perform set_config('amas.test.uid',unverified::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',unverified,'aal','aal1')::text,true);
 update auth.users set email_confirmed_at=now() where id=unverified;
 if (select account_status from public.profiles where id=unverified)<>'active' then raise exception 'R09 trusted auth verification sync was blocked';end if;
 -- Every ordinary role is denied even with aal2, while super-admin aal1 is denied with MFA on.
 foreach role_name in array array['applicant','student','teacher','mentor','registrar','finance','content_admin','academic_admin'] loop
  update public.user_roles set revoked_at=now() where user_id=other and revoked_at is null;
  insert into public.user_roles(user_id,role) values(other,role_name::public.user_role);
  perform set_config('amas.test.uid',other::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',other,'aal','aal2')::text,true);
  execute 'set role authenticated';
  begin perform public.admin_staff_accounts();raise exception 'R10 ordinary role directory leak %',role_name;exception when insufficient_privilege then null;end;
  begin perform public.admin_set_staff_role(who,'finance',true,'越权');raise exception 'R10 ordinary role grants privileges %',role_name;exception when insufficient_privilege then null;end;
  begin perform public.admin_set_account_access(who,false,'越权');raise exception 'R10 ordinary role disables account %',role_name;exception when insufficient_privilege then null;end;
  execute 'reset role';
 end loop;
 perform set_config('amas.test.uid',admin::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',admin,'aal','aal1')::text,true);
 execute 'set role authenticated';
 begin perform public.admin_staff_accounts();raise exception 'R11 aal1 reads directory with MFA enabled';exception when insufficient_privilege then null;end;
 begin perform public.admin_set_staff_role(who,'finance',true,'绕过MFA');raise exception 'R11 aal1 changes role';exception when insufficient_privilege then null;end;
 execute 'reset role';
 update public.portal_settings set value='false' where key='mfa_required';
 execute 'set role authenticated';
 r:=public.admin_staff_accounts();if r->'rows' is null then raise exception 'R11 explicit MFA switch off not honoured';end if;
 execute 'reset role';
 if has_function_privilege('anon','public.admin_staff_accounts(text)','execute') or
 has_function_privilege('authenticated','public.sis_set_staff_role(uuid,uuid,text,boolean,text)','execute') or
 has_function_privilege('authenticated','amas_private.set_staff_role(uuid,uuid,text,boolean,text,timestamptz)','execute') then raise exception 'R12 helper execution exposed';end if;
 raise notice 'PASS R01-R12 five managed roles, exact lookup, protected workflows, expiry/renewal/replay, account state, old JWT denial, all nine roles, MFA and private helper grants';
end $$;
rollback;
