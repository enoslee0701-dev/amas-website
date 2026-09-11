#!/usr/bin/env node
// 资源中心触控目标回归：命中区 >= 44x44，且不吃掉相邻热区。
//
// 量具的选择是这轮的关键。getBoundingClientRect 量的是元素自己的边框盒，
// 它既看不见 padding / 伪元素把命中区往外撑，也看不见别的元素压在上面把命中区抢走。
// 用它来判「够不够 44px」会同时产生假绿和假红。
//
// 这里改用 document.elementFromPoint 从控件中心逐像素向四个方向扩张：
// 只有真的能被点到、并且点下去命中的确实是这个控件（或它的后代）的点才算数。
// 于是「命中区多大」和「有没有覆盖邻居」用的是同一把尺，量的是浏览器真正的
// 命中测试结果，不是我对 CSS 的推断。
//
// 覆盖邻居的判据：一个控件的命中区不得与任何另一个可交互控件的边框盒相交。
// （命中区彼此天然不会相交 —— 每个点只归最上层元素 —— 所以只比命中区是空检查。
//  真正的风险是 A 的命中区盖住了 B 画在屏幕上的位置，用户看着 B 点下去却触发 A。）
//
// 键盘路径用真实的 Tab 按键事件走，不用 el.focus()：
// :focus-visible 取决于最后一次交互是不是键盘，程序化聚焦量不出真实的焦点圈。
//
// 用法: node scripts/test-touch-targets.mjs [--shots=<prefix>]
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

const shotArg = process.argv.find((a) => a.startsWith("--shots="));
const SHOT_PREFIX = shotArg ? shotArg.slice("--shots=".length) : null;
const SHOT_DIR = process.env.SHOT_DIR ||
  "C:/Users/enosl/Documents/Codex/2026-09-11/bang/work/shots";

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
  // 每个 CDP 调用都带超时：卡住时要指出是哪一步卡住，而不是整个脚本无声挂死。
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

// 本轮范围：资源中心的 6 个入口。
// 选择器写死而不是「扫全页所有按钮」，因为这轮只动资源中心；
// 扫全页会把顶栏 / 页脚等属于别的轮次的控件混进来，失败原因就说不清了。
const SELECTORS = `[
  ['#resourceList .resource-row:nth-child(1) button', '下载 新生手册'],
  ['#resourceList .resource-row:nth-child(2) button', '下载 课程目录'],
  ['#resourceList .resource-row:nth-child(3) button', '查看 学费'],
  ['#resourceList .resource-row:nth-child(4) button', '填写 在线申请'],
  ['#formDl', '下载 申请表 DOCX'],
  ['#uploadToggle', '上传 已填申请表']
]`;

