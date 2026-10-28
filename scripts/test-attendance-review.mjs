import {startHarness,sleep} from './lib/sis-harness.mjs';
const h=await startHarness({profilePrefix:'amas-review-',shotPrefix:'attendance-review'});
const month=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit'}).format(new Date()).slice(0,7)+'-01';
const data={cohort:'10月班',month,sessions:[{id:'session-1',day:month,title:'测试课次',roster_frozen:true,expected:2,unmarked:1}],students:[{submission_id:1,name:'=测试姓名',expected:1,present:1,late:0,excused:0,absent:0,unmarked:0},{submission_id:2,name:'测试乙',expected:1,present:0,late:0,excused:0,absent:0,unmarked:1}]};
const scen=role=>({session:{user:{id:'review-fixture'}},aal:'aal2',tables:{submission_cohorts:{data:[{name:'10月班'}]}},rpc:{my_roles:{data:[{role}]},mfa_required:{data:false},my_profile:{data:{display_name:'测试教务'}},admin_attendance_month:{data},admin_attendance_history:{data:{rows:[{id:2,held_on:month,title:'测试课次',name:'测试乙',actor_name:'测试负责人',created_at:month+'T00:00:00Z',operation:'update',old_status:'absent',new_status:'excused',old_note:'',new_note:'已提前请假'}],next_before:null,legacy_saves:0}}}});
try{
 await h.open('portal/admin/attendance/',scen('super_admin'));
 h.ok('R1 monthly report displays unmarked separately',(await h.txt()).includes('未登记 1 人次')&&await h.ev(`document.querySelectorAll('[data-day]').length>=28&&document.querySelectorAll('.review-table tbody tr').length===2`));
 h.ok('R2 history shows actor and before/after',(await h.txt()).includes('缺席 → 请假')&&(await h.txt()).includes('测试负责人')&&(await h.txt()).includes('已提前请假'));
 h.ok('R3 history does not contain academic or finance fields',!(await h.txt()).match(/private homework|health-secret|finance-secret/));
 await h.click('[data-day="'+month+'"]');h.ok('R4 calendar selects day',await h.ev(`document.querySelector('[data-day="${month}"]').getAttribute('aria-pressed')==='true'&&document.querySelectorAll('#lessonList article').length===1`));
 await h.ev(`window.__csv=null;URL.createObjectURL=b=>{window.__csv=b;return 'blob:test-only'};HTMLAnchorElement.prototype.click=function(){};true`);await h.click('#export');h.ok('R5 CSV is formula-safe and includes unmarked',await h.ev(`(async()=>{const s=await window.__csv.text();return s.includes("'=测试姓名")&&s.includes('未登记')&&s.includes('测试乙')})()`));
 for(const width of [320,390,1280]){await h.send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width<600});h.ok('R6 responsive '+width,await h.ev(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.calendar button')].every(b=>b.getBoundingClientRect().height>=44)`));}
 await h.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await h.shot('mobile');
 const broken=scen('registrar');broken.rpc.admin_attendance_month={data:null,error:{message:'network'}};await h.open('portal/admin/attendance/',broken);h.ok('R7 read failure is not empty data',(await h.txt()).includes('读取失败')&&await h.ev(`!document.querySelector('#export')`));
 for(const role of ['student','finance','attendance_clerk']){await h.open('portal/admin/attendance/',scen(role));await sleep(100);h.ok('R8 denied '+role,!(await h.rpcCalls('admin_attendance_month')).length&&await h.ev(`!document.querySelector('#reviewContent')`));}
 h.ok('R9 no external requests',h.external()===0);
}catch(e){h.fail(e.stack||String(e));}
process.exitCode=await h.close('ATTENDANCE REVIEW');
