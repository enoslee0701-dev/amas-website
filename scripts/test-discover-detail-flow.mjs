// discover 完整产品流程：答题 → 结果 → 倾向说明 → 返回 → 重测。
//
// ── 一条必须写在最前面的产品事实 ──────────────────────────────────────
// 本页测验评的是 5 个 AREAS（bible / doctrine / devotion / service / disciple，10 题），
// 而倾向说明页讲的是 12 个 ARCH（teacher / shepherd / evangelist …）。
// **两套 key 完全不相交，测验不产出任何「对应倾向」。** 页面自己也写着两处：
//   结果页结论：「…不用于定义你的事奉类型。」
//   解锁区：   「12 项事奉倾向…由 30 / 84 题的独立评分得出」（即 App 内的独立评估）
// 所以结果页到倾向说明的入口只能是**中性的浏览入口**，绝不能写成「你对应的倾向」——
// 那会凭空造出评分根本没算过的结论，并与页面自己的免责声明直接打架。
// 本文件的断言据此写：**只验入口存在且措辞中性，不验任何「个人对应」语义。**
//
// 全程真实 Input 事件，不用 element.click() 代替用户焦点。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { TOUCH_PROBE } from "./lib/touch-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
                       "Cache-Control": "no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-ddflow-"));
const port = 9381;
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
    await sleep(170);
  }
  tab(shift = false) { return this.key("Tab", "Tab", 9, shift ? 8 : 0); }
  // 真实鼠标点击：先验证目标点确实命中要点的元素，避免「点空了」被当成「页面没反应」
  async clickReal(sel) {
    const pt = await this.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null; el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(); const x=r.left+r.width/2, y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,ok:!!hit&&(hit===el||el.contains(hit)||hit.contains(el))};})()`);
    if (!pt) throw new Error("找不到元素 " + sel);
    if (!pt.ok) throw new Error("目标点没命中 " + sel + "（被遮挡或不可见）");
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    }
    await sleep(260);
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  const load = async () => { await cdp.send("Page.navigate", { url: `${BASE}/discover.html` }); await sleep(2200); };
  const measure = async (sel) => {
    await cdp.ev(TOUCH_PROBE);
    return cdp.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return {missing:true};
      el.scrollIntoView({block:'nearest'});
      return window.__target(el,44);})()`);
  };
  // 用真实键盘答完全部题目：Tab 到第一个选项，回车选中，直到出结果
  const answerAllByKeyboard = async () => {
    await cdp.clickReal("#landing .gold-btn");
    for (let i = 0; i < 20; i++) {
      const done = await cdp.ev(`!document.getElementById('result').classList.contains('hidden')`);
      if (done) return i;
      await cdp.ev(`document.querySelector('#opts .opt').focus()`);
      await cdp.key("Enter", "Enter", 13);
    }
    throw new Error("20 次之内没答完");
  };

  // ════ A 产品事实核对（这决定了入口该怎么写）════
  console.log("\n=== A 产品事实：测验到底算不算得出「对应倾向」 ===");
  await load();
  const facts = await cdp.ev(`(()=>({
    评分维度: Object.keys(AREAS),
    倾向原型: ARCH.map(a=>a.k),
    题目挂靠维度: [...new Set(QS.map(q=>q.a))],
    交集: Object.keys(AREAS).filter(k=>ARCH.some(a=>a.k===k))
  }))()`);
  console.log("  评分维度:", facts.评分维度.join("/"));
  console.log("  倾向原型:", facts.倾向原型.join("/"));
  ok("测验维度与倾向原型无交集（故不存在「对应倾向」）", facts.交集.length === 0,
     "交集: " + facts.交集.join(","));

  // ════ B 完整答题 → 结果 ════
  console.log("\n=== B 答题 → 结果（真实键盘）===");
  await load();
  const steps = await answerAllByKeyboard();
  const r1 = await cdp.ev(`(()=>({
    出结果: !document.getElementById('result').classList.contains('hidden'),
    结论: document.getElementById('rDecl').textContent,
    统计行数: document.getElementById('stats').children.length,
    建议: document.getElementById('adviceT').textContent,
    答案数: answers.length, 焦点: document.activeElement.id }))()`);
  ok("答完 " + steps + " 题后进入结果页", r1.出结果 === true);
  ok("结论文字已生成", r1.结论.length > 10, r1.结论.slice(0, 30));
  ok("五个维度统计都在", r1.统计行数 === 5, "实际 " + r1.统计行数 + " 行");
  ok("答案记录完整（10 题）", r1.答案数 === 10, "实际 " + r1.答案数);
  ok("结果页焦点交给结论标题", r1.焦点 === "rhead", "实际 " + r1.焦点);

  // ════ C 结果页 → 倾向说明的入口 ════
  console.log("\n=== C 结果页是否给得出进入倾向说明的入口 ===");
  const entry = await cdp.ev(`(()=>{const b=document.getElementById('toArchetypes');
    if(!b) return {有入口:false};
    const t=(b.textContent||'').trim();
    return {有入口:true, 文案:t,
      // 中性措辞检查：不得出现把结果说成个人倾向的字样
      措辞中性: !/你的倾向|你对应|你的事奉类型|匹配你|你属于/.test(t)};})()`);
  ok("结果页有进入倾向说明的入口", entry.有入口 === true, "当前结果页只有「重新探索」与「打开 App」");
  if (entry.有入口) {
    ok("入口措辞中性（不谎称是「你的」倾向）", entry.措辞中性 === true, "文案: " + entry.文案);
    const eb = await measure("#toArchetypes");
    ok("入口 ≥44x44 且无人压住", eb.ok === true, `${eb.w}x${eb.h} ${eb.why}`);
  }

  // ════ D 进详情 → 上一个/下一个 ════
  console.log("\n=== D 倾向说明页的上一个 / 下一个 ===");
  if (entry.有入口) { await cdp.clickReal("#toArchetypes"); }
  else { await cdp.ev(`openDetail('teacher')`); await sleep(400); }
  const inDetail = await cdp.ev(`!document.getElementById('detail').classList.contains('hidden')`);
  ok("已进入倾向说明页", inDetail === true);
  ok("详情页焦点交给标题", (await cdp.ev(`document.activeElement.id`)) === "dTitle",
     "实际 " + (await cdp.ev(`document.activeElement.id`)));

  const prevBox = await measure("#dPrev");
  const nextBox = await measure("#dNext");
  ok("「上一个」≥44x44 且无人压住", prevBox.ok === true, `${prevBox.w}x${prevBox.h} ${prevBox.why || "缺 #dPrev"}`);
  ok("「下一个」≥44x44 且无人压住", nextBox.ok === true, `${nextBox.w}x${nextBox.h} ${nextBox.why || "缺 #dNext"}`);

  const before = await cdp.ev(`currentDetail`);
  await cdp.ev(`document.getElementById('dNext') && document.getElementById('dNext').focus()`);
  await cdp.key("Enter", "Enter", 13);
  const afterNext = await cdp.ev(`currentDetail`);
  ok("键盘回车「下一个」真的换了原型", afterNext && afterNext !== before,
     `${before} → ${afterNext}`);
  await cdp.ev(`document.getElementById('dPrev') && document.getElementById('dPrev').focus()`);
  await cdp.key("Enter", "Enter", 13);
  ok("键盘回车「上一个」回到原来那个", (await cdp.ev(`currentDetail`)) === before,
     `期望回到 ${before}`);
  ok("换原型后焦点仍在详情内（没掉回 body）",
     (await cdp.ev(`document.activeElement !== document.body`)) === true);

  // ════ E 返回结果：结果与答案必须保持 ════
  console.log("\n=== E 从详情返回：结果与答案保持 ===");
  await cdp.clickReal("#detail .topbar .x");
  const r2 = await cdp.ev(`(()=>({
    回到结果页: !document.getElementById('result').classList.contains('hidden'),
    结论: document.getElementById('rDecl').textContent,
    统计行数: document.getElementById('stats').children.length,
    建议: document.getElementById('adviceT').textContent,
    答案数: answers.length, 焦点: document.activeElement.id }))()`);
  ok("返回到的是结果页而不是首屏", r2.回到结果页 === true);
  ok("结论文字与离开前逐字相同", r2.结论 === r1.结论);
  ok("统计行数不变", r2.统计行数 === r1.统计行数);
  ok("建议文字不变", r2.建议 === r1.建议);
  ok("答案数组未被清空", r2.答案数 === 10, "实际 " + r2.答案数);
  ok("返回后焦点交给结论标题", r2.焦点 === "rhead", "实际 " + r2.焦点);

  // ════ F 重测 ════
  console.log("\n=== F 结果页重新探索 ===");
  // 用 id 精确指向重测按钮：结果页现在有两个 .ghost-btn（浏览倾向说明 + 重新探索），
  // 按类名取会打到第一个，测的就不是重测了。
  await cdp.clickReal("#restartQuiz");
  const r3 = await cdp.ev(`(()=>({
    回到测验: !document.getElementById('quiz').classList.contains('hidden'),
    答案已清空: answers.length === 0,
    第几题: document.getElementById('qnow') ? document.getElementById('qnow').textContent : '' }))()`);
  ok("回到测验视图", r3.回到测验 === true);
  ok("答案已清空（不串上一轮）", r3.答案已清空 === true);
  const steps2 = await (async () => {
    for (let i = 0; i < 20; i++) {
      if (await cdp.ev(`!document.getElementById('result').classList.contains('hidden')`)) return i;
      await cdp.ev(`document.querySelector('#opts .opt').focus()`);
      await cdp.key("Enter", "Enter", 13);
    }
    return -1;
  })();
  ok("第二轮能再次答到结果页", steps2 === 10, "实际 " + steps2 + " 题");

  // ════ G 负向控制 ════
  console.log("\n=== G 负向控制：绿必须能转红 ===");
  await load();
  await cdp.ev(`openDetail('teacher')`); await sleep(400);
  await cdp.ev(`(()=>{const b=document.getElementById('dNext'); if(b){b.style.minHeight='26px';b.style.height='26px';b.style.padding='0 6px';}})()`);
  const g1 = await measure("#dNext");
  ok("G1 「下一个」压到 26px 时量具判红", g1.ok === false, `压小后仍判 ok：${g1.w}x${g1.h}`);

  await load();
  const g2 = await cdp.ev(`(()=>{const b=document.getElementById('toArchetypes');
    if(!b) return null; b.textContent='查看你对应的倾向';
    return !/你的倾向|你对应|你的事奉类型|匹配你|你属于/.test(b.textContent.trim());})()`);
  ok("G2 入口改成「你对应的倾向」时中性判据判红", g2 === false,
     g2 === null ? "入口不存在，此控制跳过" : "判据没抓住");

  await load();
  await answerAllByKeyboard();
  const keep = await cdp.ev(`document.getElementById('rDecl').textContent`);
  await cdp.ev(`document.getElementById('rDecl').textContent = '被改掉的结论'`);
  ok("G3 结论被篡改时保持性断言判红",
     (await cdp.ev(`document.getElementById('rDecl').textContent`)) !== keep);

  const g4 = await measure("#这个不存在");
  ok("G4 选择器打空时量具报 missing 而非假绿", g4.missing === true, JSON.stringify(g4));

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally { chrome.kill(); server.close(); }

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