// 从中心逐像素外扩，直到命中的不再是这个控件。量的是浏览器真实命中测试。
const PROBE = `
window.__sels = ${SELECTORS};
// 站点设了 html{scroll-behavior:smooth}。不关掉它，scrollIntoView 之后立刻读
// getBoundingClientRect 读到的是滚动途中的坐标，elementFromPoint 会打在别的元素上 ——
// 量出来是「中心点都落空」，看上去像控件不存在，其实只是量具跑在了滚动前面。
// 这一行必须在任何测量之前执行。
document.documentElement.style.scrollBehavior = 'auto';
window.__hit = (el) => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { center: false, w: 0, h: 0 };
  const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
  const owns = (x, y) => {
    if (x < 0 || y < 0 || x >= document.documentElement.clientWidth ||
        y >= document.documentElement.clientHeight) return false;
    const t = document.elementFromPoint(x, y);
    return !!t && (t === el || el.contains(t));
  };
  if (!owns(cx, cy)) return { center: false, w: 0, h: 0, left: cx, right: cx, top: cy, bottom: cy };
  const walk = (dx, dy) => {
    let n = 0;
    while (n < 200 && owns(cx + dx * (n + 1), cy + dy * (n + 1))) n++;
    return n;
  };
  const l = walk(-1, 0), rr = walk(1, 0), t = walk(0, -1), b = walk(0, 1);
  return { center: true, left: cx - l, right: cx + rr, top: cy - t, bottom: cy + b,
           w: l + rr + 1, h: t + b + 1, boxW: Math.round(r.width), boxH: Math.round(r.height) };
};
// 44x44 的手指落点必须是一整块，不能是「横着够 44、竖着够 44，但中间被挖了一块」。
// 穿过中心的十字量法会把 L 形也算成 44x44 —— 侧边招生标签正好会挖掉按钮右上角，
// 十字量出来仍是 72x45，实际上放不下一个完整的 44x44 方块。
// 这里在控件边框盒内逐个候选位置找一个完全属于自己的正方形，4px 采样。
window.__square = (el, size) => {
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const owns = (x, y) => {
    if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
    const t = document.elementFromPoint(x, y);
    return !!t && (t === el || el.contains(t));
  };
  // 全程用浮点，不做任何取整。边框盒的边缘几乎总是小数，
  // 而这一轮把高度正好设成了 44 —— 一旦对候选起点 ceil、终点 floor，
  // 「正好 44 高」的元素算出来的整数候选区间是空的，于是每一个都判成放不下。
  // 这类差一错误会红得非常像真缺陷，但红的是量具。
  if (r.width + 1e-6 < size || r.height + 1e-6 < size) return { ok: false, w: r.width, h: r.height };
  // 采样点取在方块内部（±0.5），首尾都不踩边界
  const offs = [];
  for (let d = 0.5; d < size; d += 4) offs.push(d);
  if (offs[offs.length - 1] < size - 0.5) offs.push(size - 0.5);
  // 再把采样坐标夹进视口内。贴着视口边缘的元素在 x = 视口宽-0.5 上 elementFromPoint
  // 返回 null —— Chrome 把小数坐标 round 到设备像素后落到了视口外（实测 1279.5 -> null，
  // 1279 -> 命中）。曾经改成「最后一个采样点整体内缩 1.5px」，那等于把 44 的判据偷偷
  // 放宽成 42.5，负向控制当场变绿：灵敏度被自己调没了。所以精度保持 0.5，只夹坐标。
  const clamp = (x, hi) => Math.min(x, hi - 1);
  for (let ox = 0; ox <= r.width - size + 1e-6; ox += 1) {
    for (let oy = 0; oy <= r.height - size + 1e-6; oy += 1) {
      const x0 = r.left + ox, y0 = r.top + oy;
      let ok = true;
      for (let i = 0; i < offs.length && ok; i++)
        for (let j = 0; j < offs.length && ok; j++)
          if (!owns(clamp(x0 + offs[i], vw), clamp(y0 + offs[j], vh))) ok = false;
      if (ok) return { ok: true, x: Math.round(x0), y: Math.round(y0) };
    }
  }
  return { ok: false, w: Math.round(r.width), h: Math.round(r.height) };
};
// 方块放不下时，必须说得出是谁盖的。只报一句「放不下」，红了也没人知道往哪修。
window.__coverers = (el) => {
  const r = el.getBoundingClientRect();
  const names = new Set();
  for (let x = r.left + 0.5; x < r.right; x += 3) {
    for (let y = r.top + 0.5; y < r.bottom; y += 3) {
      const t = document.elementFromPoint(x, y);
      if (!t || t === el || el.contains(t)) continue;
      const top = t.closest('.promo-tab, .promo-card, .chat-fab, .chat-panel, .site-header, .toast') || t;
      names.add((top.id ? '#' + top.id : top.className && typeof top.className === 'string'
        ? '.' + top.className.trim().split(/\\s+/)[0] : top.tagName.toLowerCase()) +
        '@x' + Math.round(x) + ',y' + Math.round(y));
    }
  }
  return [...names].slice(0, 6);
};
window.__measure = () => {
  const out = [];
  for (const [sel, label] of window.__sels) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ sel, label, missing: true, w: 0, h: 0 }); continue; }
    el.scrollIntoView({ block: 'center' });
    out.push({ sel, label, ...window.__hit(el), sq44: window.__square(el, 44).ok });
  }
  return out;
};
// 相邻热区：命中区不得与任何另一个可交互控件画在屏幕上的位置相交。
window.__neighbours = () => {
  const targets = window.__sels.map(([s]) => document.querySelector(s)).filter(Boolean);
  const bad = [];
  for (const el of targets) {
    el.scrollIntoView({ block: 'center' });
    const h = window.__hit(el);
    // 中心点落空同样是异常，必须报出来：静默 continue 会让量具坏掉时这条断言变成常绿。
    if (!h || !h.center) {
      bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) + ' 中心点落空，量不出命中区');
      continue;
    }
    const interactive = [...document.querySelectorAll(
      'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    for (const other of interactive) {
      if (other === el || el.contains(other) || other.contains(el)) continue;
      const r = other.getBoundingClientRect();
      if (h.right < r.left || h.left > r.right || h.bottom < r.top || h.top > r.bottom) continue;
      const name = (e) => e.id ? '#' + e.id : e.tagName.toLowerCase() + ':' + (e.textContent || '').trim().slice(0, 8);
      bad.push(name(el) + ' 命中区压住 ' + name(other));
    }
  }
  return bad;
};
// 全页普查：只用于如实报告本轮改了哪些、还剩哪些，不作断言。
// 断言只覆盖上面写死的资源中心 6 个；把普查结果写成断言会让别的轮次一动就红。
window.__survey = () => {
  const out = [];
  const all = [...document.querySelectorAll(
    'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])')];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    el.scrollIntoView({ block: 'center' });
    const h = window.__hit(el);
    // 中心点落空要显式报出来，不能 continue 掉 —— 一个静默跳过会让「量具坏了」
    // 长得和「没有问题」一模一样。
    if (h.center && h.w >= 44 && h.h >= 44) continue;
    const inRes = !!el.closest('#resources');
    out.push({ tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
               text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 14),
               w: h.w, h: h.h, inRes, centerMiss: !h.center });
  }
  return out;
};
true;`;

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== TOUCH TARGETS: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9620 + (process.pid % 90);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-touch-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "about:blank"], { stdio: "ignore" });

