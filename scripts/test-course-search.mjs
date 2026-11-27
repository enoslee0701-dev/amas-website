// Historical command name retained for compatibility. Search/category UI was
// intentionally removed in d705546a. Since 2026-11-27 (Enos) the site shows only the
// B.Th curriculum (35 required + 13 electives); the degree-level filter row is hidden
// and the old 68 cards sit in <template id="courseArchive">, which must not render.
import {startHarness} from "./lib/sis-harness.mjs";
const h=await startHarness({profilePrefix:"amas-course-filter-"});
try{
 await h.open("index.html",{});
 const count=()=>h.ev(`document.querySelectorAll('.course-card:not(.hidden-card)').length`);
 h.ok("F1 collapsed catalog shows six cards",await count()===6);
 h.ok("F2 removed search/category inputs do not reappear",await h.ev(`!document.querySelector('#courseSearch')&&!document.querySelector('[data-filter]')`));
 h.ok("F3 degree-level filter row is not visible",await h.ev(`getComputedStyle(document.querySelector('.level-row')).display==='none'`));
 h.ok("F4 archived 68 cards are not rendered",await h.ev(`document.querySelectorAll('.course-card').length===48&&document.querySelector('#courseArchive').content.querySelectorAll('.course-card').length===68`));
 await h.click('#courseMoreBtn');
 h.ok("F5 expanding shows all 48 B.Th courses",await count()===48);
 h.ok("F6 35 required + 13 electives, all B.Th",await h.ev(`(()=>{const c=[...document.querySelectorAll('.course-card')];return c.filter(e=>e.dataset.kind==='required').length===35&&c.filter(e=>e.dataset.kind==='elective').length===13&&c.every(e=>e.dataset.level==='bth')})()`));
 for(const lang of ["zh","en","ko","th"]){await h.ev(`applyLanguage(${JSON.stringify(lang)});true`);h.ok(`F7 ${lang} keeps 48 courses with translated titles`,await count()===48&&await h.ev(`[...document.querySelectorAll('.course-card h3')].every(e=>e.textContent.trim())`));}
}catch(e){h.fail(e.stack||e.message);}
process.exit((await h.close("COURSE FILTERS"))?1:0);
