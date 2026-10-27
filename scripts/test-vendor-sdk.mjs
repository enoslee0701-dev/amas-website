// Execute the actual bundled UMD SDK, not the browser harness substitute.
import fs from 'node:fs';import vm from 'node:vm';import crypto from 'node:crypto';
import assert from 'node:assert/strict';import path from 'node:path';
const dir=path.resolve(import.meta.dirname,'../assets/vendor/supabase-js@2.116.0');
const code=fs.readFileSync(path.join(dir,'supabase.min.js'),'utf8');const build=JSON.parse(fs.readFileSync(path.join(dir,'BUILD.json'),'utf8'));
assert.equal(crypto.createHash('sha256').update(code).digest('hex'),build.output_sha256);
assert.equal(build.target,'es2020');assert.equal(build.version,'2.116.0');
let calls=0;const context={URL,URLSearchParams,Headers,Request,Response,FormData,Blob,WebSocket,AbortController,TextEncoder,TextDecoder,crypto:globalThis.crypto,setTimeout,clearTimeout,setInterval,clearInterval,console,fetch:()=>{calls++;throw new Error('Unexpected network request');}};
vm.createContext(context);vm.runInContext(code,context,{timeout:5000});
assert.equal(typeof context.supabase?.createClient,'function');
const client=context.supabase.createClient('https://abcdefghijklmnopqrst.supabase.co','local-test-not-a-credential',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
const session=await client.auth.getSession();assert.equal(session.error,null);assert.equal(session.data.session,null);
assert.equal(typeof client.rpc,'function');assert.equal(typeof client.from('profiles').select,'function');assert.equal(calls,0);
console.log('VENDOR SDK: integrity, exported client, session initialization and zero-network checks PASS');
