// Student-home simplification: current identity and historical events stay distinct.
import {startHarness,sleep} from './lib/sis-harness.mjs';
const h=await startHarness({profilePrefix:'amas-student-home-',shotPrefix:'student-home'});
const REC={id:'rec-1',student_number:'B26-TEST',status:'active',program_code:'bth',created_at:'2026-10-26T05:12:00Z',activated_at:'2026-10-26T12:53:00Z'};
const scene=(status='active')=>({session:{user:{id:'student-fixture',email:'s@example.invalid'}},rpc:{
 my_roles:{data:[{role:'student'}]},my_profile:{data:{display_name:'测试学员'}},my_student_record:{data:[{...REC,status}]},
 my_student_timeline:{data:[{from_status:null,to_status:'pre_enrolled',created_at:REC.created_at},{from_status:'pre_enrolled',to_status:'active',created_at:REC.activated_at,student_visible_message:'欢迎正式成为学员！'}]},
 my_action_items:{data:[{source_type:'christian_profile',title:'建立你的信仰成长档案',status:'open',target_url:'discover.html'},{source_type:'profile',title:'完善联系方式',reason:'请填写联系电话',status:'open',target_url:'portal/student/profile/'}]},
 my_learning:{data:Array.from({length:68},(_,i)=>({code:'c'+i,availability:i<45?'available':'unavailable'}))},
 my_courses:{data:[{offering_id:'one',offering_status:'in_progress'}]},my_progress:{data:{credits_earned:3,credits_required:77,gpa:null}},portal_board:{data:{announcements:[{title:'课堂通知',body:'按时参加课程',created_at:REC.created_at}]}}
},tables:{program_catalog:{data:[{code:'bth',name_zh:'神学学士'}]}}});
try{
 await h.open('portal/student/',scene());
 let text=await h.txt();
 h.ok('H1 active identity badge belongs to blue card',await h.ev(`document.querySelector('.idcard [aria-label="当前学籍状态"]').textContent==='正式学员 · 在读'`));
 h.ok('H2 no separate status module',await h.ev(`![...document.querySelectorAll('h3')].some(e=>e.textContent==='学籍状态')`));
 h.ok('H3 no availability/completeness counts',!(/45|已有线上学习内容|正式课程共/.test(text)));
 h.ok('H4 no catalog-content statistics/capabilities RPC',(await h.rpcCalls('my_learning')).length===0&&(await h.rpcCalls('my_student_capabilities')).length===0);
 h.ok('H5 growth card and derived growth todo both removed',!(/信仰成长档案|快速探索/.test(text))&&await h.ev(`![...document.querySelectorAll('a')].some(a=>a.href.includes('discover.html'))`));
 h.ok('H6 real contact todo still actionable',await h.ev(`[...document.querySelectorAll('.act')].some(e=>e.textContent.includes('完善联系方式')&&e.querySelector('a').href.endsWith('/portal/student/profile/'))`));
 h.ok('H7 initial history is an event, not current registration pending',await h.ev(`document.querySelector('#tl').textContent.includes('学籍已建立')&&document.querySelector('#tl').textContent.includes('完成正式注册')&&!document.querySelector('#tl').textContent.includes('待正式注册')`));
 h.ok('H8 learning/course/credit and announcement entries retained',text.includes('我的学习')&&text.includes('我的课程')&&text.includes('学分与成绩')&&text.includes('课堂通知'));
 h.ok('H9 mobile page fits width',await h.ev(`document.documentElement.scrollWidth<=innerWidth`));
 await h.shot('mobile');
 await h.open('portal/student/',scene('pre_enrolled'));
 h.ok('H10 genuinely pending student is not mislabeled active',await h.ev(`document.querySelector('.idcard .badge').textContent==='待正式注册'`));
 await h.open('portal/student/',scene('on_leave'));
 h.ok('H11 leave status remains visible on blue card',await h.ev(`document.querySelector('.idcard .badge').textContent==='休学中'`));
 const onlyGrowth=scene();onlyGrowth.rpc.my_action_items.data=onlyGrowth.rpc.my_action_items.data.slice(0,1);
 await h.open('portal/student/',onlyGrowth);
 h.ok('H12 filtered-only task set has a proper empty state',(await h.txt()).includes('目前没有需要你处理的事项'));
 const broken=scene();broken.rpc.my_student_timeline={error:{message:'network'}};
 await h.open('portal/student/',broken);
 h.ok('H13 timeline read failure is not reported as no history',(await h.txt()).includes('没能读到最近活动'));
 const resumed=scene();resumed.rpc.my_student_timeline={data:[{from_status:'on_leave',to_status:'active',created_at:REC.activated_at}]};
 await h.open('portal/student/',resumed);
 h.ok('H15 return from leave is not mislabeled initial registration',await h.ev(`document.querySelector('#tl').textContent.includes('办理复学')&&!document.querySelector('#tl').textContent.includes('完成正式注册')`));
 h.ok('H14 no external requests',h.external()===0);
}catch(e){h.fail(e.stack||String(e));}
process.exitCode=await h.close('STUDENT HOME LAYOUT');
