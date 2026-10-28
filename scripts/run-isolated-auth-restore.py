#!/usr/bin/env python3
"""Real GoTrue/PostgREST/Mailpit and restore acceptance; dedicated local Docker only.
Run after applying all migrations to a disposable Supabase stack. Never accepts a
hosted URL or an arbitrary Docker container. Writes no credentials to evidence.
"""
import argparse, base64, datetime, hashlib, hmac, html, importlib.util, json, os, pathlib, re, secrets, struct, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request, uuid
spec=importlib.util.spec_from_file_location('backup',pathlib.Path(__file__).with_name('backup-db.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
P=argparse.ArgumentParser(description=__doc__);P.add_argument('--cli',required=True);P.add_argument('--workdir',required=True);P.add_argument('--out',required=True);a=P.parse_args();out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True)
config=json.loads(subprocess.check_output([a.cli,'status','--workdir',a.workdir,'-o','json'],stderr=subprocess.DEVNULL));api=config['API_URL'];mail=config.get('MAILPIT_URL',config.get('INBUCKET_URL'));container='supabase_db_amas-attendance-isolated'
if urllib.parse.urlsplit(api).hostname not in ('127.0.0.1','localhost'):raise SystemExit('Refusing non-loopback backend')
if 'amas-attendance-isolated' not in pathlib.Path(a.workdir,'supabase/config.toml').read_text():raise SystemExit('Refusing unmarked stack')
subprocess.run(['docker','inspect',container],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
results=[];fixture={};tag=uuid.uuid4().hex[:8]
def check(label,cond):
 results.append({'name':label,'passed':bool(cond)});print(('PASS ' if cond else 'FAIL ')+label,flush=True)
 if not cond:raise RuntimeError(label)
def psql(q,db='postgres'):
 return subprocess.check_output(['docker','exec','-i',container,'psql','-U','supabase_admin','-d',db,'-v','ON_ERROR_STOP=1','-Atq'],input=q.encode(),stderr=subprocess.PIPE).decode().strip()
def dbrows(q):return json.loads(psql("select coalesce(json_agg(x),'[]'::json) from ("+q.rstrip(';')+") x"))
def request(path,data=None,token=None,method=None,key=None):
 req=urllib.request.Request(api+path,data=None if data is None else json.dumps(data).encode(),method=method,headers={'apikey':key or config['ANON_KEY'],'Authorization':'Bearer '+(token or key or config['ANON_KEY']),'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=30) as r:raw=r.read();return r.status,json.loads(raw) if raw else None
 except urllib.error.HTTPError as e:
  raw=e.read();return e.code,json.loads(raw) if raw else None
def rpc(name,token,args={}):return request('/rest/v1/rpc/'+name,args,token)
def signin(email,pw):return request('/auth/v1/token?grant_type=password',{'email':email,'password':pw})
def lit(s):return "'"+s.replace("'","''")+"'"
try:
 psql("update public.portal_settings set value='false'::jsonb where key='mfa_required';insert into public.submission_cohorts(name) values('10月班') on conflict do nothing;notify pgrst,'reload schema';")
 roles=['super_admin','academic_admin','registrar','finance','content_admin','teacher','mentor','student','applicant','attendance_clerk']
 for role in roles:
  email='isolated-'+tag+'-'+role+'@example.invalid';pw=secrets.token_urlsafe(24);status,u=request('/auth/v1/admin/users',{'email':email,'password':pw,'email_confirm':True,'user_metadata':{'display_name':'隔离测试 '+role}},key=config['SERVICE_ROLE_KEY'])
  check('create isolated '+role,status in (200,201));uid=u['id'];fixture[role]={'email':email,'password':pw,'id':uid}
  if role=='attendance_clerk':psql("insert into amas_private.attendance_operators(user_id) values("+lit(uid)+")")
  elif role!='applicant':psql("insert into public.user_roles(user_id,role) values("+lit(uid)+","+lit(role)+")")
  status,s=signin(email,pw);check('real password login '+role,status==200 and 'access_token'in s);fixture[role]['session']=s
  status,r=rpc('my_roles',s['access_token']);check('signed JWT roles '+role,status==200 and any(x['role']==role for x in r))
  status,r=rpc('admin_attendance_month',s['access_token'],{'p_cohort':'10月班','p_month':'2026-10-01'});check('report scope '+role,status==200 if role in roles[:3] else status in (401,403))
 # AAL1 is actually refused with the switch enabled; real TOTP verifies to AAL2.
 root=fixture['super_admin']['session'];psql("update public.portal_settings set value='true'::jsonb where key='mfa_required'")
 status,_=rpc('admin_attendance_month',root['access_token'],{'p_cohort':'10月班','p_month':'2026-10-01'});check('real AAL1 rejected with MFA enabled',status in (401,403))
 status,f=request('/auth/v1/factors',{'factor_type':'totp','friendly_name':'isolated-'+tag},root['access_token']);check('real TOTP enroll',status in (200,201))
 status,c=request('/auth/v1/factors/'+f['id']+'/challenge',{},root['access_token']);check('real TOTP challenge',status==200)
 secret=base64.b32decode(f['totp']['secret']+'='*((-len(f['totp']['secret']))%8));digest=hmac.new(secret,struct.pack('>Q',int(time.time())//30),hashlib.sha1).digest();offset=digest[-1]&15;code=str((struct.unpack('>I',digest[offset:offset+4])[0]&0x7fffffff)%1000000).zfill(6)
 status,verified=request('/auth/v1/factors/'+f['id']+'/verify',{'challenge_id':c['id'],'code':code},root['access_token']);check('real TOTP verify',status==200 and 'access_token'in verified)
 status,_=rpc('admin_attendance_month',verified['access_token'],{'p_cohort':'10月班','p_month':'2026-10-01'});check('real AAL2 report succeeds',status==200)
 psql("update public.portal_settings set value='false'::jsonb where key='mfa_required'")
 # Old signed JWT must lose database privileges immediately after role expiry/disable.
 uid=fixture['registrar']['id'];psql('update public.user_roles set expires_at=now()-interval \'1 second\' where user_id='+lit(uid)+" and role='registrar'")
 status,_=rpc('admin_attendance_month',fixture['registrar']['session']['access_token'],{'p_cohort':'10月班','p_month':'2026-10-01'});check('expired role denies existing JWT',status in (401,403))
 uid=fixture['academic_admin']['id'];psql("update public.profiles set account_status='disabled' where id="+lit(uid))
 status,_=rpc('admin_attendance_month',fixture['academic_admin']['session']['access_token'],{'p_cohort':'10月班','p_month':'2026-10-01'});check('disabled account denies existing JWT',status in (401,403))
 # SMTP never leaves the isolated stack; inspect Mailpit instead of a real mailbox.
 learner=fixture['student'];status,_=request('/auth/v1/recover',{'email':learner['email']});check('real password recovery request',status==200)
 message=None
 for _ in range(30):
  try:
   with urllib.request.urlopen(mail+'/view/latest.html?query='+urllib.parse.quote('to:'+learner['email']),timeout=5) as r:message=r.read().decode();break
  except urllib.error.HTTPError:time.sleep(.2)
 check('real recovery email received by local SMTP',message is not None)
 links=re.findall(r'href=["\']([^"\']+)',message);link=next(html.unescape(x) for x in links if '/auth/v1/verify' in x);check('recovery link remains loopback',urllib.parse.urlsplit(link).hostname in ('localhost','127.0.0.1'))
 class NoRedirect(urllib.request.HTTPRedirectHandler):
  def redirect_request(self,*args,**kwargs):return None
 try:urllib.request.build_opener(NoRedirect).open(link,timeout=20);location=''
 except urllib.error.HTTPError as e:location=e.headers.get('Location','')
 params=urllib.parse.parse_qs(urllib.parse.urlsplit(location).fragment);check('recovery link verifies to signed session','access_token'in params)
 new_pw=secrets.token_urlsafe(24);status,_=request('/auth/v1/user',{'password':new_pw},params['access_token'][0],method='PUT');check('isolated password reset succeeds',status==200);learner['password']=new_pw
 status,_=signin(learner['email'],new_pw);check('new password authenticates',status==200)
 # Logout invalidates refresh, without incorrectly assuming instant access-JWT expiry.
 s=fixture['content_admin']['session'];status,_=request('/auth/v1/logout',{},s['access_token']);check('real logout',status in (200,204));status,_=request('/auth/v1/token?grant_type=refresh_token',{'refresh_token':s['refresh_token']});check('logged-out refresh token refused',status>=400)
 # Leave a signed-session-independent fixture for browser checks, mode 0600 only.
 fixture_file=pathlib.Path(tempfile.mkdtemp(prefix='amas-auth-fixture-'))/'fixture.json';fd=os.open(fixture_file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w')as f:json.dump({'api':api,'anon':config['ANON_KEY'],'users':{k:{x:v[x]for x in ('email','password')}for k,v in fixture.items()}},f)
 (out/'fixture-location.txt').write_text(str(fixture_file)+'\n')
 # Exercise the same backup plan and authenticated encryption as the real backup.
 b.sql=lambda token,q:dbrows(q);snapshot=b.snapshot_from_db('local-only');snapshot['project']='isolated-'+tag;key=secrets.token_bytes(32);archive=b.save_archive(snapshot,key,pathlib.Path(tempfile.mkdtemp(prefix='amas-restore-drill-'))/'test.amasbak');restored=b.unpack(archive.read_bytes(),key);check('encrypted snapshot roundtrip includes private state',restored==snapshot and bool(restored['tables']['amas_private.attendance_operators']))
 # A disposable database cloned from the migrated schema, restored in one transaction.
 dbname='amas_restore_'+tag;psql('create database '+dbname+' template template0');schema=subprocess.check_output(['docker','exec',container,'pg_dump','-U','postgres','-d','postgres','--schema-only','--no-privileges']);proc=subprocess.run(['docker','exec','-i',container,'psql','-U','supabase_admin','-d',dbname,'-v','ON_ERROR_STOP=1','-q'],input=schema,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE);(out/'restore-schema-error.log').write_bytes(proc.stderr) if proc.returncode else None;check('fresh database schema restored',proc.returncode==0)
 tables=restored['tables'];commands=['begin;set local session_replication_role=replica;'];names=[b.quoted(n.split('.')[0])+'.'+b.quoted(n.split('.')[1])for n in tables];commands.append('truncate '+','.join(names)+' cascade;')
 for name,rows in tables.items():
  if not rows:continue
  columns=restored['columns'][name];qualified='.'.join(map(b.quoted,name.split('.')));cs=','.join(map(b.quoted,columns));payload=json.dumps(rows,ensure_ascii=False,separators=(',',':'));commands.append('insert into '+qualified+' ('+cs+') overriding system value select '+cs+' from jsonb_populate_recordset(null::'+qualified+','+lit(payload)+'::jsonb);')
 # Repair identity/serial sequences after explicit IDs. Never run this against a hosted DB.
 commands.append("do $$declare r record; seq text; n bigint;begin for r in select table_schema,table_name,column_name from information_schema.columns where table_schema in ('public','amas_private') loop seq:=pg_get_serial_sequence(format('%I.%I',r.table_schema,r.table_name),r.column_name);if seq is not null then execute format('select max(%I) from %I.%I',r.column_name,r.table_schema,r.table_name) into n;perform setval(seq,coalesce(n,1),n is not null);end if;end loop;end $$;commit;")
 psql('\n'.join(commands),dbname);counts=dbrows("select 'source'::text marker")
 matches=True
 for name,rows in tables.items():
  qualified='.'.join(map(b.quoted,name.split('.')));cols=','.join(map(b.quoted,restored['columns'][name]));got=json.loads(psql("select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select "+cols+' from '+qualified+')x',dbname));matches=matches and sorted(map(lambda x:json.dumps(x,sort_keys=True),got))==sorted(map(lambda x:json.dumps(x,sort_keys=True),rows))
 check('all restored table rows equal source',matches)
 check('password hash preserved through restore',psql("select encrypted_password<>'' from auth.users where id="+lit(learner['id']),dbname)=='t')
 # Verify next generated IDs do not collide after restoration.
 check('restored sequence advances',psql("insert into public.submissions(type,name) values('application','恢复序列测试') returning id",dbname).splitlines()[0].isdigit())
 # Password-hash integrity is checked independently of the Auth service.
 check('restored password validates in PostgreSQL',psql('select encrypted_password=crypt('+lit(new_pw)+",encrypted_password) from auth.users where id="+lit(learner['id']),dbname)=='t')
 # Start an independent official GoTrue against the restored database, then sign in.
 source=json.loads(subprocess.check_output(['docker','inspect','supabase_auth_amas-attendance-isolated']))[0];authname='amas-restore-auth-'+tag;network=next(iter(source['NetworkSettings']['Networks']));env=[]
 for item in source['Config']['Env']:
  if item.startswith('GOTRUE_DB_DATABASE_URL='):
   conn=urllib.parse.urlsplit(item.split('=',1)[1]);item='GOTRUE_DB_DATABASE_URL='+urllib.parse.urlunsplit(conn._replace(path='/'+dbname))
  env.extend(['-e',item])
 psql('grant usage on schema auth to supabase_auth_admin;grant all on all tables in schema auth to supabase_auth_admin;grant all on all sequences in schema auth to supabase_auth_admin;',dbname)
 subprocess.run(['docker','run','-d','--name',authname,'--network',network,'-p','127.0.0.1::9999',*env,source['Config']['Image']],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 try:
  info=json.loads(subprocess.check_output(['docker','inspect',authname]))[0]
  if not info['NetworkSettings']['Ports'].get('9999/tcp'):(out/'restored-auth-error.log').write_bytes(subprocess.check_output(['docker','logs',authname],stderr=subprocess.STDOUT));raise RuntimeError('Restored Auth did not expose test port')
  port=info['NetworkSettings']['Ports']['9999/tcp'][0]['HostPort'];base='http://127.0.0.1:'+port;ready=False
  for _ in range(80):
   try:
    with urllib.request.urlopen(base+'/health',timeout=2)as r:ready=r.status==200
    if ready:break
   except (urllib.error.URLError,TimeoutError,ConnectionError):time.sleep(.2)
  check('restored independent Auth service healthy',ready)
  req=urllib.request.Request(base+'/token?grant_type=password',data=json.dumps({'email':learner['email'],'password':new_pw}).encode(),headers={'Content-Type':'application/json'})
  try:
   with urllib.request.urlopen(req,timeout=20)as r:login=json.load(r);status=r.status
  except urllib.error.HTTPError as exc:
   (out/'restored-auth-response.json').write_bytes(exc.read());(out/'restored-auth-error.log').write_bytes(subprocess.check_output(['docker','logs',authname],stderr=subprocess.STDOUT));raise
  check('real password login against restored database',status==200 and login['user']['id']==learner['id'] and 'access_token'in login)
 finally:subprocess.run(['docker','rm','-f',authname],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 psql('drop database '+dbname)
except Exception as exc:
 if isinstance(exc,subprocess.CalledProcessError) and exc.stderr:(out/'restore-command-error.log').write_bytes(exc.stderr)
 print('FAILED '+type(exc).__name__+' (sensitive provider details omitted)',flush=True)
 results.append({'name':'runner completed','passed':False,'error_type':type(exc).__name__})
finally:
 (out/'auth-restore-results.json').write_text(json.dumps({'results':results,'passed':sum(x['passed']for x in results),'failed':sum(not x['passed']for x in results),'scope':'dedicated local GoTrue/PostgREST/SMTP and native PostgreSQL; no hosted accounts or records'},ensure_ascii=False,indent=2)+'\n')
sys.exit(0 if all(x['passed']for x in results)else 1)
