#!/usr/bin/env node
// 转化终点触控目标回归：联系方式（邮箱 / 电话 / 「复制」键）与页脚站点导航。
//
// 为什么挑这两组：联系方式是访客真正要点的转化终点，页脚导航在手机上是站点的
// 全局导航（抽屉之外唯一的整站入口）。375px 实测它们全部低于 44：
// 邮箱 210x25、电话 134x25 / 144x25、「复制」42x25、页脚每条 347x20 且行距只有 33px。
//
// 判据由共享量具 scripts/lib/touch-probe.mjs 提供（外接盒 + 是否被压住两步走）。
//
// 页脚这组还有一条别处没有的约束：十几条链接上下紧挨，加高之后**相邻两条的命中区
// 不能互相重叠**，否则「点 A 触发 B」比小目标更糟。F*b 就是盯着这件事的。
//
// 用法: node scripts/test-contact-footer.mjs
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
  async tab(shift = false) {
    const base = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
                   modifiers: shift ? 8 : 0 };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(90);
  }
}

// 联系方式那几行由 JS 依 CONFIG.contact 渲染，留空的不出现，所以选择器按「第 n 行里的
// 链接」写，而不是写死 mailto/tel —— 配置换了值测试不该跟着红。
const SELECTORS = `[
  ['#contactMeta div:nth-child(1) a, #contactMeta div:nth-child(1) .copy-btn', '联系方式第 1 行'],
  ['#contactMeta div:nth-child(2) a, #contactMeta div:nth-child(2) .copy-btn', '联系方式第 2 行'],
  ['#contactMeta div:nth-child(3) a, #contactMeta div:nth-child(3) .copy-btn', '联系方式第 3 行'],
  ['.footer-col:nth-child(2) a:nth-of-type(1)', '页脚导航第 1 条'],
  ['.footer-col:nth-child(2) a:nth-of-type(2)', '页脚导航第 2 条'],
  ['.footer-col:nth-child(3) a:nth-of-type(1)', '页脚导航第 3 条'],
  ['#backToTop', '回到顶部']
]`;

// 量具本身来自 scripts/lib/touch-probe.mjs，三份回归脚本共用同一份，避免判据分叉。
const PROBE = TOUCH_PROBE + `
window.__sels = ${SELECTORS};
window.__measure = () => window.__sels.map(([sel, label]) => {
  const el = document.querySelector(sel);
  if (!el) return { label, missing: true };
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return { label, hidden: true };
  // 这两组在页面很靠下，必须先滚进视口 —— elementFromPoint 只认视口坐标，
  // 不滚的话量到的是「视口外」，会一律判成放不下，红的又是量具。
  el.scrollIntoView({ block: 'center' });
  const t = window.__target(el, 44);
  return { label, ...t, ok44: t.ok };
});
// 相邻热区：页脚每一列里十几条链接上下紧挨，加高之后相邻两条的盒子不能互相重叠 ——
// 「点 A 触发 B」比小目标更糟。联系方式各行同理（它们之间有分隔线）。
window.__overlaps = () => {
  const bad = [];
  const groups = [...document.querySelectorAll('.footer-col'), document.querySelector('#contactMeta')]
    .filter(Boolean);
  for (const g of groups) {
    const els = [...g.querySelectorAll('a[href], button')]
      .filter(e => getComputedStyle(e).display !== 'none');
    for (let i = 0; i + 1 < els.length; i++) {
      const a = els[i].getBoundingClientRect(), b = els[i + 1].getBoundingClientRect();
      if (a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5) continue;   // 上下不相交
      if (a.right <= b.left || a.left >= b.right) continue;               // 左右错开也不算
      bad.push('"' + (els[i].textContent || '').trim().slice(0, 8) + '" 与 "' +
               (els[i + 1].textContent || '').trim().slice(0, 8) + '" 命中区重叠 ' +
               Math.round(a.bottom - b.top) + 'px');
    }
  }
  return bad;
};
true;`;

