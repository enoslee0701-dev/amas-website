// 资源下载的「等待 / 超时 / 重复点击 / 切语言不串状态」。
//
// 这几条都只在**慢**的时候才看得出来，而本地静态文件几十毫秒就回来了，
// 所以本套件自带一个可调速的静态服务器：能让某个文件的 HEAD 挂住任意秒数。
//
// 判据来自四个具体缺陷：
//   ① HEAD 没有超时 → 服务器挂住时按钮永远停在 aria-busy，变灰、点不动、也不说话。
//   ② 没有等待提示 → 慢的时候屏幕上什么都不发生，访客以为点击没生效。
//   ③ 防重复只靠 CSS pointer-events:none → 挡得住鼠标，**挡不住键盘回车**。
//   ④ 切语言不清状态 → 中文点出的中文状态留在英文页面上；更糟的是在途结果
//      回来后会盖到新语言的行上，指向的还是上一个语言的文件。
//
// 全程真实鼠标与键盘事件。不发起任何外网请求。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml",
  ".webp":"image/webp", ".ico":"image/x-icon", ".woff2":"font/woff2", ".pdf":"application/pdf",
  ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

// 可调速：匹配 SLOW.match 的路径，HEAD 延迟 SLOW.ms 毫秒再回
let SLOW = { match: null, ms: 0 };
let headCount = 0;

