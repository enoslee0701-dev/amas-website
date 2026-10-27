// Historical command name retained for compatibility. Search/category UI was
// intentionally removed in d705546a; verify the approved degree filters instead.
import {startHarness} from "./lib/sis-harness.mjs";
const h=await startHarness({profilePrefix:"amas-course-filter-"});
try{
 await h.open("index.html",{});
 const count=()=>h.ev(`document.querySelectorAll('.course-card:not(.hidden-card)').length`);
 h.ok("F1 collapsed catalog shows six cards",await count()===6);
 h.ok("F2 removed search/category inputs do not reappear",await h.ev(`!document.querySelector('#courseSearch')&&!document.querySelector('[data-filter]')`));
 for(const [level,total] of [["bth",27],["mdiv",6],["dmin",18],["none",17]]){
  await h.click(`[data-level-filter="${level}"]`);
  h.ok(`F3 ${level} shows up to six matching cards`,await count()===Math.min(6,total)&&await h.ev(`[...document.querySelectorAll('.course-card:not(.hidden-card)')].every(e=>e.dataset.level===${JSON.stringify(level)})`));
  h.ok(`F4 ${level} active state accessible`,await h.ev(`document.querySelector('[data-level-filter="${level}"]').getAttribute('aria-pressed')==='true'`));
  if(total>6){await h.click('#courseMoreBtn');h.ok(`F5 ${level} expands complete catalog`,await count()===total);await h.click('#courseMoreBtn');}
 }
 await h.click('[data-level-filter="all"]');await h.click('#courseMoreBtn');h.ok("F6 all approved courses are reachable",await count()===68);
 for(const lang of ["zh","en","ko","th"]){await h.ev(`applyLanguage(${JSON.stringify(lang)});true`);h.ok(`F7 ${lang} maintains selection and course counts`,await count()===68&&await h.ev(`document.querySelector('[data-level-filter="all"]').getAttribute('aria-pressed')==='true'`));}
}catch(e){h.fail(e.stack||e.message);}
process.exit((await h.close("COURSE FILTERS"))?1:0);
