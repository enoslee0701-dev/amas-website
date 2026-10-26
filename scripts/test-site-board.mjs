#!/usr/bin/env node
// 官网首页动态内容（0041 site_public，2026-10-26）：各班开课状态、线上课堂入口、开学导言、公开公告。
//   后台改了就跟着变；读不到时首页保持写死的文字、整块不出现。supabase 请求由 CDP 伪造，不外发。
// 运行：node scripts/test-site-board.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnChrome } from "./lib/chrome-launcher.mjs";
import { refuseLocalConfig } from "./lib/no-local-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".json": "application/json", ".mp4": "video/mp4", ".pdf": "application/pdf" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (refuseLocalConfig(p, res)) return;
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const { chrome, port } = await launchOwnChrome({
  profilePrefix: "amas-board-",
  extraArgs: ["--host-resolver-rules=MAP formsubmit.co 0.0.0.0, MAP *.supabase.co 0.0.0.0", "--disable-gpu", "--hide-scrollbars"],
});

let ws, id = 0; const pending = new Map(), handlers = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval 抛错: " + (r.exceptionDetails.exception?.description || "")); return r.result?.value; };
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); } else { fail++; console.log("  FAIL  " + n + (d ? "  ← " + d : "")); } };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};window.SUPA_IS_FILLED=function(){return true};';

let reply = null, calls = 0;
const leaked = [];
const FIX = { cohorts: [{ name: "10月班", phase: "in_session" }, { name: "11月班", phase: "enrolling" }, { name: "12月班", phase: "enrolling" }],
  live_class: { enabled: true, allow_guests: true, url: "https://zoom.example/j/123", meeting_id: "123 456 789", passcode: "amas", title: "周三晚上神学课", schedule: "每周三 20:00" },
  intro_video: { enabled: true, title: "开学导言", youtube: "https://youtu.be/x", china: "", desc: "第一次上课录像" },
  announcements: [{ title: "<b>停课</b>通知", body: "下周三停课一次", pinned: true }] };
try {
  let url;
  for (let i = 0; i < 80 && !url; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
    if (!url) await sleep(200);
  }
  ws = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method && handlers.has(m.method)) handlers.get(m.method)(m.params); };
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  const cors = [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Access-Control-Allow-Headers", value: "*" }, { name: "Access-Control-Allow-Methods", value: "POST" }, { name: "Content-Type", value: "application/json" }];
  handlers.set("Fetch.requestPaused", async (p) => {
    const u = p.request.url;
    try {
      if (p.request.method === "OPTIONS") return send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 204, responseHeaders: cors });
      if (u.includes(".supabase.co/rest/v1/rpc/site_public")) {
        calls++;
        return send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: reply ? 200 : 500, responseHeaders: cors, body: b64(JSON.stringify(reply || {})) });
      }
      if (u.includes("/assets/js/supabase-config.js"))
        return send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: b64(CFG) });
      if (!u.startsWith(BASE + "/") && !u.startsWith("data:")) { leaked.push(u.split("?")[0]); return send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }); }
      await send("Fetch.continueRequest", { requestId: p.requestId });
    } catch (e) {}
  });
  const load = async (lang) => { await send("Page.navigate", { url: BASE + "/index.html" + (lang ? "?lang=" + lang : "") }); await sleep(1800); };
  const txt = (sel) => ev(`(document.querySelector(${JSON.stringify(sel)})||{}).textContent||""`);

  console.log("\n=== 读不到时 ===");
  reply = null; await load("zh");
  ok("B1 读不到：首页保持写死的开课状态，整块不出现", calls > 0 && (await txt('[data-i18n="herometa.startVal"]')).includes("10月班已开课") &&
     (await ev(`document.getElementById("liveBoard").hidden`)) === true);

  console.log("\n=== 后台有内容 ===");
  reply = FIX; await load("zh");
  ok("B2 开课状态跟着后台：三个班各一行", (await ev(`document.querySelector('[data-i18n="herometa.startVal"]').innerText`)) === "10月班已开课\n11月班招生中\n12月班招生中");
  ok("B3 招生区与项目卡同步，项目卡后半段保留", (await txt('[data-i18n="admissions.facts.startValue"]')) === "10月班已开课 · 11月班招生中 · 12月班招生中" &&
     (await txt('[data-i18n="programs.items.bth.desc"]')).startsWith("10月班已开课 · 11月班招生中 · 12月班招生中 · 77 学分"));
  ok("B4 线上课堂：标题、时间、会议号与密码、入口链接、欢迎旁听", (await txt("#liveTitle")) === "周三晚上神学课" && (await txt("#liveIds")).includes("会议号: 123 456 789") &&
     (await txt("#liveIds")).includes("密码: amas") && (await ev(`document.getElementById("liveJoin").href`)) === "https://zoom.example/j/123" &&
     (await ev(`document.getElementById("liveJoin").target`)) === "_blank" && (await ev(`!document.getElementById("liveGuest").hidden`)));
  ok("B5 开学导言：只有填了的那个按钮出现", (await ev(`!document.getElementById("videoYt").hidden && document.getElementById("videoCn").hidden`)) && (await txt("#videoTitle")) === "开学导言");
  ok("B6 公告标题里的 HTML 不被执行", (await txt("#annList")).includes("<b>停课</b>通知") && (await ev(`!document.querySelector("#annList b b")`)));
  await ev(`document.querySelector('[data-lang="en"]') ? document.querySelector('[data-lang="en"]').click() : applyLanguage("en"); true`); await sleep(300);
  ok("B7 切到英文：班名与状态也是英文", (await ev(`document.querySelector('[data-i18n="herometa.startVal"]').innerText`)).startsWith("Oct class: in session") &&
     (await txt("#liveIds")).includes("Meeting ID: 123 456 789"));

  console.log("\n=== 链接不安全 / 关闭时 ===");
  reply = Object.assign({}, FIX, { live_class: { enabled: true, allow_guests: true, url: "javascript:alert(1)" }, intro_video: { enabled: false }, announcements: [] });
  await load("zh");
  ok("B8 不是 https 的会议链接不显示入口；其余为空时整块不出现", (await ev(`document.getElementById("liveClass").hidden && document.getElementById("liveBoard").hidden`)));

  ok("O1 没有请求离开本机（字体除外）", leaked.every((u) => /fonts\.(googleapis|gstatic)/.test(u)), leaked.join(" "));
} catch (e) { fail++; console.log("  FAIL  测试过程抛错：" + e.message); }
try { ws?.close(); } catch {}
chrome.kill(); server.close();
console.log(`\nSITE BOARD: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
