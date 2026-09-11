#!/usr/bin/env node
// 顶部公告条的可访问性回归：暂停/继续、键盘可操作、reduced-motion 静止。
//
// 背景：公告条 46s linear infinite 自动滚动，原先唯一的暂停条件是
// .announce-bar:hover —— 触屏没有 hover，键盘也用不上，等于没有机制
// （WCAG 2.2.2 Pause, Stop, Hide）。其中「查看招生信息」还是一个持续移动的点击目标。
//
// 用法: node scripts/test-announce-a11y.mjs
// Chrome 路径可用环境变量 CHROME 覆盖；找不到时以非零退出，不静默跳过。
// 全部运行时输出为 ASCII。

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
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
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
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const i = ++this.id; this.pending.set(i, { res, rej });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval threw: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  }
  // Enter 与 Space 要带 text 走 "keyDown"，否则 CDP 不会触发按钮的默认激活行为
  // （rawKeyDown 只送按键、不产生合成 click）。Tab 之类的导航键用 rawKeyDown 即可。
  async key(k, code, vk, modifiers = 0) {
    const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    const text = k === "Enter" ? "\r" : k === " " ? " " : null;
    await this.send("Input.dispatchKeyEvent",
      text === null ? { type: "rawKeyDown", ...base } : { type: "keyDown", text, ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(120);
  }
}

// 轨道位移（px）。取 transform 矩阵的 tx。
const TX = `(() => {
  const t = getComputedStyle(document.querySelector('.announce-track')).transform;
  if (!t || t === 'none') return 0;
  const m = t.match(/matrix\\(([^)]+)\\)/);
  return m ? Math.round(parseFloat(m[1].split(',')[4])) : 0;
})()`;

const STATE = `(() => {
  const bar = document.querySelector('.announce-bar');
  const track = document.querySelector('.announce-track');
  const btn = document.querySelector('.announce-toggle');
  const cs = getComputedStyle(track);
  const firstSet = document.querySelector('.announce-set:not([aria-hidden="true"])');
  const dup = document.querySelector('.announce-set[aria-hidden="true"]');
  const r = btn ? btn.getBoundingClientRect() : null;
  return {
    hasButton: !!btn,
    btnTag: btn ? btn.tagName : null,
    btnW: r ? Math.round(r.width) : 0,
    btnH: r ? Math.round(r.height) : 0,
    pressed: btn ? btn.getAttribute('aria-pressed') : null,
    label: btn ? (btn.getAttribute('aria-label') || '') : '',
    labelLen: btn ? (btn.getAttribute('aria-label') || '').length : 0,
    playState: cs.animationPlayState,
    animName: cs.animationName,
    paused: bar.classList.contains('announce-paused'),
    dupDisplay: dup ? getComputedStyle(dup).display : 'absent',
    firstSetLeft: firstSet ? Math.round(firstSet.getBoundingClientRect().left) : null,
    innerOverflowX: getComputedStyle(document.querySelector('.announce-inner')).overflowX,
    btnDisplay: btn ? getComputedStyle(btn).display : 'absent',
    barW: Math.round(bar.getBoundingClientRect().width),
    docW: document.documentElement.scrollWidth,
    vw: window.innerWidth
  };
})()`;

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== ANNOUNCE A11Y: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9050 + (process.pid % 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-announce-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "about:blank"], { stdio: "ignore" });

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2600);

  const s0 = await cdp.ev(STATE);
  check(s0.hasButton && s0.btnTag === "BUTTON",
    "T1 a real <button> control exists in the announce bar", `tag=${s0.btnTag}`);
  check(s0.btnW >= 44, "T1b control meets the 44px minimum touch width",
    `${s0.btnW}x${s0.btnH} (bar height caps the vertical extent; brand layout unchanged)`);
  check(s0.pressed === "false" && s0.labelLen > 0,
    "T1c control exposes aria-pressed and a localized label",
    `aria-pressed=${s0.pressed} label.len=${s0.labelLen}`);

  // --- T2 反空过：确认动画确实在跑 ---
  const a = await cdp.ev(TX); await sleep(1000); const b = await cdp.ev(TX);
  check(Math.abs(a - b) > 4, "T2 ticker is actually moving before the pause (not vacuous)",
    `tx ${a} -> ${b}`);

  // --- T3 键盘可达并可用空格激活 ---
  await cdp.ev(`document.activeElement && document.activeElement.blur(); window.scrollTo(0,0)`);
  let tabs = 0, reached = false;
  for (let i = 1; i <= 20 && !reached; i++) {
    await cdp.key("Tab", "Tab", 9);
    tabs = i;
    reached = await cdp.ev(`!!(document.activeElement && document.activeElement.classList.contains('announce-toggle'))`);
  }
  check(reached, "T3 control is reachable by Tab", `tab presses=${tabs}`);
  await cdp.key(" ", "Space", 32);
  await sleep(400);
  const s1 = await cdp.ev(STATE);
  check(s1.paused && s1.playState === "paused",
    "T3b Space activates the control and pauses the ticker",
    `paused=${s1.paused} playState=${s1.playState}`);
  check(s1.pressed === "true", "T3c aria-pressed flips to true", `aria-pressed=${s1.pressed}`);
  check(s1.label !== s0.label, "T3d label changes to the resume wording",
    `label changed=${s1.label !== s0.label}`);

  // --- T4 真的停住了 ---
  const c = await cdp.ev(TX); await sleep(1200); const d = await cdp.ev(TX);
  check(c === d, "T4 ticker position no longer changes while paused", `tx ${c} -> ${d}`);

  // --- T5 Enter 恢复 ---
  await cdp.key("Enter", "Enter", 13);
  await sleep(400);
  const s2 = await cdp.ev(STATE);
  check(!s2.paused && s2.playState === "running" && s2.pressed === "false",
    "T5 Enter resumes the ticker and restores aria-pressed",
    `paused=${s2.paused} playState=${s2.playState} aria-pressed=${s2.pressed}`);

  // --- T6 副本不被朗读：只有一份内容暴露给辅助技术 ---
  const dup = await cdp.ev(`(() => {
    const sets = [...document.querySelectorAll('.announce-set')];
    const exposed = sets.filter(s => !s.closest('[aria-hidden="true"]'));
    const links = [...document.querySelectorAll('.announce-bar a[href]')];
    return { sets: sets.length, exposed: exposed.length,
             focusableDup: links.filter(a => a.closest('[aria-hidden="true"]') && a.tabIndex >= 0).length };
  })()`);
  check(dup.sets === 2 && dup.exposed === 1,
    "T6 only one copy of the announcement text is exposed to assistive tech",
    `sets=${dup.sets} exposed=${dup.exposed}`);
  check(dup.focusableDup === 0, "T6b no focusable link inside the aria-hidden copy",
    `focusable duplicates=${dup.focusableDup}`);

  // ================= 320px 窄屏 =================
  // 改变视口后重新导航：只改 metrics 而不重载时，innerWidth 可能沿用上一次的布局宽度，
  // 测出来的「320px」其实不是 320px。
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  const s320 = await cdp.ev(STATE);
  // 曾经这里 innerWidth 实测是 329（浏览器 shrink-to-fit）。我当时归因给 hero 的
  // .sunset-glow，那是错的 —— 它被 .hero-media{overflow:hidden} 裁掉，从未参与文档宽度。
  // 真凶是 .header-actions/#menuBtn，已在 test-header-layout.mjs 里单独复现并修复。
  check(s320.vw <= 321, "T7 viewport really is 320px wide (no shrink-to-fit)",
    `innerWidth=${s320.vw}`);
  check(s320.btnW >= 44 && s320.btnDisplay !== "none",
    "T7b control still present and full width at 320px", `${s320.btnW}x${s320.btnH}`);
  check(s320.barW <= s320.vw + 1, "T7c the announce bar itself does not overflow the viewport",
    `bar=${s320.barW} vw=${s320.vw}`);
  check(s320.docW <= s320.vw + 1, "T7d no horizontal scroll beyond the layout viewport",
    `docW=${s320.docW} vw=${s320.vw}`);

  // ================= reduced-motion =================
  await cdp.send("Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  const rm = await cdp.ev(STATE);
  check(rm.animName === "none", "T8 reduced motion: ticker animation is explicitly none",
    `animation-name=${rm.animName}`);
  const e = await cdp.ev(TX); await sleep(900); const f = await cdp.ev(TX);
  check(e === 0 && f === 0, "T8b reduced motion: track sits at its origin, not offset",
    `tx ${e} -> ${f}`);
  check(rm.firstSetLeft !== null && rm.firstSetLeft >= -1,
    "T8c reduced motion: the real (non-aria-hidden) first copy is what is shown",
    `first set left=${rm.firstSetLeft}`);
  check(rm.dupDisplay === "none", "T8d reduced motion: the duplicate copy is removed",
    `duplicate display=${rm.dupDisplay}`);
  check(rm.innerOverflowX === "auto" || rm.innerOverflowX === "scroll",
    "T8e reduced motion: remaining text stays reachable by horizontal scroll",
    `overflow-x=${rm.innerOverflowX}`);
  check(rm.btnDisplay === "none", "T8f reduced motion: pause control is hidden (nothing to pause)",
    `display=${rm.btnDisplay}`);

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
console.log(`=== ANNOUNCE A11Y: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
