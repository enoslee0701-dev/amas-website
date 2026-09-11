#!/usr/bin/env node
// 顶栏控件触控目标回归：语言键 / 主题键 / 品牌首页链接 / 汉堡键。
//
// 为什么单开一份而不是并进 test-touch-targets.mjs：
// 那份脚本 18/18 已绿，改它的结构去容纳第二组，失败时就分不清是新组的问题
// 还是改结构碰坏了旧组。仓库本来也是一脚本一关注点（header-layout / announce-a11y /
// drawer-a11y / discover-back-link / touch-targets / promo-tab），照此新增一份。
//
// 判据与前两轮一致：控件上必须放得下一整块完全属于自己的 44x44，
// 用 document.elementFromPoint 实测，全程浮点，采样坐标夹进视口
// （贴视口边缘的点会被 Chrome round 到视口外而返回 null）。
//
// 顶栏还有一条这两轮没有的约束：加宽控件会挤压品牌列。第十轮把栅格首列改成
// minmax(0,1fr) 之后，挤压会被品牌副标题的省略号吸收而不是撑破视口 —— H*c
// 就是盯着这件事的，它必须在 320px 下也为真。
//
// 用法: node scripts/test-header-touch.mjs
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

// 本轮范围：顶栏里在 375px 实测低于 44 的三个，外加汉堡键作为「不许被改坏」的哨兵。
// 公告条的暂停键（44x30）不在本轮范围，理由写在报告里：它已满足 WCAG 2.5.8 AA 的
// 24x24；要凑到 44 高只能把整条公告条从 30px 拉到 44px（每一页每一屏都多占 14px），
// 或者把命中区往下伸进顶栏 —— 那会去抢下面三个控件的热区。两者都比它解决的问题更糟。
const SELECTORS = `[
  ['.brand-name', '品牌首页链接'],
  ['#langBtn', '语言切换'],
  ['#themeToggle', '白日/夜晚'],
  ['#menuBtn', '汉堡菜单']
]`;

// 量具本身来自 scripts/lib/touch-probe.mjs，三份回归脚本共用同一份，避免判据分叉。
const PROBE = TOUCH_PROBE + `
window.__sels = ${SELECTORS};
window.__measure = () => window.__sels.map(([sel, label]) => {
  const el = document.querySelector(sel);
  if (!el) return { label, missing: true };
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden')
    return { label, hidden: true };           // 汉堡键在桌面隐藏、登录键在手机隐藏，都属正常
  const t = window.__target(el, 44);
  return { label, ...t, ok44: t.ok };
});
// 相邻热区：本组控件的边框盒之间不得相交（顶栏控件排成一行，挨得最近）
window.__overlaps = () => {
  const els = window.__sels.map(([s]) => document.querySelector(s))
    .filter(e => e && getComputedStyle(e).display !== 'none');
  const bad = [];
  for (let i = 0; i < els.length; i++)
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i].getBoundingClientRect(), b = els[j].getBoundingClientRect();
      if (a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom) continue;
      bad.push((els[i].id || els[i].className) + ' 与 ' + (els[j].id || els[j].className) + ' 相交');
    }
  return bad;
};
// 品牌副标题：加宽控件会挤压品牌列，文字可以被省略号截断，但 DOM 里一个字都不能少
window.__brandSub = () => {
  const s = document.querySelector('.brand-name small');
  return s ? (s.textContent || '').trim() : '';
};
true;`;

// 负向控制：把本轮加高的两个控件还原回修复前的尺寸。
const REVERT = `(() => {
  if (document.getElementById('ht-revert')) return;
  const st = document.createElement('style');
  st.id = 'ht-revert';
  st.textContent = '@media(max-width:580px){' +
    '.lang-btn{height:34px!important;min-height:0!important}' +
    '.theme-toggle{width:34px!important;height:34px!important}' +
    '.brand-name{min-height:0!important;display:block!important}}';
  document.head.appendChild(st);
})()`;

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== HEADER TOUCH: ABORTED (no browser) ===");
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

  // 先在桌面读一次完整副标题当基准。原先是在循环里等桌面那一轮才赋值，
  // 而桌面排在最后 —— 于是 320/375 拿着空字符串去比，永远不相等。
  // 这种「基准还没准备好就开始比」的假红，比真缺陷更浪费时间。
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  let fullSub = await cdp.ev(`window.__brandSub()`);

  const VIEWPORTS = [
    { w: 320, h: 720, mobile: true, tag: "320" },
    { w: 375, h: 780, mobile: true, tag: "375" },
    { w: 1280, h: 900, mobile: false, tag: "1280" },
  ];

  for (const v of VIEWPORTS) {
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile });
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
        `H-${v.tag} 顶栏 ${shown.length} 个可见控件都放得下一整块 44x44`,
        small.length ? "不足: " + small.map((x) => `${x.label} ${x.w}x${x.h}`).join("; ")
                     : shown.map((x) => `${x.label} ${x.w}x${x.h}`).join("; "));
    } else {
      check(shown.length > 0,
        `H-${v.tag} 桌面只记录不断言（44 是给手指定的，本轮不动桌面视觉尺寸）`,
        shown.map((x) => `${x.label} ${x.w}x${x.h} 合格=${x.ok44}（${x.why}）`).join("; "));
    }

    const ov = await cdp.ev(`window.__overlaps()`);
    check(ov.length === 0,
      `H-${v.tag}b 加大后的顶栏控件互不相交`,
      ov.length ? ov.join("; ") : `逐对比对 ${shown.length} 个可见控件，无相交`);

    const doc = await cdp.ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, iw: window.innerWidth })`);
    check(doc.sw <= doc.cw + 1 && doc.iw <= v.w + 1,
      `H-${v.tag}c 加大顶栏控件没有把视口撑宽（第十轮 minmax(0,1fr) 必须吸收掉挤压）`,
      `scrollWidth=${doc.sw} clientWidth=${doc.cw} innerWidth=${doc.iw} device=${v.w}`);

    const sub = await cdp.ev(`window.__brandSub()`);
    if (v.mobile) check(sub.length > 0 && sub === fullSub,
      `H-${v.tag}d 品牌副标题被挤压后 DOM 文本一字不少（只允许视觉截断）`,
      `${sub.length} 字，与桌面基准（${fullSub.length} 字）一致=${sub === fullSub}`);

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
        `H-${v.tag}e 键盘路径：顶栏控件逐个可聚焦、焦点圈可见、聚焦后仍放得下 44x44`,
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
    "H0 负向控制：还原本轮加高后，过小控件精确复现（否则上面的断言是空的）",
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
console.log(`=== HEADER TOUCH: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
