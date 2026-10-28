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
if __name__=='__main__':unittest.main()
