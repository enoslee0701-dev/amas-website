#!/usr/bin/env node
// 模拟中国大陆连不上 Google：fonts.googleapis.com / fonts.gstatic.com 的请求一直挂着不回。
// 量首页与奉献页的「首次内容绘制」（FCP），要求在 3 秒内出字 —— 字体表不得阻塞首屏。
// 另做静态检查：这两页不得有指向外站、且未设 media="print" 的阻塞式样式表。
// 运行：node scripts/test-blocked-fonts.mjs   不联网（外站请求一律挂起或拦截）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnChrome } from "./lib/chrome-launcher.mjs";
import { refuseLocalConfig } from "./lib/no-local-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGES = ["index.html", "giving.html"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fails = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); } else { fails++; console.log("  FAIL  " + n + (d ? "  ← " + d : "")); } };

// ---------- 静态 ----------
for (const page of PAGES) {
  const p = page;
  const html = fs.readFileSync(path.join(ROOT, page), "utf8");
  const blocking = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/gi)].map((m) => m[0])
    .filter((t) => /href="https?:\/\//.test(t) && !/media="print"/.test(t));
  const outsideNoscript = blocking.filter((t) => !html.includes("<noscript>" + t));
  ok(`S ${p} 没有阻塞首屏的外站样式表`, outsideNoscript.length === 0, outsideNoscript.join(" "));
}

// ---------- 动态 ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json" };
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
const { chrome, port, profileDir } = await launchOwnChrome({ profilePrefix: "amas-fonts-", extraArgs: ["--disable-gpu"] });
let ws, seq = 0; const pending = new Map(), handlers = new Map();
for (let i = 0; i < 80 && !ws; i++) {
  try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const u = j.find((x) => x.type === "page")?.webSocketDebuggerUrl;
    if (u) ws = await new Promise((a, b) => { const s = new WebSocket(u); s.onopen = () => a(s); s.onerror = b; }); } catch {}
  if (!ws) await sleep(250);
}
ws.onmessage = (e) => { const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method && handlers.has(m.method)) handlers.get(m.method)(m.params); };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (x) => (await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true })).result?.result?.value;

try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  handlers.set("Fetch.requestPaused", async (p) => {
    const u = p.request.url;
    if (u.startsWith(BASE)) return void send("Fetch.continueRequest", { requestId: p.requestId });
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return;          // 挂起：模拟被墙，永不回应
    send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" });
  });
  for (const p of PAGES) {
    await send("Page.navigate", { url: `${BASE}/${p}` });
    await sleep(3000);
    const fcp = await ev(`(performance.getEntriesByName("first-contentful-paint")[0] || {}).startTime || null`);
    const h = await ev(`(document.querySelector("h1,h2")||{}).textContent || ""`);
    ok(`D ${p} 连不上 Google 时 3 秒内出字（FCP ${fcp == null ? "无" : Math.round(fcp) + "ms"}）`, fcp != null && fcp < 3000 && h.trim().length > 0, `fcp=${fcp}`);
  }
} finally {
  try { ws.close(); } catch {}
  chrome.kill(); server.close();
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
console.log(`\nBLOCKED FONTS: ${pass} PASS / ${fails} FAIL`);
process.exit(fails ? 1 : 0);
