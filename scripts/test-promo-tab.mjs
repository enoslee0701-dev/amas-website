#!/usr/bin/env node
// 招生侧边标签 .promo-tab 的遮挡回归。
//
// 起因：它在桌面上 40px 宽、正好落在 44px 的页面外边距里，与内容列重叠 0px ——
// 那是它本来的设计。手机上外边距只剩 14px 而它仍有 34px 宽，于是啃进内容列 20px，
// 在视口中部切出一条 166px 高的竖带；资源行的右对齐按钮滚进这条带子时右侧被吃掉
// 28px，放不下完整的 44x44 落点。
//
// 判据的选择需要先承认一件事：「零遮挡」对任何常驻浮动控件都是不可达的。
// 手机上内容是整宽一列，任何不透明的 position:fixed 元素滚过去都会压住点什么 ——
// 站点原本就有的客服圆钮同样如此（首轮全页扫描里它压住了「上传 ↑」，与本轮改动无关）。
// 拿一个不可达的目标当断言，只会逼人去调量具而不是调页面。
//
// 所以判的是**遮挡发生在哪里**：页面本来就为浮动控件留了底部一条带（由既有客服圆钮
// 的上缘界定），招生入口只许在这条带里造成遮挡；条带以上的阅读区不得有任何控件被它
// 压到放不下 44x44。原来那根中部竖条正踩在阅读区正中央，负向控制因此会变红。
// 条带内的遮挡照实打印出来，不判红也不假装没有。
//
// 位置只是手段，换一种排布只要能过这条断言都算合格；
// 反过来，只断言坐标的测试会在下次微调时假红、在真出问题时假绿。
//
// 单个控件是否合格由共享量具 scripts/lib/touch-probe.mjs 的 __target 判：
// 外接盒 >= 44x44，且它自己形状内的点没被别的元素压住（被压了才追问可达区域里
// 是否仍放得下完整 44x44）。这样圆角与圆形控件不会被冤枉 —— 本页的招生胶囊正是
// border-radius:999px，换个更短的译文就会短到只剩圆角。
//
// 用法: node scripts/test-promo-tab.mjs
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
  async key(key, code, vk) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(140);
  }
  tab(shift = false) {
    return (async () => {
      const base = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
                     modifiers: shift ? 8 : 0 };
      await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(90);
    })();
  }
}

