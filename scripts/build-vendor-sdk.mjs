// Rebuild the pinned browser SDK at the existing ES2020 syntax floor.
// No runtime CDN dependency. The version and esbuild version are exact.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const version='2.116.0',builder='0.25.10';
const url=`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${version}/dist/umd/supabase.min.js`;
const root=path.resolve(import.meta.dirname,'..'),dest=path.join(root,'assets/vendor',`supabase-js@${version}`);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'amas-sdk-build-'));
try{
 const original=execFileSync('curl',['-fsSL','--max-time','60',url]);fs.writeFileSync(path.join(temp,'source.js'),original);
 execFileSync('npx',['--yes',`esbuild@${builder}`,path.join(temp,'source.js'),'--target=es2020','--minify','--legal-comments=inline','--outfile='+path.join(temp,'built.js')],{stdio:'pipe'});
 const built=fs.readFileSync(path.join(temp,'built.js'));fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,'supabase.min.js'),built);
 fs.writeFileSync(path.join(dest,'BUILD.json'),JSON.stringify({version,source:url,esbuild:builder,target:'es2020',source_sha256:crypto.createHash('sha256').update(original).digest('hex'),output_sha256:crypto.createHash('sha256').update(built).digest('hex')},null,2)+'\n');
 console.log(`Built supabase-js ${version} for ES2020 (${built.length} bytes)`);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
