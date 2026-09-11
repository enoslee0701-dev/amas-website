#!/usr/bin/env node
// discover.html 测验流程回归：开始 → 答题 → 上一题 → 结果 → 返航。
//
// ── 这份脚本全程用真实输入事件 ──────────────────────────────────────
// 所有点击都是 Input.dispatchMouseEvent（先把元素滚进视口，再在中心按下松开），
// 所有按键都是 Input.dispatchKeyEvent。**不用 element.click()**。
// 理由上一轮吃过亏：程序化 click 不会让按钮获得焦点，于是「焦点归还」那类断言
// 量到的是探针自己造出来的状态，不是真人会遇到的。焦点行为只能用真实输入去验。
//
// ── 这轮要盯的缺陷 ──────────────────────────────────────────────────
// D1 每次换视图/换题，焦点都掉回 body。实测四处全中：
//      回车「开始快速探索」→ (body)      答一题 → (body)
//      点「上一题」→ (body)              答完出结果 → (body)
//    选项按钮在 render() 里被整批重建，按回车答题的那一刻承载焦点的按钮当场被销毁。
//    十道题就是十次焦点丢失；读屏访客则完全收不到「换题了」的信号 ——
//    题干只是文本被替换，页面上没有任何活动区。
// D2 进度只有视觉宽度。读屏访客既看不到宽度，页面上也没有「第几题」的文字，
//    拿不到任何进度信息。
//
// 用法: node scripts/test-discover-flow.mjs
// Chrome 路径可用环境变量 CHROME 覆盖；找不到时以非零退出，不静默跳过。

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (cond, name, detail) => results.push([!!cond, name, detail]);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  return [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => fs.existsSync(p)) || null;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json",
};
function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const abs = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try {
        const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      if (!url) await sleep(250);
    }
    if (!url) throw new Error("could not attach to Chrome");
    const sock = await new Promise((res, rej) => {
      const s = new WebSocket(url); s.onopen = () => res(s); s.onerror = rej;
    });
    const c = new Cdp(sock);
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}, ms = 30000) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.delete(i)) rej(new Error(`CDP timeout after ${ms}ms: ${method}`));
      }, ms);
      this.pending.set(i, { res: (v) => { clearTimeout(timer); res(v); },
                            rej: (e) => { clearTimeout(timer); rej(e); } });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval threw: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  }
  async key(key, code, vk, mods = 0) {
    const b = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...b });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...b });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...b });
    await sleep(150);
  }
  tab(shift = false) { return this.key("Tab", "Tab", 9, shift ? 8 : 0); }
  // 真实鼠标点击：先滚进视口（真人也要滚），再在元素中心按下并松开
  async clickReal(sel) {
    const pt = await this.ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      document.documentElement.style.scrollBehavior = 'auto';
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      const x = Math.round(Math.min(vw - 2, Math.max(1, r.left + r.width / 2)));
      const y = Math.round(Math.min(vh - 2, Math.max(1, r.top + r.height / 2)));
      return { x, y };
    })()`);
    if (!pt) return false;
    await sleep(220);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await sleep(330);
    return true;
  }
}

const WHO = `(() => { const el = document.activeElement;
  if (!el || el === document.body) return '(body)';
  const sec = el.closest('#landing,#quiz,#result,#detail');
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '') +
    (sec ? ' @' + sec.id : ' @页面外'); })()`;
const VIEW = `(() => ['landing','quiz','result','detail']
  .filter(id => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); })
  .join(',') || '(无)')()`;
// 焦点是否落在「刚刚换上来的那块内容」里 —— 不钉死到某个具体元素，
// 将来调整结构只要焦点仍进了新视图，断言就该绿。
const FOCUS_IN = (sel) => `(() => { const el = document.activeElement;
  const host = document.querySelector(${JSON.stringify(sel)});
  return !!host && !!el && (el === host || host.contains(el)); })()`;

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== DISCOVER FLOW: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9460 + (process.pid % 30);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-discflow-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

// 真实键盘：从文档开头连续 Tab，直到焦点落在匹配的控件上
async function tabTo(cdp, testExpr, max = 30) {
  await cdp.ev(`document.body.focus()`);
  for (let i = 0; i < max; i++) {
    await cdp.tab();
    if (await cdp.ev(testExpr)) return i + 1;
  }
  return -1;
}

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.navigate", { url: `${BASE}/discover.html` });
  await sleep(2400);

  // D1 键盘开始：Tab 到「开始快速探索」，回车
  const hops = await tabTo(cdp, `/开始|探索/.test(document.activeElement.textContent || '')`);
  await cdp.key("Enter", "Enter", 13);
  await sleep(500);
  const started = await cdp.ev(`({ view: ${VIEW}, inQuiz: ${FOCUS_IN("#quiz")}, who: ${WHO} })`);
  check(hops > 0 && started.view === "quiz" && started.inQuiz,
    "D1 键盘进入测验：Tab 到「开始快速探索」回车，焦点随之进入题卡",
    `Tab ${hops} 次命中入口；视图=${started.view} 焦点在测验内=${started.inQuiz} 焦点=${started.who}`);

  // D2 键盘答题：Tab 到选项回车，题目要换，焦点要留在测验里
  const toOpt = await tabTo(cdp, `document.activeElement.classList.contains('opt')`);
  const before = await cdp.ev(`document.getElementById('qtext').textContent`);
  await cdp.key("Enter", "Enter", 13);
  await sleep(450);
  const answered = await cdp.ev(`({ text: document.getElementById('qtext').textContent,
    inQuiz: ${FOCUS_IN("#quiz")}, who: ${WHO} })`);
  check(toOpt > 0 && answered.text !== before && answered.inQuiz,
    "D2 键盘答题：回车作答后题目更新，焦点没有掉回 body（选项按钮是被整批重建的）",
    `Tab ${toOpt} 次到选项；题目已变=${answered.text !== before} 焦点在测验内=${answered.inQuiz} 焦点=${answered.who}`);

  // D3 进度语义：读屏访客拿得到「第几题 / 共几题」
  const prog = await cdp.ev(`(() => { const b = document.querySelector('#quiz .bar');
    return b ? { role: b.getAttribute('role') || '', now: b.getAttribute('aria-valuenow') || '',
                 max: b.getAttribute('aria-valuemax') || '', text: b.getAttribute('aria-valuetext') || '' }
             : { role: '(无元素)' }; })()`);
  check(prog.role === "progressbar" && prog.max !== "" && prog.now !== "" && /第 \d+ 题/.test(prog.text),
    "D3 进度条有真实语义：role=progressbar 且带当前题号与总题数",
    `role=${prog.role} now=${prog.now}/${prog.max} valuetext="${prog.text}"`);

  // D4 「上一题」：真实鼠标点击，题目要退回，焦点要跟着回题卡
  const qBeforeUndo = await cdp.ev(`document.getElementById('qtext').textContent`);
  const undoClicked = await cdp.clickReal("#undoBtn");
  const undone = await cdp.ev(`({ text: document.getElementById('qtext').textContent,
    inQuiz: ${FOCUS_IN("#quiz")}, who: ${WHO} })`);
  check(undoClicked && undone.text !== qBeforeUndo && undone.inQuiz,
    "D4 鼠标点「上一题」：退回上一题，焦点跟着回到题卡",
    `题目已回退=${undone.text !== qBeforeUndo} 焦点在测验内=${undone.inQuiz} 焦点=${undone.who}`);

  // D5 一路答到结果页：焦点落在结果内容上，指标齐全
  let guard = 0;
  while (guard++ < 14) {
    const inQuiz = await cdp.ev(`!document.getElementById('quiz').classList.contains('hidden')`);
    if (!inQuiz) break;
    if (!await cdp.clickReal("#opts .opt")) break;
  }
  const done = await cdp.ev(`({ view: ${VIEW}, inResult: ${FOCUS_IN("#result")}, who: ${WHO},
    rows: document.querySelectorAll('#stats .statrow').length,
    decl: (document.getElementById('rDecl').textContent || '').trim().length,
    advice: (document.getElementById('advice').textContent || '').trim().length })`);
  check(done.view === "result" && done.inResult && done.rows === 5 &&
        done.decl > 0 && done.advice > 0,
    "D5 答完出结果：焦点落在结果内容上，五项指标与建议都在",
    `视图=${done.view} 焦点在结果内=${done.inResult} 指标行=${done.rows} 结论${done.decl}字 建议${done.advice}字 焦点=${done.who}`);

  // D6 返航：结果页上「返回官网」键盘可达、可见、且指向首页
  const backHops = await tabTo(cdp, `(document.activeElement.className || '').includes('back-link')`, 40);
  const back = await cdp.ev(`(() => { const a = document.querySelector('.back-link');
    const r = a.getBoundingClientRect();
    const vh = document.documentElement.clientHeight, vw = document.documentElement.clientWidth;
    const cta = document.querySelector('.sticky-cta');
    const cr = cta && !cta.classList.contains('hidden') ? cta.getBoundingClientRect() : null;
    return { href: a.getAttribute('href') || '', focused: document.activeElement === a,
             inView: r.top >= -0.5 && r.bottom <= vh + 0.5 && r.left >= -0.5 && r.right <= vw + 0.5,
             coveredByCta: !!cr && !(r.bottom <= cr.top || r.top >= cr.bottom) }; })()`);
  check(backHops > 0 && back.focused && back.href === "index.html" && back.inView && !back.coveredByCta,
    "D6 返航出口：键盘可达、完整在视口内、不被固定底栏遮住，指向官网首页",
    `Tab ${backHops} 次到达；href=${back.href} 完整可见=${back.inView} 被底栏遮挡=${back.coveredByCta}`);

  // D7 重新探索：回到第 1 题，焦点回测验，答案清空
  const restartClicked = await cdp.clickReal("#result button[onclick='restart()']");
  const restarted = await cdp.ev(`({ view: ${VIEW}, inQuiz: ${FOCUS_IN("#quiz")},
    now: (document.querySelector('#quiz .bar') || {}).getAttribute
         ? document.querySelector('#quiz .bar').getAttribute('aria-valuenow') : '' })`);
  check(restartClicked && restarted.view === "quiz" && restarted.inQuiz && restarted.now === "0",
    "D7 「重新探索一次」：回到第 1 题，焦点进入题卡，进度归零",
    `视图=${restarted.view} 焦点在测验内=${restarted.inQuiz} aria-valuenow=${restarted.now}`);

  // D8 退出测验：✕ 回首屏，焦点交回进来的那个入口
  const exitClicked = await cdp.clickReal("#quiz .topbar .x");
  const exited = await cdp.ev(`({ view: ${VIEW}, onStart:
    document.activeElement === document.querySelector('#landing .gold-btn'), who: ${WHO} })`);
  check(exitClicked && exited.view === "landing" && exited.onStart,
    "D8 ✕ 退出测验：回到首屏，焦点交回「开始快速探索」",
    `视图=${exited.view} 焦点在开始按钮上=${exited.onStart} 焦点=${exited.who}`);

  // D0 负向控制：把本轮的焦点接管换成空操作，四处焦点必须重新掉回 body。
  // 直接改站点自己的函数，而不是换一套宽松断言 —— 不会变红的负向控制等于没有控制。
  await cdp.send("Page.navigate", { url: `${BASE}/discover.html` });
  await sleep(2400);
  await cdp.ev(`window.focusQuietly = function(){};`);
  const h2 = await tabTo(cdp, `/开始|探索/.test(document.activeElement.textContent || '')`);
  await cdp.key("Enter", "Enter", 13);
  await sleep(500);
  const revStart = await cdp.ev(`({ inQuiz: ${FOCUS_IN("#quiz")}, who: ${WHO} })`);
  const toOpt2 = await tabTo(cdp, `document.activeElement.classList.contains('opt')`);
  await cdp.key("Enter", "Enter", 13);
  await sleep(450);
  const revAnswer = await cdp.ev(`({ inQuiz: ${FOCUS_IN("#quiz")}, who: ${WHO} })`);
  check(h2 > 0 && toOpt2 > 0 && !revStart.inQuiz && !revAnswer.inQuiz,
    "D0 负向控制：把焦点接管换成空操作后，开始与答题两处焦点重新掉回 body",
    `开始后焦点=${revStart.who}；答一题后焦点=${revAnswer.who}`);

  cdp.ws.close();
} finally {
  chrome.kill();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}

let passed = 0;
for (const [good, name, detail] of results) {
  console.log(`${good ? "PASS" : "FAIL"} ${name} | ${detail}`);
  if (good) passed++;
}
console.log("");
console.log(`=== DISCOVER FLOW: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