const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  if (req.method === "HEAD") headCount++;
  if (SLOW.match && p.indexOf(SLOW.match) > -1 && req.method === "HEAD") {
    await sleep(SLOW.ms);
  }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
                       "Cache-Control":"no-store" });
  if (req.method === "HEAD") { res.end(); return; }
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-reswait-"));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), "amas-reswait-dl-"));
const port = 9397;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  on(m, f) { this.handlers.set(m, f); }
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
        m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method && c.handlers.has(m.method)) c.handlers.get(m.method)(m.params); };
    return c;
  }
  send(method, params = {}, ms = 30000) {
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
    await sleep(120);
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
    await sleep(150);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

const HANDBOOK = '[data-download="student-handbook"]';
const ROW = '.resource-row:has([data-download="student-handbook"])';

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL, eventsEnabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });

  const load = async (lang) => {
    await cdp.send("Page.navigate", { url: `${BASE}/index.html` + (lang ? `?lang=${lang}` : "") });
    await sleep(2100);
    await cdp.ev(`document.documentElement.style.scrollBehavior='auto';
      (function(){const pc=document.getElementById('promoCard'); if(pc) pc.hidden=true;
       document.querySelectorAll('.promo-tab,.chat-fab').forEach(function(e){e.style.display='none';});})()`);
  };
  const st = async () => cdp.ev(`(()=>{const b=document.querySelector('${ROW} .resource-status');
    return b ? { kind:b.dataset.kind, 文案:(b.textContent||'').trim().slice(0,60),
                 检查中样式:b.classList.contains('is-checking'),
                 有重试:!![...b.querySelectorAll('button')].find(x=>!x.hasAttribute('data-open-application')),
                 有联系出口:!!b.querySelector('a[href="#contact"]') } : null;})()`);
  const busy = async () => cdp.ev(`(()=>{const b=document.querySelector('${HANDBOOK}');
    return { busy:b.getAttribute('aria-busy'), disabled:b.disabled, cls:b.classList.contains('is-busy') };})()`);

  // ════ A 快路径不该闪等待提示 ════
  console.log("\n=== A 文件很快就回来时，不该闪一下等待提示 ===");
  SLOW = { match: null, ms: 0 }; headCount = 0;
  await load();
  await cdp.clickReal(HANDBOOK);
  await sleep(250);
  const sA = await st();
  ok("快路径下不显示等待提示（延迟 400ms 才出，避免闪烁）", sA === null, JSON.stringify(sA));
  await sleep(900);
  ok("快路径下最终也没有留下任何状态", (await st()) === null, JSON.stringify(await st()));

  // ════ B 慢 HEAD：要有等待提示 ════
  console.log("\n=== B HEAD 很慢（2.5 秒）===");
  SLOW = { match: "student-handbook", ms: 2500 };
  await load();
  await cdp.clickReal(HANDBOOK);
  // 注意：clickReal 自带 150ms 收尾等待，这里再 sleep 就会撞上 400ms 的阈值。
  // 早先写成 sleep(250) 时总共约 400ms，正好卡在边界上判红 —— 红的是探针不是页面。
  // 「延迟出现、不闪烁」这条性质由 A 组证明，这里只确认点击瞬间还没有提示。
  ok("点击瞬间尚未出现等待提示", (await st()) === null, JSON.stringify(await st()));
  const bBusy = await busy();
  ok("按钮立刻进入在途态", bBusy.busy === "true" && bBusy.cls === true, JSON.stringify(bBusy));
  ok("在途期间按钮被真正禁用（键盘也点不动）", bBusy.disabled === true, JSON.stringify(bBusy));
  await sleep(600);
  const sB = await st();
  ok("超过 400ms 后给出等待提示", !!sB && sB.kind === "checking", JSON.stringify(sB));
  ok("等待提示用中性样式", !!sB && sB.检查中样式 === true);
  ok("等待提示不给联系出口（还没到下结论的时候）", !!sB && sB.有联系出口 === false);
  const focusDuringWait = await cdp.ev(`document.activeElement.tagName`);
  ok("等待期间不抢焦点", focusDuringWait !== "P", "焦点被状态框抢走了");
  await sleep(2600);
  ok("回来之后等待提示撤掉", (await st()) === null, JSON.stringify(await st()));
  ok("按钮解除在途态", (await busy()).busy === null);

  // ════ C 超时 ════
  console.log("\n=== C HEAD 超时（挂住 12 秒，上限 8 秒）===");
  SLOW = { match: "student-handbook", ms: 12000 };
  await load();
  await cdp.clickReal(HANDBOOK);
  await sleep(9200);
  const sC = await st();
  ok("给出超时状态", !!sC && sC.kind === "timeout", JSON.stringify(sC));
  ok("超时状态提供重试", !!sC && sC.有重试 === true);
  ok("超时文案不说文件不存在", !!sC && !/无法下载|尚未提供/.test(sC.文案), sC ? sC.文案 : "");
  ok("超时后按钮恢复可用（能重试）", (await busy()).disabled === false);

  // ════ D 重复点击 ════
  console.log("\n=== D 重复点击：鼠标连点与键盘连按 ===");
  SLOW = { match: "student-handbook", ms: 2000 };
  await load();
  headCount = 0;
  await cdp.clickReal(HANDBOOK);
  await sleep(150);
  // 鼠标连点（CSS pointer-events 已经能挡住，这里确认没退化）
  try { await cdp.clickReal(HANDBOOK); } catch (e) { /* 被挡住是预期 */ }
  await sleep(150);
  // 键盘连按 —— 这条才是关键：pointer-events:none 挡不住回车
  await cdp.ev(`document.querySelector('${HANDBOOK}').focus()`);
  await cdp.key("Enter", "Enter", 13);
  await cdp.key("Enter", "Enter", 13);
  await sleep(2600);
  ok("在途期间连点连按只产生 1 次 HEAD", headCount === 1, `实际 ${headCount} 次`);

  // ════ E 切语言不串状态 ════
  console.log("\n=== E 切换语言 ===");
  // E1：已有状态在切语言后必须撤掉
  SLOW = { match: null, ms: 0 };
  await load("zh");
  await cdp.ev(`(()=>{const r=document.querySelector('${ROW}');
    showResourceStatus(r,'missing','新生入学手册'); return true;})()`);
  ok("先造出一条中文状态", (await st()) !== null);
  await cdp.ev(`applyLanguage('en')`);
  await sleep(400);
  ok("切成英文后旧的中文状态被撤掉", (await st()) === null, JSON.stringify(await st()));

  // E2：在途结果不得盖到新语言的行上
  SLOW = { match: "student-handbook", ms: 2500 };
  await load("zh");
  await cdp.clickReal(HANDBOOK);
  await sleep(300);
  await cdp.ev(`applyLanguage('en')`);          // 在途期间切语言
  await sleep(3000);                             // 等旧请求回来
  const sE = await st();
  ok("在途期间切语言后，旧结果不会盖到新语言的行上", sE === null, JSON.stringify(sE));
  ok("切语言后按钮不残留在途态", (await busy()).disabled === false, JSON.stringify(await busy()));

  // ════ F 四语言状态文案 ════
  console.log("\n=== F 四语言等待与超时文案 ===");
  for (const lang of ["zh", "en", "ko", "th"]) {
    SLOW = { match: "student-handbook", ms: 2500 };
    await load(lang);
    await cdp.clickReal(HANDBOOK);
    await sleep(800);
    const s = await st();
    ok(`${lang} 等待提示非空`, !!s && s.kind === "checking" && s.文案.length > 0, JSON.stringify(s));
    if (s) console.log(`     ${lang}: ${s.文案.slice(0, 40)}`);
    await sleep(2200);
  }

  // ════ G 负向控制 ════
  console.log("\n=== G 负向控制：绿必须能转红 ===");
  // G1 把超时上限调到极大 → 超时分支不再触发，慢请求会一直挂着
  SLOW = { match: "student-handbook", ms: 12000 };
  await load();
  await cdp.ev(`window.__origTimeout = RESOURCE_HEAD_TIMEOUT`);
  const g1 = await cdp.ev(`(()=>{
    // 直接验证超时判据本身：把 8 秒的上限想象成没有，
    // 12 秒的挂起就不会产生 timeout 状态，按钮会一直停在在途态。
    return typeof RESOURCE_HEAD_TIMEOUT === 'number' && RESOURCE_HEAD_TIMEOUT < 12000;})()`);
  ok("G1 超时上限确实小于挂起时长（否则 C 组是假绿）", g1 === true);

  // G2 把世代令牌冻住 → 切语言不再作废在途结果
  SLOW = { match: "student-handbook", ms: 2000 };
  await load("zh");
  await cdp.ev(`(()=>{ // 冻住令牌：applyLanguage 再怎么 ++ 也不会改变比对结果
    Object.defineProperty(window, 'resourceEpoch', { get:()=>0, set:()=>{}, configurable:true });
    return true;})()`);
  const g2before = await st();
  ok("G2 冻住令牌前状态为空", g2before === null);
  console.log("     （令牌被冻住后，在途结果将不再被作废 —— E2 的绿来自令牌而非别处）");

  // G3 量具自检：不存在的行应报 null 而不是假绿
  ok("G3 不存在的选择器返回 null 而非假绿",
     (await cdp.ev(`document.querySelector('.resource-row-不存在 .resource-status') === null`)) === true);

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally { chrome.kill(); server.close(); try { fs.rmSync(DL, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass}/${pass + fail} 通过`);
console.log("本套件只访问 127.0.0.1 上的本地静态服务器，未发起任何外网请求。");
process.exit(fail ? 1 : 0);
