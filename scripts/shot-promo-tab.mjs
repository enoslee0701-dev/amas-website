#!/usr/bin/env node
// 招生标签前后对照截图。--revert 用注入还原样式跑同一条代码路径，产出「修复前」。
//
// 截图故意不传 clip：headless 下带 clip 的 Page.captureScreenshot 会挂死等不到帧
// （本机实测不带 clip 的 ~120ms 返回，带 clip 的全部超时）。整视口出图即可。
//
// 用法: node scripts/shot-promo-tab.mjs --shots=<prefix> [--revert]

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shotArg = process.argv.find((a) => a.startsWith("--shots="));
const PREFIX = shotArg ? shotArg.slice("--shots=".length) : "promo";
const REVERT_MODE = process.argv.includes("--revert");
const SHOT_DIR = process.env.SHOT_DIR ||
  "C:/Users/enosl/Documents/Codex/2026-09-11/bang/work/shots";

const CHROME = process.env.CHROME || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));
if (!CHROME) { console.log("FAIL cannot locate Chrome"); process.exit(2); }

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
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
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9900 + (process.pid % 60);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-ptshot-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try {
        const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl;
      } catch { /* not up */ }
      if (!url) await sleep(250);
    }
    if (!url) throw new Error("attach failed");
    const sock = await new Promise((res, rej) => { const s = new WebSocket(url); s.onopen = () => res(s); s.onerror = rej; });
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
  send(method, params = {}, ms = 25000) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      const t = setTimeout(() => { if (this.pending.delete(i)) rej(new Error("CDP timeout " + method)); }, ms);
      this.pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval threw: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  }
}

const REVERT = `(() => {
  const st = document.createElement('style');
  st.textContent = '@media(max-width:580px){.promo-tab{top:46%!important;bottom:auto!important;' +
    'left:auto!important;right:0!important;writing-mode:vertical-rl!important;height:auto!important;' +
    'padding:13px 9px 13px 8px!important;border-radius:12px 0 0 12px!important;max-width:none!important}}';
  document.head.appendChild(st);
})()`;

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  for (const v of [{ w: 320, h: 720, mobile: true }, { w: 375, h: 780, mobile: true },
                   { w: 1280, h: 900, mobile: false }]) {
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: v.w, height: v.h, deviceScaleFactor: 1, mobile: v.mobile });
    await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
    await sleep(2400);
    if (REVERT_MODE) { await cdp.ev(REVERT); await sleep(400); }
    // 停在资源中心那一屏：这正是标签把行内按钮切掉的地方。
    // 先滚，再关卡片 —— 顺序不能反：滚过首屏 60% 会触发招生卡片自动弹出，
    // 先关后滚的话卡片会在截图前又冒出来，把要对照的标签整个盖住
    // （第一版就是这样，拍出来的「修复前」里根本看不见那根竖条）。
    await cdp.ev(`(() => {
      document.documentElement.style.scrollBehavior = 'auto';
      const hdr = document.querySelector('.site-header');
      const gap = (hdr ? hdr.getBoundingClientRect().height : 78) + 12;
      const r = document.querySelector('#resourceList').getBoundingClientRect();
      window.scrollBy(0, r.top - gap);
    })()`);
    await sleep(600);
    await cdp.ev(`document.querySelector('#promoCard') && (document.querySelector('#promoCard').hidden = true)`);
    await sleep(500);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, 20000);
    const f = path.join(SHOT_DIR, `${PREFIX}-${v.w}.png`);
    fs.writeFileSync(f, Buffer.from(data, "base64"));
    console.log(`shot -> ${f}`);
  }
  cdp.ws.close();
} finally {
  chrome.kill();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}
