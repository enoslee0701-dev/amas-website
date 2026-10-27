// Actual HTTP handlers and Supabase SDK, local synthetic backend; no hosted auth.
const name=Deno.args[0];
const allowed=['create-teacher-invitation','review-teacher-verification'].includes(name)?['academic_admin','super_admin']:['registrar','academic_admin','super_admin'];
const privileged=['create-teacher-invitation','review-teacher-verification','review-application','student-lifecycle','sis-admin'].includes(name);
let currentRole='super_admin',validUser=true,expired=false,rpcDenied=false;const writes:string[]=[];
const nativeServe=Deno.serve.bind(Deno);
const stub=nativeServe({hostname:'127.0.0.1',port:0},async req=>{
 const u=new URL(req.url);
 if(u.pathname==='/auth/v1/user')return validUser?Response.json({id:'00000000-0000-4000-8000-000000000002',email:'audit@example.invalid',email_confirmed_at:'2026-01-01T00:00:00Z'}):Response.json({msg:'invalid JWT'},{status:401});
 if(u.pathname==='/rest/v1/user_roles'){
  // PostgREST applies only requested expiry predicates; omitting them keeps expired rows.
  const expiryFiltered=[...u.searchParams.keys()].some(k=>k==='expires_at'||k==='or');
  return Response.json(expired&&expiryFiltered?[]:[{role:currentRole,expires_at:expired?'2020-01-01T00:00:00Z':null}]);
 }
 if(u.pathname==='/rest/v1/rpc/mfa_required')return Response.json(true);
 if(rpcDenied&&u.pathname.startsWith('/rest/v1/rpc/'))return Response.json({code:'42501',message:'permission denied at the authoritative write boundary'},{status:403});
 if(u.pathname==='/rest/v1/rpc/create_teacher_invitation'){writes.push(u.pathname);return Response.json({ok:true,id:'00000000-0000-4000-8000-000000000009',expires_at:'2026-11-01T00:00:00Z'});}
 if(req.method==='POST')writes.push(u.pathname);
 if(u.pathname==='/rest/v1/teacher_invitations')return Response.json({id:'00000000-0000-4000-8000-000000000009'});
 if(u.pathname==='/rest/v1/audit_logs')return Response.json([]);
 if(u.pathname.startsWith('/rest/v1/rpc/'))return Response.json({ok:true});
 return Response.json([]);
});
const stubPort=(stub.addr as Deno.NetAddr).port;
Deno.env.set('SUPABASE_URL',`http://127.0.0.1:${stubPort}`);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','local-stub-not-a-credential');Deno.env.set('SUPABASE_ANON_KEY','local-stub-not-a-credential');
let edge:Deno.HttpServer;
Deno.serve=((handler:any)=>{edge=nativeServe({hostname:'127.0.0.1',port:0},handler);return edge;}) as any;
await import(new URL(`../supabase/functions/${name}/index.ts`,import.meta.url).href);
Deno.serve=nativeServe as any;
const port=(edge!.addr as Deno.NetAddr).port;
const b64=(o:unknown)=>btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const token=(aal='aal2')=>`x.${b64({aal,sub:'00000000-0000-4000-8000-000000000002'})}.y`;
let pass=0,fail=0;
const check=(label:string,ok:boolean,detail:unknown)=>{console.log(`${ok?'PASS':'FAIL'} ${name} ${label} ${JSON.stringify(detail)}`);ok?pass++:fail++;};
async function request(body:string,auth:string|null=token(),method='POST'){
 const response=await fetch(`http://127.0.0.1:${port}/`,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+auth}:{})},...(method==='POST'?{body}:{})});
 const text=await response.text();let data:any={};try{data=JSON.parse(text);}catch{}
 return {status:response.status,error:data.error};
}
try{
 let r=await request('{}',null,'GET');check('GET rejected',r.status===405,r);
 validUser=false;r=await request('{}',null);check('no valid identity rejected',name==='login-by-identifier'?r.status===400:[401,403].includes(r.status),r);validUser=true;
 if(privileged){
  for(const role of ['applicant','student','teacher','mentor','registrar','finance','content_admin','academic_admin','super_admin']){
   currentRole=role;r=await request('{}');const expected=allowed.includes(role)?400:403;
   check(`role=${role} empty body boundary`,r.status===expected,{...r,expected});
  }
  currentRole='super_admin';r=await request('{}',token('aal1'));check('aal1 rejected with MFA enabled',r.status===403&&r.error==='mfa_required',r);
 }
 currentRole='super_admin';
 for(const body of ['{','null','[]','42','"text"']){r=await request(body);check(`malformed/nonobject body ${body} rejected as 4xx`,r.status>=400&&r.status<500,r);}
 const validBodies:Record<string,unknown>={
  'sis-admin':{action:'create_offering',course_code:'c_matthew',academic_year:'2026-2027'},
  'student-lifecycle':{action:'create_student_record',application_id:'00000000-0000-4000-8000-000000000009'},
  'review-teacher-verification':{action:'approve',request_id:'00000000-0000-4000-8000-000000000009'},
  'review-application':{action:'accept',application_id:'00000000-0000-4000-8000-000000000009'},
  'create-teacher-invitation':{email:'synthetic@example.invalid'},
 };
 if(validBodies[name]){rpcDenied=true;r=await request(JSON.stringify(validBodies[name]));check('authoritative DB permission denial returns 403, never a server-failure retry',r.status===403&&r.error==='forbidden',r);rpcDenied=false;}
 if(name==='create-teacher-invitation'){
  r=await request('{"email":"synthetic@example.invalid"}');
  check('valid invitation uses the atomic caller-authenticated RPC',r.status===200&&writes.includes('/rest/v1/rpc/create_teacher_invitation')&&!writes.includes('/rest/v1/teacher_invitations'),r);
  const beforeWrites=writes.length;
  expired=true;r=await request('{"email":"synthetic@example.invalid"}');
  check('expired admin cannot create invitation',r.status===403&&writes.length===beforeWrites,{...r,writes});expired=false;
 }
}finally{await edge!.shutdown();await stub.shutdown();}
console.log(`EDGE MATRIX ${name}: ${pass} PASS / ${fail} FAIL`);Deno.exit(fail?1:0);
