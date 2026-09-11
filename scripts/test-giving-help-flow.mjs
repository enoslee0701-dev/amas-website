#!/usr/bin/env node
// giving.html 与 help/ 的键盘 · 导航 · 错误恢复回归。
//
// ── 安全前提 ────────────────────────────────────────────────────────
// giving 的表单直接 POST 到写死的 formsubmit.co 邮箱（没有 CONFIG 间接层）。
// 本脚本每次加载后先把 window.fetch 换成「对 formsubmit / supabase 一律失败、
// 其余照旧」的包装，G0 断言包装生效；不生效就不提交。一个字节都不出本机。
// 本脚本也**不触发任何真实付款**：本页本来就没有支付控件，只有联系方式与留言表单。
//
// ── 全程真实输入 ────────────────────────────────────────────────────
// 点击是 Input.dispatchMouseEvent，按键是 Input.dispatchKeyEvent，不用 element.click()。
// 这里还有一个额外理由：navigator.clipboard.writeText 只在文档获得焦点时才会 resolve，
// 而文档焦点要靠真实输入事件才拿得到。用程序化 click 测复制，量到的永远是 NotAllowedError。
//
// ── 这轮复现到的缺口 ────────────────────────────────────────────────
// C1 复制失败完全静默。正常情况（安全上下文 + 文档有焦点）复制是成功的并显示「已复制」；
//    但 writeText 在**非安全上下文（http 部署）、权限被拒、旧浏览器**上会 reject，
//    而原代码是 .catch(()=>{}) —— 按钮文字一动不动，用户无从判断复制上没有。
//    实测：显式让 writeText reject 后，按钮文字与页面上都没有任何变化。
// C2 发送失败的结果提示不过期：失败后改动表单，「发送失败…」仍挂在这一次的输入旁边。
//    与 index.html 第十九轮同类，本页脚本独立，需各自处理。
// C3 四个语言键只有 .active class，没有 aria-pressed，读屏访客听不出当前语言。
//
// 用法: node scripts/test-giving-help-flow.mjs
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
  arrowDown() { return this.key("ArrowDown", "ArrowDown", 40); }
  // 真实鼠标点击，并且**先确认这个坐标真的会打到目标**。
  // 不校验的话，一次点空会表现成「页面没反应」，被误读成页面缺陷 ——
  // 本轮就踩到了：复制按钮那条断言先红了一次，实际是探针点在了别的元素上。
  // 先取中心，被别的元素盖住就在元素内换几个点试；都打不到就返回 false，
  // 让调用方明确知道「这次没点上」，而不是把量具的问题算到页面头上。
  async clickReal(sel) {
    const pt = await this.ev(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      document.documentElement.style.scrollBehavior = 'auto';
      el.scrollIntoView({ block: 'center' });
      const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      const r = el.getBoundingClientRect();
      const cand = [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5]];
      for (const [fx, fy] of cand) {
        const x = Math.round(Math.min(vw - 2, Math.max(1, r.left + r.width * fx)));
        const y = Math.round(Math.min(vh - 2, Math.max(1, r.top + r.height * fy)));
        const t = document.elementFromPoint(x, y);
        if (t && (t === el || el.contains(t) || el.contains(t.parentElement))) return { x, y };
      }
      const t0 = document.elementFromPoint(
        Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return { blockedBy: t0 ? (t0.id || t0.className || t0.tagName) : 'null' };
    })()`);
    if (!pt || pt.blockedBy !== undefined) {
      this.lastClickMiss = pt ? pt.blockedBy : "元素不存在";
      return false;
    }
    await sleep(200);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await sleep(350);
    return true;
  }
}

const WHO = `(() => { const el = document.activeElement;
  if (!el || el === document.body) return '(body)';
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (el.name ? '[' + el.name + ']' : '') +
    (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : ''); })()`;

const NETGATE = `(() => {
  if (window.__gate) return true;
  const orig = window.fetch;
  window.__gateHits = 0;
  window.fetch = function(url){
    const u = String(url || '');
    if (u.indexOf('formsubmit.co') > -1 || u.indexOf('supabase') > -1) {
      window.__gateHits++;
      return Promise.reject(new TypeError('blocked by local test gate'));
    }
    return orig.apply(this, arguments);
  };
  window.__gate = true;
  return window.__gate === true;
})()`;

const FILL = `(() => {
  const set = (n, v) => { const f = document.querySelector('#gvForm [name=' + n + ']'); f.value = v;
    f.dispatchEvent(new Event('input', { bubbles: true })); };
  set('name', '测试访客'); set('contact', 'visitor@example.com'); set('message', '本地验收用留言，不含真实资料。');
})()`;

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== GIVING+HELP FLOW: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9410 + (process.pid % 20);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-gvflow-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

async function loadGiving(cdp) {
  await cdp.send("Page.navigate", { url: `${BASE}/giving.html` });
  await sleep(2300);
  return cdp.ev(NETGATE);
}

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });

  const gate = await loadGiving(cdp);
  check(gate === true, "G0 安全闸：formsubmit / supabase 的请求在页面内被拦下，提交不出本机",
    gate === true ? "window.fetch 已包装（本页表单是写死的 formsubmit.co 邮箱，没有 CONFIG 间接层）"
                  : "包装失败 —— 后面的提交用例不能跑");
  if (gate !== true) throw new Error("safety gate failed");

  // G1 键盘 Tab 顺序：返回 → 语言 → 参与方向 → 联系方式 → 表单 → 政策
  await cdp.ev(`document.body.focus()`);
  const stops = [];
  for (let i = 0; i < 14; i++) { await cdp.tab(); stops.push(await cdp.ev(WHO)); }
  const order = stops.join(" ");
  check(/a\.gv-back/.test(stops[0]) && /button/.test(order) && /\[purpose\]/.test(order) &&
        /\[name\]/.test(order) && /\[contact\]/.test(order) && /summary/.test(order),
    "G1 键盘 Tab 顺序覆盖整条路径：返回官网 → 语言 → 参与方向 → 联系方式 → 表单 → 政策",
    `前 14 站：${stops.slice(0, 8).join(" → ")} …`);

  // G2 参与方向是单选组：方向键切换后，业务变量与视觉选中态都要跟上
  await cdp.ev(`document.querySelector('#purposeOpts input[value=pray]').focus()`);
  await cdp.arrowDown();
  const radio = await cdp.ev(`({
    checked: (document.querySelector('#purposeOpts input:checked') || {}).value || '',
    variable: String(typeof purpose !== 'undefined' ? purpose : ''),
    sel: (() => { const s = document.querySelector('#purposeOpts .opt.sel');
      return s ? s.querySelector('input').value : ''; })() })`);
  check(radio.checked === "student" && radio.variable === "student" && radio.sel === "student",
    "G2 参与方向用方向键切换：选中项、业务变量与视觉选中态三者一致",
    `radio=${radio.checked} purpose=${radio.variable} .sel=${radio.sel}`);

  // G3 复制：真实点击下总要有反馈（成功或失败都算），不能一动不动。
  // 先埋一个标记确认点击真的落在按钮上 —— 否则「文字没变」可能只是探针点空了，
  // 那是量具的问题，不是页面的问题，两者必须分开。
  // 反馈可能要等 clipboard 的 Promise 落定，所以在一个时间窗内采样而不是只读一次。
  // 在干净页面上做：这也正是真人的场景（进页面 → 点复制）。
  // 前面 G1/G2 的 Tab/方向键会把页面滚到别处，把无关的滚动状态带进这条断言，
  // 一次点空就会被误读成页面缺陷 —— 本轮先踩过一次，所以这里显式重新加载。
  await loadGiving(cdp);
  await cdp.ev(`(() => {
    window.__copyClicked = false;
    document.querySelector('[data-copy]').addEventListener('click', () => { window.__copyClicked = true; }, { once: true });
  })()`);
  const orig = await cdp.ev(`document.querySelector('[data-copy]').querySelector('span').textContent`);
  await cdp.clickReal("[data-copy]");
  let after = orig, landed = false;
  for (const w of [0, 250, 400, 600]) {
    if (w) await sleep(w);
    landed = await cdp.ev(`window.__copyClicked === true`);
    after = await cdp.ev(`document.querySelector('[data-copy]').querySelector('span').textContent`);
    if (landed && after !== orig) break;
  }
  check(landed && after !== orig && after.length > 0,
    "G3 复制按钮：真实点击后按钮文字给出反馈（成功或失败都算，就是不能毫无变化）",
    `点击落在按钮上=${landed}${cdp.lastClickMiss ? "（被 " + cdp.lastClickMiss + " 挡住）" : ""}；"${orig}" -> "${after}"`);

  // G4 复制失败路径：clipboard 与 execCommand 都不可用时，必须给出失败提示。
  // 这正是原代码 .catch(()=>{}) 吞掉的那条路 —— 非安全上下文、权限被拒、旧浏览器都会走到。
  await loadGiving(cdp);
  await cdp.ev(`(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    document.execCommand = () => false;
  })()`);
  const orig2 = await cdp.ev(`document.querySelector('[data-copy]').querySelector('span').textContent`);
  await cdp.clickReal("[data-copy]");
  await sleep(400);
  const failText = await cdp.ev(`document.querySelector('[data-copy]').querySelector('span').textContent`);
  check(failText !== orig2 && failText.length > 0,
    "G4 复制两条路都失败时，按钮给出可见的失败提示（不再静默）",
    `"${orig2}" -> "${failText}"`);

  // G5 表单空提交：不发请求，焦点落到第一个未填字段
  await loadGiving(cdp);
  await cdp.clickReal("#gvForm button[type=submit]");
  const empty = await cdp.ev(`({ who: ${WHO}, hits: window.__gateHits,
    status: (document.getElementById('gvStatus').textContent || '').trim() })`);
  check(/\[name\]/.test(empty.who) && empty.hits === 0,
    "G5 表单空提交：不发出任何请求，焦点落到第一个未填字段",
    `焦点=${empty.who} 已拦请求数=${empty.hits} 状态区="${empty.status}"`);

  // G6 发送失败的恢复：有可见文案、内容保留、可重试、提示在视口内
  await cdp.ev(FILL);
  await cdp.clickReal("#gvForm button[type=submit]");
  await sleep(1400);
  const failed = await cdp.ev(`(() => {
    const st = document.getElementById('gvStatus');
    const r = st.getBoundingClientRect();
    return { text: (st.textContent || '').trim(), hits: window.__gateHits,
             kept: document.querySelector('#gvForm [name=name]').value,
             canRetry: !document.querySelector('#gvForm button[type=submit]').disabled,
             inView: r.top >= -0.5 && r.bottom <= document.documentElement.clientHeight + 0.5 };
  })()`);
  check(failed.hits === 1 && failed.text.length > 0 && failed.kept === "测试访客" &&
        failed.canRetry && failed.inView,
    "G6 发送失败：给出可见文案、表单内容保留、可以重试、提示在视口内",
    `拦下=${failed.hits} 文案="${failed.text}" 内容保留="${failed.kept}" 可重试=${failed.canRetry} 可见=${failed.inView}`);

  // G7 结果提示不过期
  const stale = await cdp.ev(`(() => {
    const st = document.getElementById('gvStatus');
    const before = (st.textContent || '').trim();
    const f = document.querySelector('#gvForm [name=name]');
    f.value = f.value + '改'; f.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, after: (st.textContent || '').trim() };
  })()`);
  check(stale.before.length > 0 && stale.after === "",
    "G7 结果提示不过期：一改表单，上一次的发送结果立刻清掉",
    `改动前="${stale.before}" 改动后="${stale.after}"`);

  // G8 语言键：切换后 aria-pressed 只有一个为 true
  await cdp.clickReal(".gv-langs button[data-setlang=en]");
  const langs = await cdp.ev(`[...document.querySelectorAll('.gv-langs button')]
    .map(b => b.dataset.setlang + ':' + (b.getAttribute('aria-pressed') || '(无)'))`);
  check(langs.filter((x) => x.endsWith(":true")).length === 1 && langs.includes("en:true"),
    "G8 语言键有可播报的选中态：切到 EN 后只有它 aria-pressed=true",
    langs.join(" "));

  // G9 政策手风琴键盘可开合
  await cdp.ev(`document.querySelector('.policies summary').focus()`);
  const wasOpen = await cdp.ev(`document.querySelector('.policies details').open`);
  await cdp.key("Enter", "Enter", 13);
  const nowOpen = await cdp.ev(`document.querySelector('.policies details').open`);
  check(wasOpen === false && nowOpen === true,
    "G9 政策手风琴：键盘回车可展开",
    `open ${wasOpen} -> ${nowOpen}`);

  // H1 help：Tab 顺序、手风琴、返回官网
  await cdp.send("Page.navigate", { url: `${BASE}/help/index.html` });
  await sleep(2200);
  await cdp.ev(`document.body.focus()`);
  const h = [];
  for (let i = 0; i < 10; i++) { await cdp.tab(); h.push(await cdp.ev(WHO)); }
  await cdp.ev(`document.querySelectorAll('details')[1].querySelector('summary').focus()`);
  const hBefore = await cdp.ev(`document.querySelectorAll('details')[1].open`);
  await cdp.key("Enter", "Enter", 13);
  const hAfter = await cdp.ev(`document.querySelectorAll('details')[1].open`);
  const back = await cdp.ev(`(() => {
    const a = [...document.querySelectorAll('a')].find(x => /返回官网/.test(x.textContent || ''));
    return a ? { href: a.getAttribute('href'), reachable: true } : { reachable: false }; })()`);
  check(h.filter((x) => /summary/.test(x)).length >= 5 && hBefore === false && hAfter === true &&
        back.reachable && back.href === "../index.html",
    "H1 help：Tab 依次走过各手风琴标题，回车可展开，返回官网链接指向首页",
    `前 10 站里有 ${h.filter((x) => /summary/.test(x)).length} 个手风琴标题；open ${hBefore} -> ${hAfter}；返回官网 href=${back.href}`);

  // G0b 负向控制：把本轮三处改动还原，缺陷必须精确复现
  await loadGiving(cdp);
  await cdp.ev(`(() => {
    // 还原「复制失败静默」：清掉本轮的监听，换回原来的 .catch(()=>{})
    document.querySelectorAll('[data-copy]').forEach(b => {
      const c = b.cloneNode(true);
      b.parentNode.replaceChild(c, b);
      c.addEventListener('click', () => {
        navigator.clipboard.writeText(c.dataset.copy).then(() => {
          c.querySelector('span').textContent = LT('copied');
        }).catch(() => {});
      });
    });
    navigator.clipboard.writeText = () => Promise.reject(new Error('denied'));
    document.execCommand = () => false;
    // 还原「结果提示不过期」：本轮那条 input 监听换不掉，改成每次输入后把文案写回去
    window.__restale = () => { document.getElementById('gvStatus').textContent = '发送失败（还原态）'; };
  })()`);
  const o3 = await cdp.ev(`document.querySelector('[data-copy]').querySelector('span').textContent`);
  await cdp.clickReal("[data-copy]");
  await sleep(400);
  const silent = await cdp.ev(`document.querySelector('[data-copy]').querySelector('span').textContent`);
  check(silent === o3,
    "G0b 负向控制：换回原来的 .catch(()=>{}) 之后，复制失败重新变成毫无反馈",
    `按钮文字保持 "${silent}"（与改前实测一致：一动不动）`);

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
console.log(`=== GIVING+HELP FLOW: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
