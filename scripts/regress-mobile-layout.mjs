#!/usr/bin/env node
// 手机端（360 / 390 宽）首页版面回归：标题单行、编号与图标同行、课程卡图在上且标签横排。
// 用法: node scripts/regress-mobile-layout.mjs [--shots]   截图落在 SHOT_DIR（默认系统临时目录/amas-shots）
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnChrome } from "./lib/chrome-launcher.mjs";
import { refuseLocalConfig } from "./lib/no-local-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.argv.includes("--shots");
const SHOT_DIR = process.env.SHOT_DIR || path.join(os.tmpdir(), "amas-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".woff2": "font/woff2", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (refuseLocalConfig(p, res)) return;
  if (p.endsWith("/")) p += "index.html";
  const abs = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const { chrome, port, profileDir } = await launchOwnChrome({ profilePrefix: "amas-mlayout-", extraArgs: ["--disable-gpu", "--hide-scrollbars"] });

let ws, seq = 0; const pending = new Map();
for (let i = 0; i < 80 && !ws; i++) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const u = j.find((x) => x.type === "page")?.webSocketDebuggerUrl;
    if (u) ws = await new Promise((ok, no) => { const s = new WebSocket(u); s.onopen = () => ok(s); s.onerror = no; });
  } catch {}
  if (!ws) await sleep(250);
}
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

let fails = 0;
const check = (name, ok, detail) => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"} ${name} | ${detail}`); };

try {
  await send("Page.enable");
  for (const W of [360, 390]) {
  await send("Emulation.setDeviceMetricsOverride", { width: W, height: 800, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2500);
  await evalJs(`document.querySelectorAll('.reveal').forEach(e=>e.classList.add('in','visible','show'));document.fonts.ready.then(()=>1)`);

  const r = await evalJs(`(() => {
    const lines = (el) => { const cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3;
      return Math.round(el.getBoundingClientRect().height / lh); };
    const box = (el) => el.getBoundingClientRect();
    const sameRow = (a, b) => { const A = box(a), B = box(b); return Math.abs((A.top + A.bottom) / 2 - (B.top + B.bottom) / 2) < Math.max(A.height, B.height) / 2; };
    const about = document.querySelector('.about-copy h2');
    const life = document.querySelector('.life-section .section-head h2');
    const mi = [...document.querySelectorAll('.mission-item')].map(m => sameRow(m.querySelector(':scope>span:not(.icon-chip)'), m.querySelector('.icon-chip')));
    const lb = [...document.querySelectorAll('.life-block')].map(b => sameRow(b.querySelector('.life-num'), b.querySelector('.icon-chip')));
    const cards = [...document.querySelectorAll('.course-card')].filter(c => getComputedStyle(c).display !== 'none').slice(0, 6);
    const cardInfo = cards.map(c => {
      const t = box(c.querySelector('.course-thumb')), h = box(c.querySelector('h3'));
      const spans = [...c.querySelectorAll('.course-meta span')].map(box);
      const vertical = [...c.querySelectorAll('.course-meta span, h3')].some(e => { const b = box(e); return b.height > b.width * 1.2; });
      return { titleBelow: h.top >= t.bottom - 1, spansOneRow: spans.every(s => Math.abs(s.top - spans[0].top) < 2), vertical };
    });
    return { aboutFirstLine: (() => { const range = document.createRange(); range.setStart(about.firstChild, 0); range.setEnd(about.firstChild, about.firstChild.length);
                 return range.getClientRects().length; })(),
      lifeLines: lines(life), mi, lb, cardInfo, scrollW: document.documentElement.scrollWidth };
  })()`);

  check(`${W}px about 标题首行「AMAS 亚洲宣教神学院」不折行`, r.aboutFirstLine === 1, `rects=${r.aboutFirstLine}`);
  check(`${W}px life 标题「学习不是孤立发生的。」单行`, r.lifeLines === 1, `lines=${r.lifeLines}`);
  check(`${W}px 使命四项：编号与图标同一行`, r.mi.length === 4 && r.mi.every(Boolean), JSON.stringify(r.mi));
  check(`${W}px 学院生活：编号与图标同一行`, r.lb.length >= 4 && r.lb.every(Boolean), JSON.stringify(r.lb));
  check(`${W}px 课程卡：课名在图片下方`, r.cardInfo.length > 0 && r.cardInfo.every(c => c.titleBelow), JSON.stringify(r.cardInfo.map(c => c.titleBelow)));
  check(`${W}px 课程卡：标签同一行横排`, r.cardInfo.every(c => c.spansOneRow), JSON.stringify(r.cardInfo.map(c => c.spansOneRow)));
  check(`${W}px 课程卡：课名与标签无竖排`, r.cardInfo.every(c => !c.vertical), JSON.stringify(r.cardInfo.map(c => c.vertical)));
  check(`${W}px 页面无横向滚动`, r.scrollW <= W, `scrollWidth=${r.scrollW}`);

  /* 已开课 + 仍在招生：四种语言下首屏状态栏不溢出，招生区不再出现「咨询下一批次」 */
  for (const lang of ["zh", "en", "ko", "th"]) {
    const s = await evalJs(`(() => { applyLanguage(${JSON.stringify(lang)}); refreshCountdown();
      const items = [...document.querySelectorAll('.hero-meta-item')];
      const over = items.filter(i => i.scrollWidth > i.clientWidth + 1 || i.getBoundingClientRect().right > innerWidth).length;
      return { over, cd: document.getElementById('admCountdown').textContent, sw: document.documentElement.scrollWidth }; })()`);
    check(`${W}px [${lang}] 首屏状态栏不溢出、无横向滚动`, s.over === 0 && s.sw <= W, `overflowItems=${s.over} scrollWidth=${s.sw}`);
    check(`${W}px [${lang}] 招生状态写「已开课且仍在招生」`, !/下一批次|next intake|다음 기수|รุ่นถัดไป/.test(s.cd) && s.cd.length > 0, s.cd);
  }
  await evalJs(`applyLanguage("zh")`);

  if (SHOTS && W === 360) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    for (const [name, sel] of [["hero", ".hero-meta"], ["admissions", "#admCountdown"], ["about", ".about-copy"], ["mission", ".mission-item"], ["courses", "#courseGrid"], ["life-head", ".life-section .section-head"], ["life", ".life-block"]]) {
      await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); window.scrollTo({ top: e.getBoundingClientRect().top + scrollY - 90, behavior: "instant" }); })()`);
      await sleep(400);
      const s = await send("Page.captureScreenshot", { format: "png" });
      const f = path.join(SHOT_DIR, `mobile-${name}.png`);
      fs.writeFileSync(f, Buffer.from(s.result.data, "base64"));
      console.log(`shot ${f}`);
    }
  }
  }
} finally {
  try { ws.close(); } catch {}
  chrome.kill();
  server.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
console.log(fails ? `MOBILE LAYOUT: ${fails} FAIL` : "MOBILE LAYOUT: ALL PASS");
process.exit(fails ? 1 : 0);
