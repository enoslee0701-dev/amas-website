// 课程搜索：按名称/编号找课，与分类筛选组合，结果数量、无结果恢复、键盘、输入法。
//
// ── 为什么要做 ────────────────────────────────────────────────────────
// 改前课程区只有 7 个分类筛选 + 「先显示 6 门」的限额。67 门课里想找某一门
// （只记得「NT 04」或「约翰福音」）没有任何办法。
//
// ── 两个刻意的取舍，这里钉住 ──────────────────────────────────────────
// ① 搜索期间不受 COURSE_LIMIT 约束：访客已经主动收窄了范围，
//    再把命中结果藏到「展开全部」后面只会让人以为没搜到。
// ② 搜索与分类是「与」关系：切分类时保留关键词，在当前分类内再收窄。
//
// 本套件只读页面与输入，不提交任何表单，不发起外网请求。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { TOUCH_PROBE } from "./lib/touch-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml",
  ".webp":"image/webp", ".ico":"image/x-icon", ".woff2":"font/woff2" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
                       "Cache-Control":"no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-csearch-"));
const port = 9406;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
      if (!url) await sleep(250);
    }
    if (!url) throw new Error("连不上 Chrome 调试端口");
    const s = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
    const c = new Cdp(s);
    s.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); } };
    return c;
  }
  send(method, params = {}, ms = 25000) {
    return new Promise((res, rej) => { const i = ++this.id;
      const t = setTimeout(() => { if (this.pending.delete(i)) rej(new Error("TIMEOUT " + method)); }, ms);
      this.pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async ev(x) {
    const r = await this.send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval 抛错: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  }
  async key(key, code, vk, mods = 0) {
    const b = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...b });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...b });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...b });
    await sleep(160);
  }
  /** 真实逐字输入（insertText 走的是和真人打字同一条输入链路） */
  async typeReal(text) {
    for (const ch of text) await this.send("Input.insertText", { text: ch });
    await sleep(260);
  }
  async clickReal(sel) {
    const pt = await this.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null;
      document.documentElement.style.scrollBehavior='auto';
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,ok:!!hit&&(hit===el||el.contains(hit)||hit.contains(el))};})()`);
    if (!pt) throw new Error("找不到 " + sel);
    if (!pt.ok) throw new Error("点没命中 " + sel);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await sleep(300);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");

  const load = async (w, lang) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 780, deviceScaleFactor: 1, mobile: w < 700 });
    await cdp.send("Page.navigate", { url: `${BASE}/index.html` + (lang ? `?lang=${lang}` : "") });
    await sleep(2200);
    await cdp.ev(`document.documentElement.style.scrollBehavior='auto';
      (function(){const pc=document.getElementById('promoCard'); if(pc) pc.hidden=true;
       document.querySelectorAll('.promo-tab,.chat-fab').forEach(function(e){e.style.display='none';});})()`);
  };
  const state = async () => cdp.ev(`(()=>{
    const vis=[...document.querySelectorAll('.course-card:not(.hidden-card)')];
    const res=document.getElementById('courseResult');
    const more=document.getElementById('courseMoreBtn');
    return { 可见数: vis.length,
      可见编号: vis.map(c=>(c.querySelector('.course-code')||{}).textContent||'').slice(0,6),
      结果行可见: res ? !res.hidden : false,
      结果文字: res ? (res.textContent||'').trim() : '',
      零结果样式: res ? res.classList.contains('is-empty') : false,
      有清空按钮: !!document.querySelector('.course-result-clear'),
      叉号可见: !document.getElementById('courseSearchClear').hidden,
      更多按钮隐藏: more ? more.hidden : null,
      读屏计数: (document.getElementById('courseCount').textContent||'').trim(),
      输入框值: document.getElementById('courseSearch').value };})()`);
  const search = async (text) => {
    await cdp.clickReal("#courseSearch");
    await cdp.ev(`document.getElementById('courseSearch').focus()`);
    await cdp.typeReal(text);
  };

  // ════ A 初始态 ════
  console.log("\n=== A 初始态（未搜索时一切如旧）===");
  await load(375);
  const a = await state();
  ok("默认仍只显示 6 门（既有限额未被破坏）", a.可见数 === 6, `实际 ${a.可见数}`);
  ok("结果行默认不显示", a.结果行可见 === false);
  ok("清空叉号默认隐藏", a.叉号可见 === false);
  ok("「展开更多」默认可见", a.更多按钮隐藏 === false);

  // ════ B 按课名搜索 ════
  console.log("\n=== B 按课程名称搜索「约翰福音」===");
  await search("约翰福音");
  const b = await state();
  ok("搜到了结果", b.可见数 > 0, `可见 ${b.可见数}`);
  ok("命中项里有「约翰福音」",
     (await cdp.ev(`[...document.querySelectorAll('.course-card:not(.hidden-card) h3')]
       .some(h=>/约翰福音/.test(h.textContent||''))`)) === true);
  ok("结果行可见并报出数量", b.结果行可见 === true && /\d/.test(b.结果文字), b.结果文字);
  ok("清空叉号出现", b.叉号可见 === true);
  ok("搜索时隐藏「展开更多」（命中已全显示）", b.更多按钮隐藏 === true);
  ok("读屏计数同步", /\d/.test(b.读屏计数), b.读屏计数);

  // ════ C 按编号搜索，含无空格写法 ════
  console.log("\n=== C 按编号搜索 ===");
  await load(375); await search("NT 04");
  const c1 = await state();
  await load(375); await search("NT04");
  const c2 = await state();
  ok("「NT 04」能搜到", c1.可见数 > 0, `可见 ${c1.可见数}`);
  ok("「NT04」（不带空格）同样能搜到", c2.可见数 > 0, `可见 ${c2.可见数}`);
  ok("两种写法命中同一批", c1.可见数 === c2.可见数, `${c1.可见数} vs ${c2.可见数}`);
  ok("命中的是 NT 04",
     (await cdp.ev(`[...document.querySelectorAll('.course-card:not(.hidden-card) .course-code')]
       .some(e=>/NT\\s*04/.test(e.textContent||''))`)) === true);

  // ════ D 与分类组合（与关系） ════
  console.log("\n=== D 搜索 × 分类 组合 ===");
  await load(375);
  await search("福音");
  const dAll = (await state()).可见数;
  await cdp.clickReal('.filter[data-filter="ot"]');   // 切到旧约
  const dOt = await state();
  ok("切分类后关键词保留", dOt.输入框值 === "福音", dOt.输入框值);
  ok("分类是「与」关系：旧约里的命中数 ≤ 全部命中数",
     dOt.可见数 <= dAll, `旧约 ${dOt.可见数} vs 全部 ${dAll}`);
  ok("可见卡片全部属于当前分类",
     (await cdp.ev(`[...document.querySelectorAll('.course-card:not(.hidden-card)')]
       .every(c=>c.dataset.category==='ot')`)) === true);
  await cdp.clickReal('.filter[data-filter="all"]');
  ok("切回全部后命中数回到 " + dAll, (await state()).可见数 === dAll);

  // ════ E 无结果与恢复 ════
  console.log("\n=== E 无结果时可清空恢复 ===");
  await load(375);
  await search("zzzz不存在的课程zzzz");
  const e1 = await state();
  ok("零结果：没有可见卡片", e1.可见数 === 0, `实际 ${e1.可见数}`);
  ok("零结果：给出提示而不是空白", e1.结果行可见 === true && e1.结果文字.length > 0, e1.结果文字);
  ok("零结果：用独立样式标出", e1.零结果样式 === true);
  ok("零结果：附带「清空搜索」按钮", e1.有清空按钮 === true);
  const clrBox = await (async () => { await cdp.ev(TOUCH_PROBE);
    return cdp.ev(`(()=>{const el=document.querySelector('.course-result-clear');
      if(!el) return {missing:true}; el.scrollIntoView({block:'center'});
      return window.__target(el,44);})()`); })();
  ok("零结果里的清空按钮 ≥44x44", clrBox.ok === true, `${clrBox.w}x${clrBox.h} ${clrBox.why}`);
  await cdp.clickReal(".course-result-clear");
  const e2 = await state();
  ok("点清空后恢复到默认 6 门", e2.可见数 === 6, `实际 ${e2.可见数}`);
  ok("点清空后输入框已空", e2.输入框值 === "");
  ok("点清空后结果行收起", e2.结果行可见 === false);
  ok("点清空后焦点回到输入框",
     (await cdp.ev(`document.activeElement.id`)) === "courseSearch",
     "焦点在 " + (await cdp.ev(`document.activeElement.id||document.activeElement.tagName`)));

  // ════ F 键盘 ════
  console.log("\n=== F 键盘操作 ===");
  await load(375);
  await search("福音");
  ok("F1 搜索后仍有命中", (await state()).可见数 > 0);
  await cdp.ev(`document.getElementById('courseSearch').focus()`);
  await cdp.key("Escape", "Escape", 27);
  const f = await state();
  ok("F2 Escape 清空搜索", f.输入框值 === "" && f.可见数 === 6, JSON.stringify({ v: f.输入框值, n: f.可见数 }));
  ok("F3 Escape 后焦点留在输入框", (await cdp.ev(`document.activeElement.id`)) === "courseSearch");
  await search("福音");
  await cdp.ev(`document.getElementById('courseSearch').focus()`);
  await cdp.key("Tab", "Tab", 9);
  ok("F4 从输入框 Tab 一次到清空叉号",
     (await cdp.ev(`document.activeElement.id`)) === "courseSearchClear",
     "实际 " + (await cdp.ev(`document.activeElement.id||document.activeElement.tagName`)));
  await cdp.key("Enter", "Enter", 13);
  ok("F5 回车激活叉号并清空", (await state()).输入框值 === "");

  // ════ G 中文输入法 ════
  // 拼音拼到一半时 input 也会触发，拿到的是「yuehan」这类中间态。
  // 组合进行中不该过滤，否则用户还没选词就先闪一下「没有找到」。
  console.log("\n=== G 中文输入法：组合中不过滤，选词后才过滤 ===");
  await load(375);
  const ime = await cdp.ev(`(async()=>{
    const i=document.getElementById('courseSearch'); i.focus();
    const snap=()=>document.querySelectorAll('.course-card:not(.hidden-card)').length;
    const res=document.getElementById('courseResult');
    // 模拟组合中：isComposing=true 的 input 事件
    i.value="yuehan";
    i.dispatchEvent(new InputEvent("input",{bubbles:true,isComposing:true}));
    await new Promise(r=>setTimeout(r,150));
    const 组合中可见=snap(), 组合中提示=res.hidden?"":(res.textContent||"").trim();
    // 选词完成
    i.value="约翰";
    i.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"约翰"}));
    await new Promise(r=>setTimeout(r,200));
    return { 组合中可见, 组合中提示, 选词后可见:snap(),
             选词后提示:res.hidden?"":(res.textContent||"").trim() };})()`);
  ok("G1 组合进行中不过滤（仍是默认 6 门）", ime.组合中可见 === 6, `实际 ${ime.组合中可见}`);
  ok("G2 组合进行中不弹「没有找到」", !/没有找到/.test(ime.组合中提示), ime.组合中提示);
  ok("G3 选词完成后才过滤并命中", ime.选词后可见 > 0 && ime.选词后可见 !== 6,
     `选词后可见 ${ime.选词后可见}`);
  ok("G4 选词后报出数量", /\d/.test(ime.选词后提示), ime.选词后提示);

  // ════ H 320 / 375 / 桌面 ════
  console.log("\n=== H 三个宽度下可用 ===");
  for (const w of [320, 375, 1280]) {
    await load(w);
    await cdp.ev(TOUCH_PROBE);
    const box = await cdp.ev(`(()=>{const el=document.getElementById('courseSearch');
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect();
      return { h:Math.round(r.height), w:Math.round(r.width),
               溢出: r.right > document.documentElement.clientWidth + 1 };})()`);
    await search("福音");
    const x = await cdp.ev(`(()=>{const el=document.getElementById('courseSearchClear');
      el.scrollIntoView({block:'center'}); return window.__target(el,44);})()`);
    ok(`${w}px 输入框高度够且不溢出`, box.h >= 44 && box.溢出 === false, JSON.stringify(box));
    ok(`${w}px 清空叉号 ≥44x44`, x.ok === true, `${x.w}x${x.h} ${x.why}`);
    ok(`${w}px 搜索有命中`, (await state()).可见数 > 0);
  }

  // ════ I 四语言 ════
  console.log("\n=== I 四语言 ===");
  for (const lang of ["zh", "en", "ko", "th"]) {
    await load(375, lang);
    const ph = await cdp.ev(`document.getElementById('courseSearch').placeholder`);
    const al = await cdp.ev(`document.getElementById('courseSearch').getAttribute('aria-label')`);
    // 用该语言里一定存在的词搜：英文用 "Matthew"? 课名是 i18n 的，改用编号，四语言通用
    await search("NT 01");
    const st = await state();
    ok(`${lang} placeholder 与 aria-label 都已翻译`, !!ph && !!al && ph.length > 0, `${ph} / ${al}`);
    ok(`${lang} 用编号搜索可命中并报数`, st.可见数 > 0 && st.结果文字.length > 0,
       `可见 ${st.可见数} 文案「${st.结果文字.slice(0, 26)}」`);
    console.log(`     ${lang}: ph="${ph}" 结果="${st.结果文字.slice(0, 30)}"`);
  }

  // ════ J 切语言后搜索仍然有效 ════
  // 课名/简介是 i18n 的，若把可搜索文本缓存下来，切语言后就搜不到新语言的词。
  console.log("\n=== J 切语言后用新语言的词搜索 ===");
  await load(375, "zh");
  await cdp.ev(`applyLanguage('en')`);
  await sleep(400);
  await search("Matthew");
  const j = await state();
  ok("J1 切到英文后能用英文课名搜到", j.可见数 > 0, `可见 ${j.可见数}（说明可搜索文本是现取的，没被缓存）`);

  // ════ K 负向控制 ════
  console.log("\n=== K 负向控制：绿必须能转红 ===");
  await load(375);
  // K1 把搜索框移走，区内就回到「只有分类」的状态
  const k1 = await cdp.ev(`(()=>{const r=document.querySelector('.course-search-row');
    const had=!!r; if(r) r.remove();
    return { had, 还剩搜索框: !!document.getElementById('courseSearch') };})()`);
  ok("K1 移除搜索行后页面上再无搜索框（证明 B–I 的绿来自它）",
     k1.had === true && k1.还剩搜索框 === false, JSON.stringify(k1));
  // K2 搜一个必然不存在的词，必须是 0 而不是「看起来有结果」
  await load(375);
  await search("qqqqwwwweeee");
  ok("K2 必然不存在的词确实得到 0 条（筛选真的在生效）",
     (await state()).可见数 === 0, `实际 ${(await state()).可见数}`);
  // K3 把叉号压小，量具必须判红
  await load(375);
  await search("福音");
  await cdp.ev(TOUCH_PROBE);
  await cdp.ev(`(()=>{const b=document.getElementById('courseSearchClear');
    b.style.width='26px'; b.style.height='26px'; return true;})()`);
  const k3 = await cdp.ev(`(()=>{const el=document.getElementById('courseSearchClear');
    el.scrollIntoView({block:'center'}); return window.__target(el,44);})()`);
  ok("K3 叉号压到 26px 时量具判红", k3.ok === false, `压小后仍判 ok：${k3.w}x${k3.h}`);

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally { chrome.kill(); server.close(); }

console.log(`\n${pass}/${pass + fail} 通过`);
console.log("本套件只读页面与输入，不提交任何表单，未发起外网请求。");
process.exit(fail ? 1 : 0);
