#!/usr/bin/env node
// discover.html「返回官网」出口的浏览器回归测试。
//
// 为什么是 Node 而不是 Python：本仓其它测试（test-cache-bust-contract.py /
// test-hook-gate.py）是纯文件层断言，Python 够用；这一条必须真的渲染、真的按 Tab、
// 真的点击，需要 WebSocket 客户端。Node 22 内置 WebSocket + fetch，零 npm 依赖。
//
// 覆盖：
//   T0  反空过控制：同一套断言在「删掉链接」的页面上必须失败
//   T1  链接存在、可见、文案正确
//   T2  子路径部署下 href 解析正确（内置服务器把站点挂在 /amas-website/ 前缀下）
//   T3  键盘可达：Tab 能聚焦，且 :focus-visible 有可见轮廓
//   T4  移动端 375px：触控目标 >= 44px，不溢出视口
//   T5  四个屏幕（landing / quiz / result / detail）都可见
//   T6  结果页固定底栏不遮挡链接
//   T7  答题进度不受影响：作答 3 题后进度仍是 3，链接可见
//   T8  真实点击能导航到官网首页
//   T9  答题全流程回归：10 题跑完出结果页，零异常零 console 错误
//
// 用法: node scripts/test-discover-back-link.mjs
// Chrome 路径可用环境变量 CHROME 覆盖。找不到 Chrome 时以非零退出（不静默跳过，
// 静默跳过等于空过）。
//
// 全部运行时输出为 ASCII —— 上游 harness 用 GBK 解码会被中文 stderr 打断。

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "/amas-website";           // 模拟 GitHub Pages 项目页的子路径
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n, d) => results.push([true, n, d]);
const bad = (n, d) => results.push([false, n, d]);
const check = (cond, n, d) => (cond ? ok(n, d) : bad(n, d));

// ---------- Chrome ----------
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cands = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return cands.find((p) => fs.existsSync(p)) || null;
}

// ---------- 静态服务器（同时服务 / 与 /amas-website/） ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
};
function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.startsWith(PREFIX + "/")) p = p.slice(PREFIX.length);
    else if (p === PREFIX) p = "/";
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

// ---------- CDP ----------
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try {
        const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl;
      } catch { /* chrome not up yet */ }
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
      } else if (m.method) c.events.push(m);
    };
    return c;
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const i = ++this.id; this.pending.set(i, { res, rej });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async evaluate(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
  async goto(url, wait = 1500) { await this.send("Page.navigate", { url }); await sleep(wait); }
  errors() {
    return this.events.filter((x) =>
      x.method === "Runtime.exceptionThrown" ||
      (x.method === "Runtime.consoleAPICalled" && x.params.type === "error") ||
      (x.method === "Log.entryAdded" && x.params.entry.level === "error"));
  }
}

// ---------- 页面内探针 ----------
// 返回链接的全部可观测状态。删掉链接时返回 {present:false}，T0 靠这个证明断言会失败。
const PROBE = `(() => {
  const a = document.querySelector('.back-link');
  if (!a) return { present: false };
  const r = a.getBoundingClientRect();
  const cs = getComputedStyle(a);
  const sticky = document.getElementById('stickyCta');
  const sr = (sticky && !sticky.classList.contains('hidden')) ? sticky.getBoundingClientRect() : null;
  return {
    present: true,
    text: (a.textContent || '').replace(/\\s+/g, ''),
    href: a.href,
    tag: a.tagName,
    visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
    rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height },
    stickyTop: sr ? sr.top : null,
    focused: document.activeElement === a,
    outline: cs.outlineStyle + ' ' + cs.outlineWidth,
    innerW: window.innerWidth,
    screen: ['landing','quiz','result','detail'].find(id => !document.getElementById(id).classList.contains('hidden')) || 'none',
    answers: (typeof answers !== 'undefined' && answers) ? answers.length : -1
  };
})()`;

// 按 Tab 直到聚焦到 .back-link（或放弃）。返回按了几次。
async function tabTo(cdp, max = 60) {
  for (let i = 1; i <= max; i++) {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(35);
    if (await cdp.evaluate(`document.activeElement && document.activeElement.classList.contains('back-link')`)) return i;
  }
  return -1;
}

