#!/usr/bin/env node
// 打开态浮层内的触控目标：移动抽屉 / 申请弹窗 / 客服面板 / 招生卡片 / 校标弹窗。
//
// 为什么要单独一份：前几轮的全页普查是在**浮层关着**的状态下扫的，
// 关着的浮层要么 display:none、要么 visibility:hidden、要么 pointer-events:none，
// 里面的控件量出来是 0x0 或「中心点落空」，于是被当成噪声跳过。
// 但它们恰恰是访客真正会点的东西 —— 抽屉是手机端主导航，申请弹窗是转化终点。
// 「普查没报」在这里等于「普查够不着」，不等于没问题。
//
// 每个浮层都用**真实点击它自己的入口**打开，而不是直接改 class/hidden：
// 直接改状态会绕过站点自己的开关逻辑，量到的可能是一个真人到不了的形态。
//
// 判据由共享量具 scripts/lib/touch-probe.mjs 提供（外接盒 + 是否被压住两步走）。
//
// 用法: node scripts/test-overlay-touch.mjs
// Chrome 路径可用环境变量 CHROME 覆盖；找不到时以非零退出，不静默跳过。

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOUCH_PROBE } from "./lib/touch-probe.mjs";

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
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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
}

// 每个浮层：用真人的入口打开 / 容器 / 中文名。
// opener 必须是页面上真实存在的入口，点不开就让断言红 —— 那本身也是缺陷。
const OVERLAYS = [
  { key: "drawer", name: "移动抽屉", opener: "#menuBtn", box: "#mobileDrawer .drawer-panel" },
  { key: "apply", name: "申请弹窗", opener: "[data-open-application]", box: "#applicationModal .modal-card" },
  { key: "chat", name: "客服面板", opener: "#chatFab", box: "#chatPanel" },
  { key: "promo", name: "招生卡片", opener: ".promo-tab", box: "#promoCard" },
  { key: "seal", name: "校标弹窗", opener: "[data-open-seal]", box: "#sealModal .modal-card" },
];

const PROBE = TOUCH_PROBE + `
// 浮层里所有「此刻真能点」的控件。可见性按祖先链算：只要链上有 display:none /
// visibility:hidden / pointer-events:none，这一刻它就不是触控目标，不该算进来。
window.__overlayControls = (boxSel) => {
  const box = document.querySelector(boxSel);
  if (!box) return { missing: true, items: [] };
  const reachable = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' ||
          cs.pointerEvents === 'none' || parseFloat(cs.opacity || '1') < 0.01) return false;
      if (n.hasAttribute && n.hasAttribute('hidden')) return false;
    }
    return true;
  };
  const items = [];
  for (const el of box.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea')) {
    if (!reachable(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    // 先把它滚进所在浮层的可视区再量 —— 抽屉面板与弹窗卡片自己都是可滚动容器，
    // 不滚就量，量到的是「此刻露在外面的那一点点」，那是用户滚一下就能解决的事，
    // 不是控件本身的问题。别的几套测量本来就先 scrollIntoView，这一套之前漏了：
    // 量具原先看不见祖先裁剪，所以这个漏洞一直没暴露出来（外接盒照样够大）。
    el.scrollIntoView({ block: 'nearest' });
    const t = window.__target(el, 44);
    items.push({
      name: (el.id ? '#' + el.id : el.tagName.toLowerCase() +
             (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '')) +
            ' "' + ((el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
              .trim().replace(/\\s+/g, ' ').slice(0, 10)) + '"',
      w: t.w, h: t.h, ok: t.ok, why: t.why, by: t.by
    });
  }
  return { missing: false, items };
};
// 浮层内相邻控件的盒子不得相交
window.__overlayOverlaps = (boxSel) => {
  const box = document.querySelector(boxSel);
  if (!box) return [];
  const els = [...box.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const bad = [];
  for (let i = 0; i < els.length; i++)
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i].getBoundingClientRect(), b = els[j].getBoundingClientRect();
      if (a.right <= b.left + 0.5 || a.left >= b.right - 0.5) continue;
      if (a.bottom <= b.top + 0.5 || a.top >= b.bottom - 0.5) continue;
      bad.push('"' + (els[i].textContent || els[i].getAttribute('aria-label') || '').trim().slice(0, 6) +
               '" 与 "' + (els[j].textContent || els[j].getAttribute('aria-label') || '').trim().slice(0, 6) + '" 相交');
    }
  return bad;
};
true;`;