// 量具来自 scripts/lib/touch-probe.mjs，三份回归脚本共用同一份，避免判据分叉。
const PROBE = TOUCH_PROBE + `
// 这一屏里被 .promo-tab 压到放不下 44x44 的可交互控件。
// 归因方式是「把标签藏起来再量一次」：只有藏起来之后变得放得下的，才算标签的责任。
// 光看「谁在最上层」会把顶栏、客服圆钮、招生卡片的账也算到标签头上。
window.__blamedOnTab = () => {
  const tab = document.querySelector('.promo-tab');
  if (!tab) return { tabVisible: false, blamed: [] };
  // 标签自己不可见时，「没有遮挡」什么也证明不了。必须把这件事报回去，
  // 否则一条把标签藏起来的规则会让这项检查永远绿 —— 本轮就踩过：
  // 招生卡片在扫描途中自动弹出，:has() 规则把胶囊收起，负向控制当场失去灵敏度。
  const cs = getComputedStyle(tab);
  const tabVisible = cs.display !== 'none' && cs.visibility !== 'hidden' &&
                     parseFloat(cs.opacity || '1') > 0.01;
  if (!tabVisible) return { tabVisible: false, blamed: [] };
  const vh = document.documentElement.clientHeight;
  const out = [];
  const all = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary')];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.top < 0 || r.bottom > vh) continue;              // 只算完整露出这一屏的
    if (el === tab || tab.contains(el)) continue;
    if (r.width + 1e-6 < 44 || r.height + 1e-6 < 44) continue;  // 盒子本身就不足 44，属于另一类问题
    if (getComputedStyle(el).visibility === 'hidden') continue;
    if (window.__target(el, 44).ok) continue;              // 现在就合格，无事
    const prev = tab.style.visibility;
    tab.style.visibility = 'hidden';
    const freed = window.__target(el, 44).ok;
    tab.style.visibility = prev;
    if (!freed) continue;                                  // 藏了标签也还是放不下 -> 不是标签的责任
    // 底部浮动条带：由既有客服圆钮的上缘界定，那是页面本来就让给浮动控件的地方。
    // 落在条带里的遮挡是允许的（圆钮本来就这样），落在条带以上的阅读区里才是缺陷。
    const fab = document.querySelector('.chat-fab');
    const stripTop = fab ? fab.getBoundingClientRect().top : vh;
    const inStrip = r.bottom > stripTop - 0.5;
    out.push({ inStrip, top: Math.round(r.top), stripTop: Math.round(stripTop), name:
             (el.id ? '#' + el.id : el.tagName.toLowerCase()) + ' "' +
             (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 14) + '"' });
  }
  return { tabVisible: true, blamed: out };
};
window.__tabState = () => {
  const tab = document.querySelector('.promo-tab');
  const shell = document.querySelector('.shell');
  const r = tab.getBoundingClientRect(), sr = shell.getBoundingClientRect();
  const cs = getComputedStyle(tab);
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  return {
    w: Math.round(r.width), h: Math.round(r.height),
    left: Math.round(r.left), right: Math.round(r.right),
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    inViewport: r.left >= -0.5 && r.right <= vw + 0.5 && r.top >= -0.5 && r.bottom <= vh + 0.5,
    visible: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.01,
    sq44: window.__target(tab, 44).ok,
    verticalFootprint: Math.round(r.height),
    text: (tab.textContent || '').trim().replace(/\\s+/g, ' '),
    ariaLabel: tab.getAttribute('aria-label') || ''
  };
};
true;`;

// 负向控制：把手机端这条规则还原回「中部右侧竖条」。
const REVERT = `(() => {
  if (document.getElementById('pt-revert')) return;
  const st = document.createElement('style');
  st.id = 'pt-revert';
  st.textContent = '@media(max-width:580px){.promo-tab{top:46%!important;bottom:auto!important;' +
    'left:auto!important;right:0!important;writing-mode:vertical-rl!important;height:auto!important;' +
    'padding:13px 9px 13px 8px!important;border-radius:12px 0 0 12px!important;max-width:none!important}}';
  document.head.appendChild(st);
})()`;

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== PROMO TAB: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9820 + (process.pid % 70);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-promotab-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

