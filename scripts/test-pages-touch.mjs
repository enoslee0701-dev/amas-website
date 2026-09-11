#!/usr/bin/env node
// 全部公开访客页面的触控目标守门：giving / help / discover / login / register /
// forgot-password，外加 index 复核。
//
// 为什么需要它：前几轮把 index.html 收拾干净了，但同一批缺陷在其余页面照样存在 ——
// 首轮实测这六个页面上有 29 个过小可达控件，包括登录页的「忘记密码？」、注册页的
// 「登录」（该页唯一的出口）、奉献页的四个语言键与三个手风琴标题。
// 只盯首页会让「已经修好了」这句话在六个页面上不成立。
//
// 判据用仓库共享量具 scripts/lib/touch-probe.mjs，与 index 那几份完全一致。
//
// 白名单只有两类：句子中的行内链接（WCAG 2.5.8 的 inline 例外，把 44px 的盒子塞进
// 句子会破坏段落行距），以及首页公告条那两处（理由见进度文档 §90 与 §105）。
// 行内的判定方式是「祖先里有 p 或 li」，不是按 class 猜 —— class 会改名，语义不会。
//
// 用法: node scripts/test-pages-touch.mjs
// Chrome 路径可用环境变量 CHROME 覆盖；找不到时以非零退出，不静默跳过。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { TOUCH_PROBE } from "./lib/touch-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (cond, name, detail) => results.push([!!cond, name, detail]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".json": "application/json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  const abs = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "pagesurvey-"));
const port = 9580 + (process.pid % 40);
const chrome = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
   "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "about:blank"],
  { stdio: "ignore" });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
      if (!url) await sleep(250);
    }
    const sock = await new Promise((res, rej) => { const s = new WebSocket(url); s.onopen = () => res(s); s.onerror = rej; });
    const c = new Cdp(sock);
    sock.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); } };
    return c;
  }
  send(method, params = {}, ms = 30000) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      const t = setTimeout(() => { if (this.pending.delete(i)) rej(new Error("TIMEOUT " + method)); }, ms);
      this.pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async ev(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval threw: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  }
}

const SURVEY = TOUCH_PROBE + `
window.__reachable = (el) => {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' ||
        cs.pointerEvents === 'none' || parseFloat(cs.opacity || '1') < 0.01) return false;
    if (n.hasAttribute && n.hasAttribute('hidden')) return false;
  }
  return true;
};
window.__pageSurvey = () => {
  const out = [];
  for (const el of document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary')) {
    if (!window.__reachable(el)) continue;
    const r0 = el.getBoundingClientRect();
    if (r0.width === 0 && r0.height === 0) continue;
    el.scrollIntoView({ block: 'center' });
    const t = window.__target(el, 44);
    if (t.ok) continue;
    const inSentence = !!el.closest('p, li');   // 句子里的行内链接（WCAG 2.5.8 行内例外）
    out.push({
      tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id :
        (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : '')),
      text: (el.textContent || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
        .trim().replace(/\\s+/g, ' ').slice(0, 16),
      w: t.w, h: t.h, why: t.why, inSentence
    });
  }
  return out;
};
true;`;

const PAGES = ["/index.html", "/giving.html", "/help/index.html", "/discover.html",
               "/login/index.html", "/register/index.html", "/forgot-password/index.html"];

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  for (const page of PAGES) {
    await cdp.send("Page.navigate", { url: BASE + page });
    await sleep(2600);
    let rows;
    try { await cdp.ev(SURVEY); rows = await cdp.ev(`window.__pageSurvey()`); }
    catch (e) { console.log(`\n=== ${page}  探测失败: ${e.message}`); continue; }
    const title = await cdp.ev(`document.title`);
    const allowed = rows.filter((r) => r.inSentence || /announce/i.test(r.tag));
    const unlisted = rows.filter((r) => !r.inSentence && !/announce/i.test(r.tag));
    check(unlisted.length === 0 && title.length > 0,
      `P ${page} 白名单之外没有过小的可达控件`,
      unlisted.length
        ? "未处理: " + unlisted.map((r) => `${r.tag} "${r.text}" ${r.w}x${r.h}`).join("; ")
        : `"${title}" 扫到 ${rows.length} 个过小控件，全部属行内例外或公告条：` +
          (allowed.map((r) => `${r.tag} "${r.text}" ${r.w}x${r.h}`).join("; ") || "无"));
  }
  cdp.ws.close();
} finally {
  chrome.kill();
  server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* best effort */ }
}

let passed = 0;
for (const [good, name, detail] of results) {
  console.log(`${good ? "PASS" : "FAIL"} ${name} | ${detail}`);
  if (good) passed++;
}
console.log("");
console.log(`=== PAGES TOUCH: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
