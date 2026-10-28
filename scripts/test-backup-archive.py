import importlib.util, pathlib, secrets, tempfile, unittest
spec=importlib.util.spec_from_file_location('backup',pathlib.Path(__file__).with_name('backup-db.py'));b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
class ArchiveTests(unittest.TestCase):
 def setUp(self):
  self.key=secrets.token_bytes(32);self.s={'format':2,'created_at':'2026-10-28T00:00:00Z','columns':{'public.profiles':['id'],'amas_private.attendance_operators':['user_id'],'auth.users':['id','encrypted_password'],'auth.identities':['user_id']},'tables':{'public.profiles':[{'id':'synthetic'}],'amas_private.attendance_operators':[{'user_id':'synthetic'}],'auth.users':[{'id':'synthetic','encrypted_password':'synthetic-hash'}],'auth.identities':[{'user_id':'synthetic'}]}}
 def test_roundtrip(self):
  x=b.pack(self.s,self.key);self.assertNotIn(b'synthetic-hash',x);self.assertEqual(b.unpack(x,self.key),self.s)
 def test_tampering_rejected(self):
  x=bytearray(b.pack(self.s,self.key));x[-1]^=1
  with self.assertRaises(Exception):b.unpack(bytes(x),self.key)
 def test_wrong_key_rejected(self):
  with self.assertRaises(Exception):b.unpack(b.pack(self.s,self.key),secrets.token_bytes(32))
 def test_missing_private_state_rejected(self):
  del self.s['tables']['amas_private.attendance_operators']
  with self.assertRaises(ValueError):b.pack(self.s,self.key)
 def test_atomic_protected_output(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'one.amasbak';b.save_archive(self.s,self.key,p);self.assertEqual(p.stat().st_mode&0o777,0o600);self.assertEqual(b.unpack(p.read_bytes(),self.key),self.s);self.assertFalse(list(pathlib.Path(d).glob('*.partial')))
 def test_new_key_and_bad_permissions(self):
  with tempfile.TemporaryDirectory() as d:
   p=pathlib.Path(d)/'key';self.assertEqual(len(b.load_key(p,True)),32);p.chmod(0o644)
   with self.assertRaises(ValueError):b.load_key(p)
 def test_snapshot_is_one_statement_and_excludes_tokens(self):
  cols=[{'table_schema':s,'table_name':t,'column_name':c,'is_generated':'NEVER'} for s,t,c in [('public','profiles','id'),('amas_private','attendance_operators','user_id'),('auth','users','id'),('auth','users','encrypted_password'),('auth','users','recovery_token'),('auth','identities','id')]]
  tables,sql=b.plan(cols);self.assertIn("''::text as \"recovery_token\"",sql);self.assertIn('encrypted_password',sql);self.assertNotIn(';',sql);self.assertIn('amas_private.attendance_operators',tables)
class AlertTests(unittest.TestCase):
 # 备份失败 / 令牌快到期：桌面说明文件 + 系统通知；恢复后自动删掉（2026-10-28）
 def setUp(self):
  self.d=tempfile.TemporaryDirectory();self.dir=pathlib.Path(self.d.name);self.sent=[]
  self.old=(b.ALERT_DIR,b.TOKEN_EXPIRES_FILE,b.notify);b.ALERT_DIR=self.dir;b.TOKEN_EXPIRES_FILE=self.dir/'exp';b.notify=lambda t,m:self.sent.append(m)
 def tearDown(self):b.ALERT_DIR,b.TOKEN_EXPIRES_FILE,b.notify=self.old;self.d.cleanup()
 def test_expiry_warns_within_seven_days_and_clears_after_renewal(self):
  import datetime as dt
  b.TOKEN_EXPIRES_FILE.write_text('2026-11-25\n');b.check_token_expiry(dt.date(2026,11,10));self.assertFalse((self.dir/b.EXPIRY_NOTE).exists());self.assertEqual(self.sent,[])
  b.check_token_expiry(dt.date(2026,11,20));self.assertIn('还有 5 天到期',(self.dir/b.EXPIRY_NOTE).read_text());self.assertEqual(len(self.sent),1)
  b.check_token_expiry(dt.date(2026,11,26));self.assertIn('已经过期',(self.dir/b.EXPIRY_NOTE).read_text())
  b.TOKEN_EXPIRES_FILE.write_text('2027-11-25');b.check_token_expiry(dt.date(2026,11,26));self.assertFalse((self.dir/b.EXPIRY_NOTE).exists())
 def test_no_expiry_file_is_silent(self):
  b.check_token_expiry();self.assertEqual(self.sent,[]);self.assertFalse((self.dir/b.EXPIRY_NOTE).exists())
 def test_failure_reasons_are_plain_and_leak_nothing(self):
  import urllib.error as ue
  why,fix=b.failure_text(ue.HTTPError('https://x',401,'Unauthorized',{},None));self.assertIn('过期',why);self.assertIn('Access Tokens',fix)
  why,_=b.failure_text(ue.URLError('offline'));self.assertIn('网络',why)
  why,_=b.failure_text(RuntimeError('secret-sql select * from auth.users'));self.assertNotIn('secret',why);self.assertIn('RuntimeError',why)
if __name__=='__main__':unittest.main()