// 逐题点选，直到答题屏不再显示为止。
// 必须过滤 offsetParent —— 答完最后一题后 #quiz 被隐藏，但 #opts 里上一题的按钮仍在
// DOM 中，程序化 click 对隐藏元素照样生效，会把 answers 推过 QS 长度，制造出真人
// 触发不了的 TypeError。这里只点真正可见的选项。
async function answerN(cdp, n) {
  for (let i = 0; i < n; i++) {
    const clicked = await cdp.evaluate(`(() => {
      if (document.getElementById('quiz').classList.contains('hidden')) return false;
      const b = [...document.querySelectorAll('#opts .opt')].filter(e => e.offsetParent !== null);
      if (!b.length) return false;
      b[0].click(); return true;
    })()`);
    if (!clicked) return i;
    await sleep(180);
  }
  return n;
}

// ---------- 主流程 ----------
const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== DISCOVER BACK-LINK: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}${PREFIX}`;
const port = 9700 + (process.pid % 200);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-backlink-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "about:blank"], { stdio: "ignore" });

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.enable");
  // 移动端优先：375x720 是最窄的常见机型宽度
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 720, deviceScaleFactor: 1, mobile: true });

  await cdp.goto(`${BASE}/discover.html`, 1800);
  cdp.events = [];

  // --- T0 反空过控制：先证明这套断言在没有链接时会失败 ---
  await cdp.evaluate(`(() => { const a = document.querySelector('.back-link'); if (a) a.remove(); })()`);
  const gone = await cdp.evaluate(PROBE);
  check(gone.present === false, "T0 assertions are not vacuous (control page without the link fails T1)",
    `probe.present=${gone.present}`);
  await cdp.goto(`${BASE}/discover.html`, 1600);   // 复原
  cdp.events = [];

  // --- T1 存在 / 可见 / 文案 ---
  const p1 = await cdp.evaluate(PROBE);
  check(p1.present && p1.visible && p1.tag === "A", "T1 back link exists, is a real anchor and is visible",
    `tag=${p1.tag} visible=${p1.visible} h=${Math.round(p1.rect.h)}`);
  check(/\u8fd4\u56de\u5b98\u7f51/.test(p1.text), "T1b label reads as a return-to-website link",
    `text.len=${p1.text.length}`);

  // --- T2 子路径解析 ---
  const want = `${BASE}/index.html`;
  check(p1.href === want, "T2 href resolves correctly under a deployed subpath",
    `href=${p1.href.replace(BASE, "<base>")} want=<base>/index.html`);

  // --- T3 键盘可达 + 焦点可见 ---
  const tabs = await tabTo(cdp);
  const p3 = await cdp.evaluate(PROBE);
  check(tabs > 0 && p3.focused, "T3 link is reachable by keyboard (Tab)", `tab presses=${tabs}`);
  check(p3.outline !== "none 0px", "T3b focused link shows a visible focus outline", `outline=${p3.outline}`);

  // --- T4 移动端触控目标 + 不溢出 ---
  check(p1.rect.h >= 44, "T4 touch target is at least 44px tall", `h=${Math.round(p1.rect.h)}px`);
  check(p1.rect.left >= 0 && p1.rect.right <= p1.innerW + 0.5,
    "T4b link stays inside the 375px viewport", `left=${Math.round(p1.rect.left)} right=${Math.round(p1.rect.right)} vw=${p1.innerW}`);

  // --- T4c 桌面断点（>=768px）不塌 ---
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const pDesk = await cdp.evaluate(PROBE);
  check(pDesk.visible && pDesk.rect.h >= 44 && pDesk.rect.left >= 0 && pDesk.rect.right <= pDesk.innerW + 0.5,
    "T4c link also holds up at the 1280px desktop breakpoint",
    `h=${Math.round(pDesk.rect.h)} left=${Math.round(pDesk.rect.left)} right=${Math.round(pDesk.rect.right)} vw=${pDesk.innerW}`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 720, deviceScaleFactor: 1, mobile: true });
  await sleep(300);

  // --- T5/T7 四屏可见 + 答题进度 ---
  const seen = {};
  seen.landing = (await cdp.evaluate(PROBE)).visible;

  await cdp.evaluate(`startQuiz()`); await sleep(300);
  const p5q = await cdp.evaluate(PROBE);
  seen.quiz = p5q.visible;

  const n = await answerN(cdp, 3);
  const p7 = await cdp.evaluate(PROBE);
  check(n === 3 && p7.answers === 3, "T7 quiz progress is intact after 3 answers", `answered=${n} answers.length=${p7.answers}`);
  check(p7.visible && p7.screen === "quiz", "T7b link stays visible mid-quiz without disturbing it", `screen=${p7.screen}`);

  // 聚焦链接（不点击）后进度仍在 —— 证明链接不碰任何答题状态
  await cdp.evaluate(`document.querySelector('.back-link').focus()`); await sleep(150);
  const p7b = await cdp.evaluate(PROBE);
  check(p7b.answers === 3, "T7c focusing the link does not reset quiz progress", `answers.length=${p7b.answers}`);

  // --- T9 走完全程 ---
  await answerN(cdp, 12);
  const p9 = await cdp.evaluate(PROBE);
  seen.result = p9.visible;
  const resultText = await cdp.evaluate(`(document.getElementById('rDecl').textContent||'').length`);
  check(p9.screen === "result" && resultText > 20, "T9 full 10-question run still reaches the result screen",
    `screen=${p9.screen} rDecl.len=${resultText}`);

  // --- T6 固定底栏不遮挡 ---
  // rect 是视口坐标，固定底栏永远贴在视口底部；只有把链接滚进视口才谈得上遮挡。
  check(p9.stickyTop !== null, "T6 sticky bar is actually shown on the result screen (precondition)",
    `stickyTop=${p9.stickyTop === null ? "hidden" : Math.round(p9.stickyTop)}`);
  // 用户能到达的最低位置就是文档底部；不要用 scrollIntoView(block:'end')，那会把链接
  // 自身底边贴到视口底边，绕过 .site-exit 为固定底栏预留的内边距，测出一个真人遇不到的重叠。
  await cdp.evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
  await sleep(450);
  const p6 = await cdp.evaluate(PROBE);
  const padBottom = await cdp.evaluate(`parseFloat(getComputedStyle(document.querySelector('.site-exit')).paddingBottom)`);
  check(padBottom >= 60, "T6b sticky-aware bottom padding is actually applied on the result screen",
    `padding-bottom=${Math.round(padBottom)}px`);
  check(p6.rect.top >= 0 && p6.rect.bottom <= 720 + 0.5,
    "T6c link is within the viewport at full scroll (precondition for the overlap check)",
    `top=${Math.round(p6.rect.top)} bottom=${Math.round(p6.rect.bottom)} vh=720`);
  check(p6.stickyTop === null || p6.rect.bottom <= p6.stickyTop + 0.5,
    "T6d link is not covered by the result-screen sticky bar",
    `link.bottom=${Math.round(p6.rect.bottom)} sticky.top=${Math.round(p6.stickyTop)}`);

  await cdp.evaluate(`openDetail('teacher')`); await sleep(350);
  const p5d = await cdp.evaluate(PROBE);
  seen.detail = p5d.visible;
  check(seen.landing && seen.quiz && seen.result && seen.detail,
    "T5 link is visible on all four screens",
    `landing=${seen.landing} quiz=${seen.quiz} result=${seen.result} detail=${seen.detail}`);

  const errs = cdp.errors();
  const errText = errs.map((e) => {
    if (e.method === "Runtime.exceptionThrown") return "EXC " + String(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text).split("\n")[0];
    if (e.method === "Log.entryAdded") return "LOG " + e.params.entry.text;
    return "CON " + (e.params.args || []).map((a) => a.value ?? a.description).join(" ");
  }).map((s) => s.slice(0, 120));
  check(errs.length === 0, "T9b quiz run produced no exceptions or console errors",
    errs.length ? `errors=${errs.length}: ` + errText.join(" ;; ") : "errors=0");

  // --- T8 真实点击导航 ---
  await cdp.goto(`${BASE}/discover.html`, 1500);
  await cdp.evaluate(`document.querySelector('.back-link').click()`);
  await sleep(1800);
  const landed = await cdp.evaluate(`({ url: location.href, title: document.title })`);
  check(landed.url === want, "T8 clicking the link actually navigates to the website home",
    `landed=${landed.url.replace(BASE, "<base>")}`);
  check((landed.title || "").length > 0 && landed.url !== `${BASE}/discover.html`,
    "T8b landing page rendered (non-empty title, left discover)", `title.len=${(landed.title || "").length}`);

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
console.log(`=== DISCOVER BACK-LINK: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
