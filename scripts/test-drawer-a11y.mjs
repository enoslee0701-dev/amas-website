#!/usr/bin/env node
// 移动抽屉与公告条的键盘可访问性回归。
//
// 起因：375px 下从页顶按 Tab，第 3 站落在公告条 aria-hidden 副本里的重复链接上，
// 第 9 站起连续掉进「关闭状态」的移动抽屉 —— 因为关闭态只做了
// opacity:0 + pointer-events:none，这对肉眼和鼠标有效，对键盘无效。
// 键盘访客因此在首页就走丢，到不了招生 CTA。
//
// 修法：抽屉关闭态加 visibility:hidden（打开态 visibility:visible），
// 公告条副本里的链接加 tabindex="-1"。
//
// 本测试同时验证「隐藏的确实退出 Tab 顺序」与「打开后功能一切照旧」——
// 只验前者的话，一个把抽屉彻底焊死的改动也能通过。
//
// 用法: node scripts/test-drawer-a11y.mjs
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
  async tab(shift = false) {
    const base = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: shift ? 8 : 0 };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(70);
  }
  async esc() {
    const base = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(350);
  }
}

// 当前焦点所在元素的可观测状态
const FOCUS = `(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return { tag: "(body)", inAriaHidden: false, inDrawer: false, text: "" };
  const hid = a.closest('[aria-hidden="true"]');
  return {
    tag: a.tagName.toLowerCase() + (a.className && typeof a.className === "string"
         ? "." + a.className.trim().split(/\\s+/)[0] : ""),
    inAriaHidden: !!hid,
    hiddenOwner: hid ? String(hid.className || hid.tagName).slice(0, 20) : "",
    inDrawer: !!a.closest(".mobile-drawer"),
    isMenuBtn: a.id === "menuBtn",
    text: (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 20)
  };
})()`;