// 负向控制：把本轮加大的浮层控件还原回去。
const REVERT = `(() => {
  if (document.getElementById('ov-revert')) return;
  const st = document.createElement('style');
  st.id = 'ov-revert';
  st.textContent =
    '.icon-btn,.modal-close{min-width:0!important;min-height:0!important;padding:0!important;display:inline!important}' +
    '.chat-input input,.chat-input button{height:42px!important;min-height:0!important}' +
    '#chatClose{min-width:0!important;min-height:0!important;padding:0!important}' +
    '.promo-close{min-width:0!important;min-height:0!important;padding:4px 8px!important}' +
    '.promo-actions .btn{min-height:42px!important}';
  document.head.appendChild(st);
})()`;

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== OVERLAY TOUCH: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9660 + (process.pid % 30);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-overlay-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

async function openOverlay(cdp, o) {
  // 每个浮层都从干净的一页开始，免得上一个浮层还开着互相盖住
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2200);
  await cdp.ev(PROBE);
  const opened = await cdp.ev(`(() => {
    const b = document.querySelector('${o.opener}');
    if (!b) return { ok: false, why: '入口不存在: ${o.opener}' };
    b.click();
    return { ok: true };
  })()`);
  await sleep(700);
  return opened;
}

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  for (const v of [{ w: 320, h: 720, tag: "320" }, { w: 375, h: 780, tag: "375" }]) {
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: true });
    for (const o of OVERLAYS) {
      const opened = await openOverlay(cdp, o);
      if (!opened.ok) { check(false, `O-${v.tag}-${o.key} ${o.name}：入口可点开`, opened.why); continue; }
      const res = await cdp.ev(`window.__overlayControls('${o.box}')`);
      if (res.missing || res.items.length === 0) {
        check(false, `O-${v.tag}-${o.key} ${o.name}：打开后能量到控件`,
          res.missing ? `找不到容器 ${o.box}` : `容器里没有可达控件（浮层没真的打开？）`);
        continue;
      }
      const small = res.items.filter((x) => !x.ok);
      check(small.length === 0,
        `O-${v.tag}-${o.key} ${o.name}：${res.items.length} 个控件都合格`,
        small.length ? "不足: " + small.map((x) => `${x.name} ${x.w}x${x.h}（${x.why}${x.by && x.by.length ? " 遮挡者=" + x.by.join(",") : ""}）`).join("; ")
                     : res.items.map((x) => `${x.name} ${x.w}x${x.h}`).join("; "));

      const ov = await cdp.ev(`window.__overlayOverlaps('${o.box}')`);
      check(ov.length === 0, `O-${v.tag}-${o.key}b ${o.name}：内部控件互不相交`,
        ov.length ? ov.join("; ") : `逐对比对 ${res.items.length} 个控件，无相交`);
    }
  }

  // 负向控制：还原后必须有控件变小。不会变红的断言等于没有断言。
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  const drawer = OVERLAYS[0];
  await openOverlay(cdp, drawer);
  await cdp.ev(REVERT);
  await sleep(400);
  const rev = await cdp.ev(`window.__overlayControls('${drawer.box}')`);
  const revSmall = (rev.items || []).filter((x) => !x.ok);
  check(revSmall.length >= 1,
    "O0 负向控制：还原本轮加大后，抽屉里的过小控件精确复现",
    revSmall.length ? revSmall.map((x) => `${x.name} ${x.w}x${x.h}`).join("; ") : "还原后没有任何控件变小");

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
console.log(`=== OVERLAY TOUCH: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