// 负向控制：把本轮加高的两个控件还原回修复前的尺寸。
const REVERT = `(() => {
  if (document.getElementById('cf-revert')) return;
  const st = document.createElement('style');
  st.id = 'cf-revert';
  // 逐条还原本轮加的那几行，包括页脚给客服圆钮留的 84px 底部内边距 ——
  // 少了最后这一条，「↑ 顶部」被圆钮压住的那个缺陷就复现不出来。
  st.textContent =
    '#contactMeta a,#contactMeta .copy-btn{min-height:0!important;display:inline!important;padding:0!important}' +
    '.footer-col a{min-height:0!important;display:block!important;padding:0!important;margin-bottom:13px!important}' +
    '.footer-bottom button{min-height:0!important;min-width:0!important;display:inline!important;padding:0!important;margin-right:0!important}' +
    '.footer{padding-bottom:24px!important}';
  document.head.appendChild(st);
})()`;

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== CONTACT+FOOTER: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9700 + (process.pid % 60);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-hdrtouch-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const VIEWPORTS = [
    { w: 320, h: 720, mobile: true, tag: "320" },
    { w: 375, h: 780, mobile: true, tag: "375" },
    { w: 1280, h: 900, mobile: false, tag: "1280" },
  ];

  for (const v of VIEWPORTS) {
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile });
    // 把招生卡片置为「当天已关闭」再加载。这不是为了让测试好看，而是建模上的区分：
    // 卡片有 × 可以关掉、关了当天不再出现；客服圆钮不可关闭，永远压在右下角。
    // 页面末尾必须让位的是后者，所以本轮给页脚留了 84px；卡片能盖住页面最底端这件事
    // 属于「可由用户消除」的一类，记录在报告里而不用版面去换。
    await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
    await sleep(600);
    await cdp.ev(`localStorage.setItem('amas-promo-dismissed', new Date().toISOString().slice(0,10))`);
    await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
    await sleep(2400);
    await cdp.ev(PROBE);

    const m = await cdp.ev(`window.__measure()`);
    const shown = m.filter((x) => !x.hidden && !x.missing);
    const small = shown.filter((x) => !x.ok44);
    // 手机才要求 44：44 这个数是给手指定的。桌面上同一批控件由鼠标操作，
    // 这轮不动它们的视觉尺寸，所以断言也只在手机断点上成立，免得假装管了没管的事。
    if (v.mobile) {
      check(small.length === 0,
        `F-${v.tag} 联系方式与页脚 ${shown.length} 个可见控件都合格（外接盒 >= 44x44 且无人压住）`,
        small.length ? "不足: " + small.map((x) => `${x.label} ${x.w}x${x.h}`).join("; ")
                     : shown.map((x) => `${x.label} ${x.w}x${x.h}`).join("; "));
    } else {
      check(shown.length > 0,
        `F-${v.tag} 桌面只记录不断言（44 是给手指定的）`,
        shown.map((x) => `${x.label} ${x.w}x${x.h} 合格=${x.ok44}（${x.why}）`).join("; "));
    }

    const ov = await cdp.ev(`window.__overlaps()`);
    check(ov.length === 0,
      `F-${v.tag}b 加高后相邻链接的命中区互不重叠（点 A 触发 B 比小目标更糟）`,
      ov.length ? ov.join("; ") : `页脚各列与联系方式逐对相邻比对，无重叠`);

    const doc = await cdp.ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, iw: window.innerWidth })`);
    check(doc.sw <= doc.cw + 1 && doc.iw <= v.w + 1,
      `F-${v.tag}c 加高没有把视口撑宽`,
      `scrollWidth=${doc.sw} clientWidth=${doc.cw} innerWidth=${doc.iw} device=${v.w}`);


    // 键盘：逐个控件用真实按键确认焦点圈与命中区。
    // 不断言全局 Tab 顺序 —— 桌面有登录键、手机没有，顺序本就不同，
    // 断言一个随断点变化的顺序只会制造假红。
    if (v.mobile) {
      const kb = [];
      for (const [sel, label] of JSON.parse(
        JSON.stringify(await cdp.ev(`window.__sels`)))) {
        const exists = await cdp.ev(`(() => { const e = document.querySelector('${sel}');
          return !!e && getComputedStyle(e).display !== 'none'; })()`);
        if (!exists) continue;
        await cdp.ev(`document.querySelector('${sel}').scrollIntoView({block:'center'})`);
        await cdp.ev(`document.querySelector('${sel}').focus()`);
        await cdp.tab(true);    // 退出去
        await cdp.tab(false);   // 用键盘再走回来，:focus-visible 才是真的
        const st = await cdp.ev(`(() => {
          const el = document.querySelector('${sel}');
          const cs = getComputedStyle(el);
          const tg = window.__target(el, 44);
          const sq = tg.ok;
          // 说不出是谁盖的，红了也没法修
          let by = '';
          if (!sq) {
            const r = el.getBoundingClientRect();
            const seen = new Set();
            for (let x = r.left + 1; x < r.right; x += 4)
              for (let y = r.top + 1; y < r.bottom; y += 4) {
                const t = document.elementFromPoint(x, y);
                if (!t || t === el || el.contains(t)) continue;
                seen.add(t.id ? '#' + t.id : t.tagName.toLowerCase() +
                  (t.className && typeof t.className === 'string' ? '.' + t.className.trim().split(/\s+/)[0] : ''));
              }
            by = seen.size ? ' 盒=' + Math.round(r.width) + 'x' + Math.round(r.height) +
                 ' 遮挡者=' + [...seen].slice(0, 3).join(',')
               : ' 盒=' + Math.round(r.width) + 'x' + Math.round(r.height) + ' 无人遮挡(盒子本身不足44)';
          }
          return { focused: document.activeElement === el, fv: el.matches(':focus-visible'),
                   outlined: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
                   sq, by };
        })()`);
        kb.push({ label, ...st, ok: st.focused && st.fv && st.outlined && st.sq });
      }
      const bad = kb.filter((x) => !x.ok);
      check(kb.length > 0 && bad.length === 0,
        `F-${v.tag}e 键盘路径：逐个可聚焦、焦点圈可见、聚焦后仍合格`,
        bad.length ? bad.map((x) => `${x.label}(聚焦=${x.focused} focus-visible=${x.fv} 焦点圈=${x.outlined} 44方块=${x.sq}${x.by || ''})`).join("; ")
                   : `${kb.length} 个全部通过`);
    }
  }

  // 负向控制：把加高还原回去，44 断言必须变红
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  await cdp.ev(REVERT);
  await sleep(400);
  const rev = await cdp.ev(`window.__measure()`);
  const revSmall = rev.filter((x) => !x.hidden && !x.missing && !x.ok44);
  check(revSmall.length >= 2,
    "F0 负向控制：还原本轮加高后，过小控件精确复现（否则上面的断言是空的）",
    revSmall.length ? revSmall.map((x) => `${x.label} ${x.w}x${x.h}`).join("; ") : "还原后没有任何控件变小");

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
console.log(`=== CONTACT+FOOTER: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