// 把本轮 CSS 精确还原回修复前，用于负向控制与「修复前」截图。
// 「精确」这两个字是有代价的：修复前那条规则根本没写 display 和 padding，
// 所以 <button> 用的是 UA 默认的 inline-block + padding:1px 6px，
// <a class="resource-dl"> 用的是 inline + 无内边距。两者必须分开写。
// 我第一版图省事写成 display:inline;padding:0 一把梭，量出来六个都是 52x25 ——
// 比真实的修复前还小，负向控制就变成了在跟一个不存在的状态比。
const REVERT = `(() => {
  if (document.getElementById('tt-revert')) return;
  const st = document.createElement('style');
  st.id = 'tt-revert';
  st.textContent =
    '.resource-row button{display:inline-block!important;min-height:0!important;min-width:0!important;' +
    'padding:1px 6px!important;margin:0!important;white-space:normal!important}' +
    '.resource-dl{display:inline!important;min-height:0!important;min-width:0!important;' +
    'padding:0!important;margin:0!important;white-space:normal!important}';
  document.head.appendChild(st);
})()`;

// --revert：用上面的还原样式跑完整轮，用来产出与修复后同一条代码路径的「修复前」截图。
const REVERT_MODE = process.argv.includes("--revert");

// 截图故意不传 clip：headless 下带 clip 的 Page.captureScreenshot 会挂死等不到帧
// （本机实测 6 个参数组合，3 个不带 clip 的都是 ~120ms 返回，3 个带 clip 的全部超时）。
// 整视口出图，前后对照反而更完整。
async function shot(cdp, name) {
  if (!SHOT_PREFIX) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await cdp.ev(`(() => {
    document.documentElement.style.scrollBehavior = 'auto';   // 平滑滚动会让截图抢在半路
    document.querySelector('.promo-card')?.remove();          // 弹出的招生卡片会盖住资源行
    // 让出 sticky 顶栏的高度，否则第一行资源正好被顶栏盖住，前后对照少一行
    const hdr = document.querySelector('.site-header');
    const gap = (hdr ? hdr.getBoundingClientRect().height : 78) + 12;
    const r = document.querySelector('#resourceList').getBoundingClientRect();
    window.scrollBy(0, r.top - gap);
  })()`);
  await sleep(900);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, 20000);
  const f = path.join(SHOT_DIR, `${SHOT_PREFIX}-${name}.png`);
  fs.writeFileSync(f, Buffer.from(data, "base64"));
  console.log(`   shot -> ${f}`);
}

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
    await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
    await sleep(2400);
    await cdp.ev(PROBE);
    if (REVERT_MODE) await cdp.ev(REVERT);
    console.error(`[${v.tag}] loaded, measuring...${REVERT_MODE ? " (revert mode)" : ""}`);

    const m = await cdp.ev(`window.__measure()`);
    console.error(`[${v.tag}] measured`);
    const small = m.filter((x) => x.missing || !x.center || !x.sq44);
    check(small.length === 0,
      `T-${v.tag} 资源中心 ${m.length} 个入口都放得下一整块 44x44 的落点`,
      small.length ? "不足: " + small.map((x) => `${x.label} 十字量=${x.w}x${x.h} 完整44方块=${x.sq44}`).join("; ")
                   : m.map((x) => `${x.label} ${x.w}x${x.h}`).join("; "));

    const bad = await cdp.ev(`window.__neighbours()`);
    check(bad.length === 0,
      `T-${v.tag}b 放大后的命中区没有压住相邻热区`,
      bad.length ? bad.join("; ") : "与页面上全部可交互元素逐一比对，无相交");

    const doc = await cdp.ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
    check(doc.sw <= doc.cw + 1,
      `T-${v.tag}c 加高命中区没有带来横向溢出`,
      `scrollWidth=${doc.sw} clientWidth=${doc.cw}`);

    if (v.tag === "375") {
      const survey = await cdp.ev(`window.__survey()`);
      console.log(`--- 375px 全页过小控件普查（仅供如实报告，不作断言）---`);
      if (!survey.length) console.log("    无");
      for (const s of survey) {
        console.log(`    ${s.inRes ? "[资源中心]" : "[本轮范围外]"} ${s.tag} "${s.text}" ${s.centerMiss ? "中心点落空(量具异常)" : s.w + "x" + s.h}`);
      }
      console.log(`--- 共 ${survey.length} 个，其中资源中心 ${survey.filter((s) => s.inRes).length} 个 ---`);
    }

    await shot(cdp, v.tag);
    console.error(`[${v.tag}] shot done, keyboard...`);

    // 键盘路径：真实 Tab 走一遍 6 个入口。先把焦点放到第一个入口，再用 Shift+Tab / Tab
    // 退出来重新走进去 —— 这样最后一次交互是键盘，:focus-visible 才会真实反映焦点圈。
    await cdp.ev(`document.querySelector(window.__sels[0][0]).focus()`);
    await cdp.tab(true);
    await cdp.tab(false);
    const kb = [];
    for (let i = 0; i < 6; i++) {
      const st = await cdp.ev(`(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return { label: '(body)', ok: false, why: 'no-focus' };
        const idx = window.__sels.findIndex(([s]) => el.matches(s));
        const cs = getComputedStyle(el);
        const outlined = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const fv = el.matches(':focus-visible');
        const r = el.getBoundingClientRect();
        const vh = document.documentElement.clientHeight, vw = document.documentElement.clientWidth;
        const inView = r.top >= -0.5 && r.bottom <= vh + 0.5 && r.left >= -0.5 && r.right <= vw + 0.5;
        const h = window.__hit(el);
        const sq = window.__square(el, 44);
        // 说不出是谁盖住的，红了也没法修，所以顺手把遮挡者报出来
        const blocker = sq.ok ? '' : ('，遮挡者: ' + (window.__coverers(el).join(' ') || '无（盒子本身不足44）'));
        return { label: idx >= 0 ? window.__sels[idx][1] : ('(' + el.tagName + ')'), idx,
                 ok: idx >= 0 && fv && outlined && inView && sq.ok,
                 hit: h.w + 'x' + h.h,
                 why: [idx >= 0 ? '' : 'not-a-resource-control', fv ? '' : 'not-focus-visible',
                       outlined ? '' : 'no-outline', inView ? '' : 'out-of-view',
                       sq.ok ? '' : ('放不下完整44x44(十字量=' + h.w + 'x' + h.h + ')' + blocker)].filter(Boolean).join(',') };
      })()`);
      kb.push(st);
      if (i < 5) await cdp.tab(false);
    }
    console.error(`[${v.tag}] keyboard done`);
    const order = kb.map((x) => x.idx).join(",");
    const kbBad = kb.filter((x) => !x.ok);
    check(kbBad.length === 0 && order === "0,1,2,3,4,5",
      `T-${v.tag}d 键盘路径：Tab 依 DOM 顺序走完 6 个入口，焦点圈可见、完整在视口内、命中区仍 >= 44`,
      kbBad.length ? kbBad.map((x) => `${x.label}(${x.why})`).join("; ") : `顺序=${order} 命中区=${kb.map((x) => x.hit).join(",")}`);
  }

  // 行为：点在「新扩出来的那一圈」上必须真的触发动作，不能只是视觉上变大。
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  const act = await cdp.ev(`(() => {
    const el = document.querySelector('#resourceList .resource-row:nth-child(4) button');
    el.scrollIntoView({ block: 'center' });
    const h = window.__hit(el);
    // 关键是跟「文字本身占的行盒」比，不是跟现在的边框盒比：
    // 这一轮是把边框盒撑大的，拿撑大后的边框盒当基准，等于拿结果证明结果。
    // Range 量的是文字实际画在哪里，那是修复前用户唯一能点到的地方。
    const rng = document.createRange();
    rng.selectNodeContents(el);
    const text = rng.getBoundingClientRect();
    rng.detach && rng.detach();
    const y = h.bottom - 2;                       // 命中区底部往里 2px
    const outsideText = y > text.bottom + 0.5;    // 这一点在修复前不属于任何可点区域
    const x = Math.round((h.left + h.right) / 2);
    const target = document.elementFromPoint(x, y);
    const hits = !!target && (target === el || el.contains(target));
    if (hits) target.click();
    const modal = document.querySelector('#applicationModal');
    const opened = modal && modal.getAttribute('aria-hidden') === 'false';
    return { outsideText, hits, opened, y: Math.round(y),
             textBottom: Math.round(text.bottom), hitBottom: h.bottom };
  })()`);
  check(act.outsideText && act.hits && act.opened,
    "T1 扩出来的那一圈是真能点的：点文字行盒之外仍打开申请弹窗",
    `点在 y=${act.y}，文字行盒底部在 ${act.textBottom}，命中区底部在 ${act.hitBottom}；在文字外=${act.outsideText} 命中=${act.hits} 弹窗打开=${act.opened}`);

  // 语言鲁棒性：四种语言的按钮文案长度不同。命中区是靠 min-height/min-width 撑的，
  // 不该随文案长短变化；同时最窄的 320px 下换语言也不能把行挤到横向溢出。
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 320, height: 720, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  for (const lang of ["en", "ko", "th"]) {
    await cdp.ev(`(() => {
      const b = [...document.querySelectorAll('[data-lang]')].find(x => x.getAttribute('data-lang') === '${lang}');
      if (b) b.click();
    })()`);
    await sleep(800);
    const ml = await cdp.ev(`window.__measure()`);
    const mSmall = ml.filter((x) => x.missing || !x.center || !x.sq44);
    const mDoc = await cdp.ev(`({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })`);
    check(mSmall.length === 0 && mDoc.sw <= mDoc.cw + 1,
      `T3-${lang} 320px 切到该语言后 6 个入口仍放得下完整 44x44 且无横向溢出`,
      mSmall.length ? "不足: " + mSmall.map((x) => `${x.label} ${x.w}x${x.h} 完整44方块=${x.sq44}`).join("; ")
                    : `最小 ${Math.min(...ml.map((x) => x.w))}x${Math.min(...ml.map((x) => x.h))} scrollWidth=${mDoc.sw}/${mDoc.cw}`);
  }

  // 内容保全：6 个入口的可见文案一字未改。
  // 上面 T3 切过语言，而语言存在 localStorage 里，重新导航不会复位 ——
  // 不显式切回中文，下面两条会拿泰文去比中文，红得莫名其妙。
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  await cdp.ev(`(() => { const b = [...document.querySelectorAll('[data-lang]')]
    .find(x => x.getAttribute('data-lang') === 'zh'); if (b) b.click(); })()`);
  await sleep(800);
  const labels = await cdp.ev(`(() => window.__sels.map(([s]) => (document.querySelector(s)?.textContent || '').trim()))()`);
  const EXPECT = ["下载 ↓", "下载 ↓", "查看 →", "填写 →", "下载 ↓", "上传 ↑"];
  check(JSON.stringify(labels) === JSON.stringify(EXPECT),
    "T2 六个入口的文案一字未改（只改命中区，不改内容）",
    labels.join(" | "));

  // 负向控制：把本轮 CSS 还原回去，六个入口必须精确回到修复前实测的那组数字。
  // 只断言「变小了」是不够的 —— 任何一条把它们改小的样式都能让那种断言变绿。
  // 这里要求逐个等于 375px 下记录的 64x27 / 52x25，才算真的还原到了修复前那一版。
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  await cdp.ev(`(() => { const b = [...document.querySelectorAll('[data-lang]')]
    .find(x => x.getAttribute('data-lang') === 'zh'); if (b) b.click(); })()`);
  await sleep(600);
  await cdp.ev(REVERT);
  await sleep(400);
  const reverted = await cdp.ev(`window.__measure()`);
  const BEFORE = [[64, 27], [64, 27], [64, 27], [64, 27], [52, 25], [64, 27]];
  const mismatch = reverted.map((x, i) =>
    (x.w === BEFORE[i][0] && x.h === BEFORE[i][1]) ? null
      : `${x.label} 量到 ${x.w}x${x.h}，修复前记录是 ${BEFORE[i][0]}x${BEFORE[i][1]}`).filter(Boolean);
  check(mismatch.length === 0,
    "T0 负向控制：还原本轮 CSS 后，六个入口精确回到修复前实测的 64x27 / 52x25",
    mismatch.length ? mismatch.join("; ") : reverted.map((x) => `${x.label} ${x.w}x${x.h}`).join("; "));

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
console.log(`=== TOUCH TARGETS: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
