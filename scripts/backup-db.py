#!/usr/bin/env python3
"""AMAS encrypted, consistent application/account backup (format 2).

Includes public + amas_private tables and auth.users/identities. Excludes active
sessions, recovery tokens, MFA factors, Storage file bytes, hosted service config.
Keep the key separately: losing it makes the archive unrecoverable.
Install scripts/requirements-backup.txt into a dedicated venv before running.
"""
import argparse, datetime, hashlib, io, json, os, pathlib, re, secrets, ssl, sys, urllib.request, zipfile

REF = 'sdrwyebizfdwldlfjyim'
HEADER = b'AMAS-BACKUP-2\x00'
ROOT = pathlib.Path(__file__).resolve().parents[1]
TOKEN_FILE = pathlib.Path.home()/'.config/amas/supabase-token'
KEY_FILE = pathlib.Path.home()/'.config/amas/backup-v2.key'
OUT_ROOT = pathlib.Path.home()/'Documents/AMAS数据备份'
EXCLUDED_USER_COLUMNS = {'confirmation_token','recovery_token','email_change_token_new','email_change_token_current','phone_change_token','reauthentication_token'}
CTX = ssl.create_default_context(cafile='/etc/ssl/cert.pem') if os.path.exists('/etc/ssl/cert.pem') else ssl.create_default_context()

def sql(token, query):
    req=urllib.request.Request(f'https://api.supabase.com/v1/projects/{REF}/database/query', data=json.dumps({'query':query}).encode(),method='POST',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,context=CTX,timeout=120) as r:return json.load(r)

def quoted(s):return '"'+s.replace('"','""')+'"'
def literal(s):return "'"+s.replace("'","''")+"'"

def table_query():
    return "select table_schema,table_name,column_name,data_type,is_generated,ordinal_position from information_schema.columns where ((table_schema in ('public','amas_private') and table_name in (select tablename from pg_tables where schemaname=table_schema)) or (table_schema='auth' and table_name in ('users','identities','schema_migrations'))) order by table_schema,table_name,ordinal_position"

def plan(columns):
    tables={}
    for c in columns:
        if c['is_generated']!='NEVER':continue
        key=c['table_schema']+'.'+c['table_name'];tables.setdefault(key,[]).append(c['column_name'])
    if not {'public.profiles','amas_private.attendance_operators','auth.users','auth.identities'}<=tables.keys():raise ValueError('Required backup tables missing')
    fields=[]
    for key,cols in tables.items():
        schema,name=key.split('.',1);selection=','.join(("''::text as "+quoted(c)) if key=='auth.users' and c in EXCLUDED_USER_COLUMNS else quoted(c) for c in cols);fields.append(literal(key)+",(select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (select "+selection+' from '+quoted(schema)+'.'+quoted(name)+') x)')
    # One statement -> one MVCC snapshot for every application and account table.
    # jsonb_build_object has an argument limit; build bounded chunks and concatenate.
    chunks=["jsonb_build_object("+','.join(fields[i:i+30])+")" for i in range(0,len(fields),30)]
    return tables,'select '+(' || '.join(chunks))+' as snapshot'