async function walk(cdp, steps) {
  await cdp.ev(`document.activeElement && document.activeElement.blur(); window.scrollTo(0,0)`);
  const stops = [];
  for (let i = 0; i < steps; i++) {
    await cdp.tab();
    stops.push(await cdp.ev(FOCUS));
  }
  return stops;
}

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== DRAWER A11Y: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9200 + (process.pid % 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-drawer-"));
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
  await sleep(2500);

  // --- T0 反空过：往 aria-hidden 子树里塞一个可聚焦元素，遍历必须抓到 ---
  await cdp.ev(`(() => {
    const host = document.querySelector('.announce-set[aria-hidden="true"]');
    const a = document.createElement('a');
    a.href = '#'; a.id = 'canary'; a.textContent = 'canary';
    a.style.cssText = 'position:fixed;top:0;left:0';
    host.appendChild(a);
  })()`);
  const canaryStops = await walk(cdp, 8);
  check(canaryStops.some((s) => s.inAriaHidden),
    "T0 the walk can detect a focusable element inside aria-hidden (not vacuous)",
    `hits=${canaryStops.filter((s) => s.inAriaHidden).length}`);
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2200);

  // --- T1 关闭态：机制断言 ---
  const closed = await cdp.ev(`(() => {
    const d = document.getElementById('mobileDrawer');
    const cs = getComputedStyle(d);
    return { visibility: cs.visibility, opacity: cs.opacity, ariaHidden: d.getAttribute('aria-hidden') };
  })()`);
  check(closed.visibility === "hidden", "T1 closed drawer is visibility:hidden (what removes it from tab order)",
    `visibility=${closed.visibility} opacity=${closed.opacity} aria-hidden=${closed.ariaHidden}`);

  // --- T2 从页顶 Tab 14 站，不得落进任何 aria-hidden 子树 ---
  const stops = await walk(cdp, 14);
  const real = stops.filter((s) => s.tag !== "(body)");
  check(real.length >= 10, "T2 the walk actually visited enough stops (precondition)", `stops=${real.length}`);
  const hidden = stops.filter((s) => s.inAriaHidden);
  check(hidden.length === 0, "T2b no tab stop lands inside an aria-hidden subtree",
    hidden.length ? `hits=${hidden.map((h) => h.tag + "<" + h.hiddenOwner + ">").join(", ")}` : "hits=0");
  const drawerStops = stops.filter((s) => s.inDrawer);
  check(drawerStops.length === 0, "T2c no tab stop lands inside the closed drawer",
    `drawer stops=${drawerStops.length}`);

  // --- T3 公告条副本的链接退出 Tab 顺序，本体保留 ---
  const ann = await cdp.ev(`(() => {
    const links = [...document.querySelectorAll('.announce-bar a[href]')];
    return links.map(a => ({
      tabIndex: a.tabIndex,
      hidden: !!a.closest('[aria-hidden="true"]')
    }));
  })()`);
  const visibleLinks = ann.filter((a) => !a.hidden);
  const dupLinks = ann.filter((a) => a.hidden);
  check(visibleLinks.length > 0 && visibleLinks.every((a) => a.tabIndex >= 0),
    "T3 the real announce link stays keyboard reachable", `count=${visibleLinks.length}`);
  check(dupLinks.length > 0 && dupLinks.every((a) => a.tabIndex < 0),
    "T3b the aria-hidden duplicate link is out of the tab order",
    `duplicates=${dupLinks.length} tabIndex=${dupLinks.map((a) => a.tabIndex).join(",")}`);

  // --- T4 打开抽屉：可见、aria-hidden=false、焦点移入 ---
  // 先聚焦再激活 —— 模拟真人（点按钮会先让它获得焦点）。
  // 直接 .click() 时 activeElement 仍是 body，openLayer 记下的 restoreTo 就是 body，
  // 关闭后焦点自然回不到按钮上；那是器具的锅，不是页面的。
  await cdp.ev(`document.getElementById('menuBtn').focus(); document.getElementById('menuBtn').click()`);
  await sleep(600);
  const open = await cdp.ev(`(() => {
    const d = document.getElementById('mobileDrawer');
    const cs = getComputedStyle(d);
    return { visibility: cs.visibility, ariaHidden: d.getAttribute('aria-hidden'),
             expanded: document.getElementById('menuBtn').getAttribute('aria-expanded'),
             focusInside: !!(document.activeElement && document.activeElement.closest('.drawer-panel')) };
  })()`);
  check(open.visibility === "visible" && open.ariaHidden === "false",
    "T4 opened drawer becomes visible and exposed to assistive tech",
    `visibility=${open.visibility} aria-hidden=${open.ariaHidden} aria-expanded=${open.expanded}`);
  check(open.focusInside, "T4b focus moves into the drawer panel on open", `focusInside=${open.focusInside}`);

  // --- T5 焦点陷阱：连按 Tab 不得逃出面板 ---
  let escaped = 0;
  for (let i = 0; i < 16; i++) {
    await cdp.tab();
    const f = await cdp.ev(FOCUS);
    if (!f.inDrawer) escaped++;
  }
  check(escaped === 0, "T5 focus stays trapped inside the open drawer", `escapes=${escaped}`);

  // --- T6 Esc 关闭，焦点归还，且重新退出 Tab 顺序 ---
  await cdp.esc();
  const afterEsc = await cdp.ev(`(() => {
    const d = document.getElementById('mobileDrawer');
    return { visibility: getComputedStyle(d).visibility, ariaHidden: d.getAttribute('aria-hidden'),
             focusOnMenuBtn: document.activeElement && document.activeElement.id === 'menuBtn' };
  })()`);
  check(afterEsc.ariaHidden === "true" && afterEsc.visibility === "hidden",
    "T6 Escape closes the drawer and re-hides it from the tab order",
    `visibility=${afterEsc.visibility} aria-hidden=${afterEsc.ariaHidden}`);
  check(afterEsc.focusOnMenuBtn, "T6b focus returns to the menu button", `restored=${afterEsc.focusOnMenuBtn}`);

  // --- T7 抽屉导航仍能用：点「招生信息」应跳到 #admissions 并关闭抽屉 ---
  // 先聚焦再激活 —— 模拟真人（点按钮会先让它获得焦点）。
  // 直接 .click() 时 activeElement 仍是 body，openLayer 记下的 restoreTo 就是 body，
  // 关闭后焦点自然回不到按钮上；那是器具的锅，不是页面的。
  await cdp.ev(`document.getElementById('menuBtn').focus(); document.getElementById('menuBtn').click()`);
  await sleep(500);
  await cdp.ev(`(() => {
    const a = [...document.querySelectorAll('.mobile-drawer nav a')].find(x => x.getAttribute('href') === '#admissions');
    if (a) a.click();
  })()`);
  await sleep(800);
  const nav = await cdp.ev(`({ hash: location.hash,
    visibility: getComputedStyle(document.getElementById('mobileDrawer')).visibility })`);
  check(nav.hash === "#admissions", "T7 drawer navigation to the admissions section still works", `hash=${nav.hash}`);
  check(nav.visibility === "hidden", "T7b drawer closes after navigating", `visibility=${nav.visibility}`);

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
console.log(`=== DRAWER A11Y: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
