#!/usr/bin/env node
// 首页顶栏横向溢出回归：320 / 375 / 桌面。
//
// 起因：320px 下 document.scrollWidth = 329，页面可横向滚动 9px。
// 判因方法很关键 —— 不能用 getBoundingClientRect 推断，它量的是元素自身盒子，
// 不反映祖先 overflow:hidden 的裁切。我第一次就是这样把锅扣给了 hero 的
// .sunset-glow（inset:-10% 使其盒宽 385px），而它其实被 .hero-media{overflow:hidden}
// 完整裁掉，从未参与文档宽度。
// 这里改用「逐个 display:none 后重量 scrollWidth」：只有真正撑宽文档的元素，
// 隐藏后才会让 scrollWidth 下降。用这个方法定位到真凶是 .header-actions/#menuBtn。
//
// 根因：汉堡模式下 .header-inner 是 grid-template-columns:1fr auto，
// 1fr 的自动最小值等于 min-content，而 .brand 没有 min-width:0，
// 于是品牌列永远按 142px 占位；142 + 20(gap) + 153(actions) = 315 > 292(shell 内宽)。
// 仓库里 ≤380 早就写了 .brand-name{min-width:0} 与 small{text-overflow:ellipsis}，
// 只是永远没有机会生效。修法就是把那份意图接通：minmax(0,1fr) + .brand{min-width:0}。
//
// 用法: node scripts/test-header-layout.mjs
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
}

// 逐个隐藏候选元素并重量 scrollWidth：真正撑宽文档的才会让它下降。
const BISECT = `(() => {
  const docEl = document.documentElement;
  const before = docEl.scrollWidth;
  const vw = docEl.clientWidth;
  const label = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') +
    (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/)[0] : '');
  const cands = [...document.querySelectorAll('body *')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 0.5; });
  const culprits = [];
  for (const e of cands) {
    const prev = e.style.display;
    e.style.display = 'none';
    const after = docEl.scrollWidth;
    e.style.display = prev;
    if (after < before) culprits.push(label(e) + '(-' + (before - after) + ')');
  }
  return { before, vw, innerWidth: window.innerWidth, candidates: cands.length, culprits };
})()`;

const HEADER = `(() => {
  const vw = document.documentElement.clientWidth;
  const parts = ['.brand','.brand-seal-btn','.header-actions','.lang-btn','.theme-toggle','.menu-btn'];
  const over = parts.map(s => {
    const e = document.querySelector(s);
    if (!e || getComputedStyle(e).display === 'none') return null;
    const r = e.getBoundingClientRect();
    return r.right > vw + 0.5 ? s + '(right=' + Math.round(r.right) + ')' : null;
  }).filter(Boolean);
  const menu = document.querySelector('.menu-btn');
  const mr = menu ? menu.getBoundingClientRect() : null;
  const small = document.querySelector('.brand-name small');
  return {
    vw, overflowing: over,
    menuVisible: mr ? getComputedStyle(menu).display !== 'none' : false,
    menuW: mr ? Math.round(mr.width) : 0, menuH: mr ? Math.round(mr.height) : 0,
    menuRight: mr ? Math.round(mr.right) : 0,
    // 副标题文字本身必须仍在 DOM 里（只是视觉截断），不能为了排版把内容删掉
    subText: small ? (small.textContent || '').trim() : '',
    subW: small ? Math.round(small.getBoundingClientRect().width) : 0
  };
})()`;

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== HEADER LAYOUT: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9420 + (process.pid % 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-header-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "about:blank"], { stdio: "ignore" });

let fullSubText = "";
try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const VIEWPORTS = [
    { w: 320, h: 700, mobile: true, tag: "320" },
    { w: 375, h: 780, mobile: true, tag: "375" },
    { w: 1280, h: 900, mobile: false, tag: "1280" },
  ];

  for (const v of VIEWPORTS) {
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile });
    await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
    await sleep(2400);

    const b = await cdp.ev(BISECT);
    const h = await cdp.ev(HEADER);
    if (v.tag === "1280") fullSubText = h.subText;

    check(b.innerWidth <= v.w + 1,
      `T-${v.tag} layout viewport is not widened by shrink-to-fit`,
      `innerWidth=${b.innerWidth} device=${v.w}`);
    check(b.before <= b.vw + 1,
      `T-${v.tag}b no horizontal document overflow`,
      `scrollWidth=${b.before} clientWidth=${b.vw}`);
    check(b.culprits.length === 0,
      `T-${v.tag}c no element widens the document`,
      b.culprits.length ? b.culprits.join(", ") : `checked ${b.candidates} boxed-over candidates, none widen it`);
    check(h.overflowing.length === 0,
      `T-${v.tag}d every header control sits inside the viewport`,
      h.overflowing.length ? h.overflowing.join(", ") : `vw=${h.vw}`);

    if (v.mobile) {
      check(h.menuVisible && h.menuW >= 44 && h.menuH >= 44 && h.menuRight <= h.vw,
        `T-${v.tag}e hamburger keeps its 44px target and stays on screen`,
        `${h.menuW}x${h.menuH} right=${h.menuRight} vw=${h.vw}`);
    }
  }

  // 反空过：把本轮两个旋钮都还原回修复前，320px 下的文档溢出必须回来。
  // 只还原 minmax 是不够的 —— 间距收紧本身已把 23px 降到 11px，
  // 那 11px 溢出的是 shell 而不是视口，文档宽度不变，控制组会「绿着通过」。
  // 一个不会变红的负向控制等于没有控制，所以两个旋钮必须一起还原。
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 320, height: 700, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(`(() => {
    const st = document.createElement('style');
    st.textContent = '@media(max-width:1250px){.header-inner{grid-template-columns:1fr auto}' +
      '.brand,.brand-name{min-width:auto}}' +
      '@media(max-width:380px){.header-inner{gap:20px}.header-actions{gap:9px}}';
    document.head.appendChild(st);
  })()`);
  await sleep(500);
  const broken = await cdp.ev(BISECT);
  check(broken.culprits.length > 0,
    "T0 control: reverting the shrink fix brings the overflow back (not vacuous)",
    broken.culprits.length ? broken.culprits.join(", ") : "no overflow reappeared");

  // 内容保全：副标题文字一个字都不能因为排版而消失
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  const sub = await cdp.ev(HEADER);
  check(fullSubText.length > 0 && sub.subText === fullSubText,
    "T1 brand sub-line text is preserved in full at 320px (visually truncated only)",
    `chars=${sub.subText.length} identical=${sub.subText === fullSubText}`);

  // 语言鲁棒性：四种语言的品牌副标题长度不同。单靠收紧间距只是把中文挤了进去，
  // 换一种更长的语言就会再溢出；minmax(0,1fr) 才是「任何语言都不可能溢出」的保证。
  for (const lang of ["en", "ko", "th"]) {
    await cdp.ev(`(() => {
      const b = [...document.querySelectorAll('[data-lang]')].find(x => x.getAttribute('data-lang') === '${lang}');
      if (b) b.click();
    })()`);
    await sleep(700);
    const bl = await cdp.ev(BISECT);
    const hl = await cdp.ev(HEADER);
    check(bl.before <= bl.vw + 1 && hl.overflowing.length === 0,
      `T2-${lang} no overflow at 320px after switching language`,
      `scrollWidth=${bl.before} clientWidth=${bl.vw} overflowing=[${hl.overflowing.join(",")}]`);
  }

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
console.log(`=== HEADER LAYOUT: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