def snapshot_from_db(token):
    columns=sql(token,table_query());tables,query=plan(columns);result=sql(token,query)
    if len(result)!=1 or not isinstance(result[0].get('snapshot'),dict):raise ValueError('Incomplete snapshot response')
    return {'format':2,'project':REF,'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'columns':tables,'tables':result[0]['snapshot'],'exclusions':['active sessions and recovery tokens','MFA factors (re-enrollment required)','Storage file bytes','hosted service configuration']}

def validate(snapshot):
    if snapshot.get('format')!=2 or not isinstance(snapshot.get('tables'),dict) or set(snapshot['tables'])!=set(snapshot.get('columns',{})):raise ValueError('Invalid snapshot shape')
    for name,rows in snapshot['tables'].items():
        if not re.fullmatch(r'(public|amas_private|auth)\.[A-Za-z_][A-Za-z_0-9]*',name) or not isinstance(rows,list) or not all(isinstance(row,dict) and set(row)<=set(snapshot['columns'][name]) for row in rows):raise ValueError('Invalid table payload')
    if not {'public.profiles','amas_private.attendance_operators','auth.users','auth.identities'}<=snapshot['tables'].keys():raise ValueError('Incomplete application/account snapshot')

def load_key(path,create=False):
    path=pathlib.Path(path)
    if not path.exists() and create:
        path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as f:f.write(secrets.token_bytes(32))
    key=path.read_bytes()
    if len(key)!=32 or path.stat().st_mode&0o077:raise ValueError('Backup key must be 32 bytes and mode 0600')
    return key

def pack(snapshot,key):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    validate(snapshot);payload=json.dumps(snapshot,ensure_ascii=False,separators=(',',':')).encode();manifest={'format':2,'sha256':hashlib.sha256(payload).hexdigest(),'tables':{k:len(v) for k,v in snapshot['tables'].items()},'created_at':snapshot['created_at'],'exclusions':snapshot.get('exclusions',[])}
    buf=io.BytesIO()
    with zipfile.ZipFile(buf,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('snapshot.json',payload);z.writestr('manifest.json',json.dumps(manifest))
    nonce=secrets.token_bytes(12);return HEADER+nonce+AESGCM(key).encrypt(nonce,buf.getvalue(),HEADER)

def unpack(blob,key):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not blob.startswith(HEADER):raise ValueError('Unsupported archive format')
    n=len(HEADER);raw=AESGCM(key).decrypt(blob[n:n+12],blob[n+12:],HEADER)
    with zipfile.ZipFile(io.BytesIO(raw)) as z:payload=z.read('snapshot.json');manifest=json.loads(z.read('manifest.json'))
    if hashlib.sha256(payload).hexdigest()!=manifest['sha256']:raise ValueError('Snapshot checksum mismatch')
    snapshot=json.loads(payload);validate(snapshot)
    if {k:len(v) for k,v in snapshot['tables'].items()}!=manifest['tables']:raise ValueError('Row count mismatch')
    return snapshot

def save_archive(snapshot,key,out):
    out=pathlib.Path(out);out.parent.mkdir(parents=True,exist_ok=True,mode=0o700);data=pack(snapshot,key);temp=out.with_suffix(out.suffix+'.partial')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
        unpack(temp.read_bytes(),key);os.replace(temp,out)
    finally:
        if temp.exists():temp.unlink()
    return out

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source-json',type=pathlib.Path,help='Use an isolated fixture snapshot; no network');parser.add_argument('--output-dir',type=pathlib.Path,default=OUT_ROOT);parser.add_argument('--key-file',type=pathlib.Path,default=KEY_FILE);a=parser.parse_args()
    # Fail before reading account hashes if the encryption runtime is unavailable.
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key=load_key(a.key_file,create=True)
    try:
        snapshot=json.loads(a.source_json.read_text()) if a.source_json else snapshot_from_db(TOKEN_FILE.read_text().strip())
        stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H%M%S-%fZ');out=save_archive(snapshot,key,a.output_dir/(stamp+'.amasbak'))
        status={'ok':True,'archive':out.name,'created_at':snapshot['created_at'],'tables':len(snapshot['tables']),'rows':sum(map(len,snapshot['tables'].values())),'exclusions':snapshot.get('exclusions',[])}
        a.output_dir.mkdir(parents=True,exist_ok=True,mode=0o700);status_path=a.output_dir/'_backup-status.json';fd=os.open(status_path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'w') as f:json.dump(status,f,ensure_ascii=False,indent=2)
        print('Encrypted backup verified: '+str(out)+'; tables='+str(status['tables'])+'; rows='+str(status['rows']))
    except Exception as exc:
        # No SQL, payloads, credentials or provider response bodies in logs.
        a.output_dir.mkdir(parents=True,exist_ok=True,mode=0o700);fd=os.open(a.output_dir/'_backup-status.json',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
        with os.fdopen(fd,'w') as f:json.dump({'ok':False,'error_type':type(exc).__name__,'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat()},f)
        print('Backup failed; previous archives kept. Check runtime, token and local backup status.',file=sys.stderr);return 2
    return 0

if __name__=='__main__':sys.exit(main())