// 滚动全程扫一遍，返回被标签压住的控件（去重）
async function sweep(cdp, vh) {
  const total = await cdp.ev(`document.documentElement.scrollHeight`);
  const found = new Map();
  let visibleSteps = 0, steps = 0;
  for (let y = 0; y < total - vh; y += Math.round(vh * 0.7)) {
    await cdp.ev(`window.scrollTo(0, ${y})`);
    // 滚过首屏 60% 会触发招生卡片自动弹出，而卡片展开时胶囊按设计收起 ——
    // 那样扫出来的「无遮挡」是假的。每一步都把卡片关掉，让胶囊保持在场。
    await cdp.ev(`document.querySelector('#promoCard') && (document.querySelector('#promoCard').hidden = true)`);
    await sleep(160);
    const r = await cdp.ev(`window.__blamedOnTab()`);
    steps++;
    if (r.tabVisible) visibleSteps++;
    for (const h of r.blamed) if (!found.has(h.name)) found.set(h.name, { ...h, y });
  }
  await cdp.ev(`window.scrollTo(0, 0)`);
  const all = [...found.values()];
  return {
    // 阅读区里的遮挡 —— 这才是要为零的那一类
    inReadingZone: all.filter((h) => !h.inStrip)
      .map((h) => `${h.name}@scrollY=${h.y}(控件顶=${h.top} 条带上缘=${h.stripTop})`),
    // 底部浮动条带内的遮挡 —— 允许，但要如实报出来，不能假装没有
    inStrip: all.filter((h) => h.inStrip).map((h) => `${h.name}@scrollY=${h.y}`),
    visibleSteps, steps };
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

    // 卡片展开时，手机上的胶囊按设计被收起（见 main.css 的 :has 规则）。
    // 量「入口是否可发现」必须在卡片关闭的状态下量，那才是胶囊该出现的场景。
    await cdp.ev(`document.querySelector('#promoCard').hidden = true`);
    await sleep(200);
    const st = await cdp.ev(`window.__tabState()`);

    // P1 可发现性：标签仍然可见、完整在视口内、自己也够 44x44
    check(st.visible && st.inViewport && st.sq44,
      `P-${v.tag} 招生入口仍可见、完整在视口内、自身放得下 44x44`,
      `${st.w}x${st.h} @ ${st.left}..${st.right} / ${st.top}..${st.bottom} 可见=${st.visible} 在视口内=${st.inViewport}`);

    // 核心断言：阅读区（底部浮动条带以上）不得有控件被招生入口压到放不下 44x44。
    // 条带内的遮挡照实报出来但不判红 —— 见文件头对判据的说明。
    const sw = await sweep(cdp, v.h);
    check(sw.inReadingZone.length === 0 && sw.visibleSteps > 0,
      `P-${v.tag}b 滚动全程：阅读区（底部浮动条带以上）无控件被招生入口压到放不下 44x44`,
      sw.inReadingZone.length ? "阅读区被压住: " + sw.inReadingZone.join("; ")
        : `逐屏扫描 ${sw.steps} 屏、标签在场 ${sw.visibleSteps} 屏；阅读区 0 处，` +
          `底部浮动条带内 ${sw.inStrip.length} 处（允许，与既有客服圆钮同一条带）：${sw.inStrip.join("; ") || "无"}`);

    // P3 竖向占位：手机上它不该再横跨视口中部
    if (v.mobile) {
      // 结构断言：胶囊整体必须落在既有的底部浮动条带内，不许自己另开一条遮挡带。
      // 少了这条，上面那条「阅读区为零」可以靠把条带定义得很宽来蒙混过去。
      const strip = await cdp.ev(`(() => {
        const fab = document.querySelector('.chat-fab'), tab = document.querySelector('.promo-tab');
        const f = fab.getBoundingClientRect(), t = tab.getBoundingClientRect();
        return { fabTop: Math.round(f.top), tabTop: Math.round(t.top), inside: t.top >= f.top - 0.5 };
      })()`);
      check(strip.inside,
        `P-${v.tag}d 胶囊整体落在页面既有的底部浮动条带内（不自己开辟新的遮挡带）`,
        `胶囊上缘=${strip.tabTop} 条带上缘(客服圆钮)=${strip.fabTop}`);
      check(st.verticalFootprint <= 60,
        `P-${v.tag}c 手机上招生标签的竖向占位收进底部浮动区`,
        `高度=${st.verticalFootprint}px（改前是 166px 的竖带）`);
    } else {
      // 页面里有多个 .shell（公告条里那个宽度不同），基准必须取正文那一列，
      // 否则这条断言比的是另一个盒子，红绿都没有意义。
      const shellRight = await cdp.ev(`Math.round(
        document.querySelector('#resourceList').closest('.shell').getBoundingClientRect().right)`);
      check(st.left >= shellRight - 0.5,
        `P-${v.tag}c 桌面维持原设计：标签整体落在内容列之外的页面外边距里`,
        `标签左缘=${st.left} 内容列右缘=${shellRight}`);
    }
  }

  // 行为：点击仍能打开招生卡片，再点一次收起
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  const toggle = await cdp.ev(`(async () => {
    const tab = document.querySelector('.promo-tab'), card = document.querySelector('#promoCard');
    card.hidden = true;
    const r = tab.getBoundingClientRect();
    // 从标签的正中心点下去，量的是真实命中而不是直接调 click()
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const ownsCenter = !!hit && (hit === tab || tab.contains(hit));
    hit && hit.click();
    await new Promise(r2 => setTimeout(r2, 260));
    const opened = !card.hidden;
    tab.click();
    await new Promise(r2 => setTimeout(r2, 420));
    const closed = card.hidden;
    return { ownsCenter, opened, closed };
  })()`);
  check(toggle.ownsCenter && toggle.opened && toggle.closed,
    "P1 点击行为未变：点标签中心打开招生卡片，再点一次收起",
    `中心命中=${toggle.ownsCenter} 打开=${toggle.opened} 收起=${toggle.closed}`);

  // 键盘：可聚焦、焦点圈可见、Enter 能打开卡片
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  // 招生卡片会在 8 秒后、或滚过首屏 60% 时自动弹出。Shift+Tab 会把焦点移到上一个控件，
  // 而那会带着页面滚动 —— 于是卡片在 Tab 过程中弹出来，胶囊按设计被收起，
  // 「聚焦不上」看起来像键盘缺陷，其实是用例自己把卡片招出来了。
  // 这里先把当天的已关闭状态写进 localStorage 再重载，让页面停在「卡片已关」这一态，
  // 那正是胶囊该被键盘访客用到的场景。
  await cdp.ev(`localStorage.setItem('amas-promo-dismissed', new Date().toISOString().slice(0,10))`);
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  await cdp.ev(`document.querySelector('.promo-tab').focus();`);
  await sleep(200);
  await cdp.tab(true);
  await cdp.tab(false);
  const kb = await cdp.ev(`(() => {
    const tab = document.querySelector('.promo-tab');
    const focused = document.activeElement === tab;
    const cs = getComputedStyle(tab);
    return { focused, fv: tab.matches(':focus-visible'),
             outlined: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
             sq: window.__target(tab, 44).ok };
  })()`);
  await cdp.key("Enter", "Enter", 13);
  const kbOpened = await cdp.ev(`!document.querySelector('#promoCard').hidden`);
  check(kb.focused && kb.fv && kb.outlined && kb.sq && kbOpened,
    "P2 键盘路径：胶囊可 Tab 聚焦、焦点圈可见、命中区 >= 44x44，Enter 打开招生卡片",
    `聚焦=${kb.focused} focus-visible=${kb.fv} 焦点圈=${kb.outlined} 44方块=${kb.sq} Enter打开=${kbOpened}`);

  // 焦点交接：卡片展开后胶囊被收起，焦点不能留在一个看不见的控件上；
  // 关掉卡片之后焦点要回到胶囊。没有这条，上面那条 Enter 断言会掩盖一个新的焦点黑洞。
  const handover = await cdp.ev(`(() => {
    const tab = document.querySelector('.promo-tab');
    const cs = getComputedStyle(tab);
    return { tabHiddenNow: cs.visibility === 'hidden',
             focusMoved: document.activeElement === document.querySelector('#promoClose'),
             focusVisibleSomewhere: document.activeElement !== document.body };
  })()`);
  check(handover.tabHiddenNow && handover.focusMoved,
    "P2b 卡片展开后胶囊按设计收起，焦点同步交给卡片的关闭键（不留看不见的焦点）",
    `胶囊已收起=${handover.tabHiddenNow} 焦点在关闭键=${handover.focusMoved} 焦点未丢给body=${handover.focusVisibleSomewhere}`);

  await cdp.key("Enter", "Enter", 13);   // 在关闭键上回车，收起卡片
  await sleep(700);
  const back = await cdp.ev(`(() => {
    const tab = document.querySelector('.promo-tab');
    return { cardClosed: document.querySelector('#promoCard').hidden,
             tabVisible: getComputedStyle(tab).visibility !== 'hidden',
             focusBack: document.activeElement === tab };
  })()`);
  check(back.cardClosed && back.tabVisible && back.focusBack,
    "P2c 关掉卡片后胶囊重新出现，焦点交回胶囊",
    `卡片已关=${back.cardClosed} 胶囊可见=${back.tabVisible} 焦点回到胶囊=${back.focusBack}`);

  // 语言鲁棒性：四种语言的标签长度不同，横向胶囊的宽度跟着文案走。
  // 最窄的 320px 下不能越出视口，也不能撞上右下角的客服圆钮 —— 那是这次改动
  // 从竖条换成横条之后新引入的风险，必须自己盯住。
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
    await cdp.ev(`document.querySelector('#promoCard').hidden = true`);
    await sleep(700);
    const ml = await cdp.ev(`(() => {
      const tab = document.querySelector('.promo-tab'), fab = document.querySelector('.chat-fab');
      const r = tab.getBoundingClientRect(), f = fab.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const overlapFab = !(r.right < f.left || r.left > f.right || r.bottom < f.top || r.top > f.bottom);
      return { w: Math.round(r.width), h: Math.round(r.height),
               left: Math.round(r.left), right: Math.round(r.right),
               inViewport: r.left >= -0.5 && r.right <= vw + 0.5,
               overlapFab, sq: window.__target(tab, 44).ok,
               docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
               text: (tab.textContent || '').trim().replace(/\s+/g, ' ') };
    })()`);
    check(ml.inViewport && !ml.overlapFab && ml.sq && !ml.docOverflow,
      `P4-${lang} 320px 切到该语言后胶囊仍在视口内、不压客服圆钮、自身 >= 44x44、不撑宽文档`,
      `${ml.w}x${ml.h} @ ${ml.left}..${ml.right} 在视口内=${ml.inViewport} 压圆钮=${ml.overlapFab} 44方块=${ml.sq} 横向溢出=${ml.docOverflow} 文案="${ml.text}"`);
  }
  // 切回中文再做文案断言，语言存在 localStorage 里，重新导航不会复位
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  await cdp.ev(`(() => { const b = [...document.querySelectorAll('[data-lang]')]
    .find(x => x.getAttribute('data-lang') === 'zh'); if (b) b.click(); })()`);
  await sleep(700);

  // 文案保全：一个字都没动
  await cdp.ev(`document.querySelector('#promoCard').hidden = true`);
  const text = await cdp.ev(`(() => { const t = document.querySelector('.promo-tab');
    return { text: (t.textContent || '').trim().replace(/\\s+/g, ' '), aria: t.getAttribute('aria-label') || '' }; })()`);
  check(text.text === "2026 届招生进行中" && text.aria === "2026 届招生咨询",
    "P3 标签文案与无障碍名称一字未改（只改位置、朝向、尺寸）",
    `文案="${text.text}" aria-label="${text.aria}"`);

  // 负向控制：把手机端规则还原成中部右侧竖条，遮挡必须回来
  await cdp.ev(`localStorage.removeItem('amas-promo-dismissed')`);
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  await cdp.ev(PROBE);
  await cdp.ev(REVERT);
  await sleep(400);
  const backAgain = await sweep(cdp, 780);
  check(backAgain.inReadingZone.length > 0 && backAgain.visibleSteps > 0,
    "P0 负向控制：还原成中部右侧竖条后，阅读区里的遮挡精确复现（否则上面的断言是空的）",
    backAgain.inReadingZone.length
      ? `${backAgain.inReadingZone.join("; ")}（标签在场 ${backAgain.visibleSteps}/${backAgain.steps} 屏）`
      : `还原后阅读区仍然没有遮挡（标签在场 ${backAgain.visibleSteps}/${backAgain.steps} 屏）`);

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
console.log(`=== PROMO TAB: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
