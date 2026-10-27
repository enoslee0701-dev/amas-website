// Real portal code with fixed aggregate/page fixtures. SQL behavior is covered
// independently by supabase/tests/finance_acceptance.sql.
import { startHarness, sleep } from './lib/sis-harness.mjs';
const h=await startHarness({profilePrefix:'amas-finance-security-'});
const PERSON={id:11,name:'测试学员',cohort:'测试班',balances:{THB:{charge:1001,payment:0,waiver:0,refund:0}}};
const ENTRY={id:'00000000-0000-4000-8000-000000000011',submission_id:11,kind:'charge',category:'学费',amount:1,currency:'THB',occurred_on:'2026-10-27',created_at:'2026-10-27T00:00:00Z'};
const scen=(role='finance')=>({session:{user:{id:'finance-fixture',email:'f@example.invalid'}},aal:'aal2',rpc:{my_roles:{data:[{role}]},mfa_required:{data:true},finance_people_page:{data:{rows:[PERSON],next_after:null}},finance_totals:{data:{THB:{charge:1001,payment:0,waiver:0,refund:0}}},finance_entries_page:{data:{rows:[ENTRY],snapshot:'2026-10-27T00:00:01Z',next:null}},finance_record:{data:null,error:{message:'Failed to fetch'}}}});
try{
 await h.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await h.open('portal/admin/finance/',scen());
 h.ok('F1 server total >1000 is displayed independently from one detail row',(await h.txt()).includes('฿1,001'));
 h.ok('F2 finance menu omits admissions/roles',await h.ev(`![...document.querySelectorAll('.pn-list a')].some(a=>/admissions|students|roles/.test(a.href))`));
 await h.setVal('#who','11');await h.setVal('#amt','100');await h.click('#add');await sleep(150);
 let calls=await h.rpcCalls('finance_record');const first=calls[0]?.args;
 h.ok('F3 write uses server API with stable UUID, no caller-supplied actor',first&&/^[0-9a-f-]{36}$/i.test(first.p_request)&&!('created_by' in first.p_entries[0]));
 h.ok('F4 ambiguous result keeps request and blocks new booking',await h.ev(`!!document.querySelector('#reconcile')&&document.querySelector('#add').disabled`));
 await h.setVal('#amt','999');await h.click('#add');await sleep(100);
 h.ok('F5 cannot create another request after ambiguous result',(await h.rpcCalls('finance_record')).length===1);
 await h.open('portal/admin/finance/',scen());
 h.ok('F6 reload preserves operation to reconcile',await h.ev(`!!document.querySelector('#reconcile')&&document.querySelector('#add').disabled`));
 await h.ev(`window.__SCEN.rpc.finance_record={data:{ok:true,count:1,ids:['e1']}};true`);await h.click('#reconcile');await sleep(200);
 calls=await h.rpcCalls('finance_record');
 h.ok('F7 reload/retry sends exact original ID and amount',calls[0]?.args.p_request===first.p_request&&calls[0]?.args.p_entries[0].amount===100);
 h.ok('F8 committed result clears pending and amount to prevent double click',await h.ev(`!document.querySelector('#reconcile')&&document.querySelector('#amt').value===''&&!document.querySelector('#add').disabled`));
 await h.click('#add');await sleep(100);
 h.ok('F9 second click without amount cannot book again',(await h.rpcCalls('finance_record')).length===1);
 // Bounded people pages: the second page is explicitly required, never silently truncated.
 const paging=scen();paging.rpc.finance_people_page={queue:[{data:{rows:[PERSON],next_after:11}},{data:{rows:[{...PERSON,id:12,name:'第二页学员'}],next_after:null}}]};
 paging.rpc.finance_entries_page={queue:[{data:{rows:[ENTRY],snapshot:'2026-10-27T00:00:01Z',next:{created_at:ENTRY.created_at,id:ENTRY.id}}},{data:{rows:[{...ENTRY,id:'00000000-0000-4000-8000-000000000012'}],snapshot:'2026-10-27T00:00:01Z',next:null}}]};
 await h.open('portal/admin/finance/',paging);
 h.ok('F10 all protected people pages fetched',(await h.rpcCalls('finance_people_page')).length===2&&(await h.txt()).includes('第二页学员'));
 await h.setVal('#amt','456');await h.click('#more');await sleep(150);
 h.ok('F11 detail pagination appends records and preserves unfinished form',(await h.rpcCalls('finance_entries_page')).length===2&&await h.ev(`document.querySelector('#amt').value==='456'&&!document.querySelector('#more')`));
 // Role landing destinations, without granting finance access to the admin overview.
 await h.open('portal/',scen());await sleep(300);
 h.ok('F12 finance default landing reaches its own page',await h.ev(`location.pathname.endsWith('/portal/admin/finance/')&&!!document.querySelector('#add')`));
 const content=scen('content_admin');content.tables={site_announcements:{data:[]},site_settings:{data:[]}};content.rpc.content_cohorts={data:[]};
 await h.open('portal/',content);await sleep(300);
 h.ok('F13 content default landing reaches content page only',await h.ev(`location.pathname.endsWith('/portal/admin/board/')&&!!document.querySelector('#anSave')&&![...document.querySelectorAll('.pn-list a')].some(a=>/finance|admissions|students|roles/.test(a.href))`));
 const combined=scen('content_admin');combined.rpc.my_roles={data:[{role:'content_admin'},{role:'finance'}]};combined.rpc.content_cohorts={data:[]};combined.tables={site_announcements:{data:[]},site_settings:{data:[]}};
 await h.open('portal/',combined);await sleep(300);
 h.ok('F15 combined finance/content has one admin workspace with both scoped links',await h.ev(`location.pathname.endsWith('/portal/admin/board/')&&[...document.querySelectorAll('.pn-list a')].some(a=>a.href.endsWith('/finance/'))&&![...document.querySelectorAll('.pn-list a')].some(a=>a.href.endsWith('/admissions/'))`));
 const registrar=scen('registrar');registrar.rpc.my_roles={data:[{role:'registrar'},{role:'finance'}]};
 await h.open('portal/',registrar);await sleep(300);
 h.ok('F16 registrar+finance does not create a redundant workspace chooser',await h.ev(`location.pathname.endsWith('/portal/admin/')&&!document.querySelector('#portalBlockedTitle')`));
 const broken=scen();broken.rpc.finance_people_page={data:{rows:[PERSON],next_after:0}};
 await h.open('portal/admin/finance/',broken);
 h.ok('F14 invalid/non-progressing cursor fails visibly, not incomplete totals',(await h.txt()).includes('没能完整读到费用记录'));
 const malformed=scen();malformed.rpc.finance_record={data:{ok:true,count:0}};
 await h.open('portal/admin/finance/',malformed);await h.setVal('#who','11');await h.setVal('#amt','100');await h.click('#add');await sleep(150);
 h.ok('F17 malformed success receipt retains operation for reconciliation',await h.ev(`!!document.querySelector('#reconcile')&&document.querySelector('#add').disabled`));
}catch(e){h.fail(e.stack||e.message);}
process.exit((await h.close('FINANCE SECURITY'))?1:0);
