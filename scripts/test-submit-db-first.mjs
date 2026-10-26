#!/usr/bin/env node
// 官网提交「先存后台、再发邮件」回归（Enos 2026-10-26）。
//   邮件服务失败时，后台仍要收到这份报名；同一内容重交带同一个 dedupeKey（数据库唯一索引去重，见 0039）。
//   覆盖 index.html 联系表单（main.js logToDB）与 giving.html 奉献表单（页内写库）。
// 外发全部由 CDP 接住：formsubmit 伪造 500，supabase REST 伪造 201，绝不放出去。
// 运行：node scripts/test-submit-db-first.mjs
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
  profilePrefix: "amas-dbfirst-",
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

const log = [];          // 按到达顺序记下 { kind: "db" | "mail", body }
const leaked = [];
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  const cors = [{ name: "Access-Control-Allow-Origin", value: "*" }, { name: "Access-Control-Allow-Headers", value: "*" }, { name: "Access-Control-Allow-Methods", value: "POST" }];
  handlers.set("Fetch.requestPaused", async (p) => {
    const u = p.request.url;
    try {
      if (p.request.method === "OPTIONS") return send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 204, responseHeaders: cors });
      if (u.includes("formsubmit.co")) {
        log.push({ kind: "mail" });
        await sleep(1200);                 // 邮件服务慢且最终失败
        log.push({ kind: "mail-done" });
        return send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 500, responseHeaders: cors, body: b64("{}") });
      }
      if (u.includes(".supabase.co/rest/v1/submissions")) {
        log.push({ kind: "db", body: JSON.parse(p.request.postData || "{}") });
        return send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 201, responseHeaders: cors });
      }
      if (u.includes("/assets/js/supabase-config.js"))
        return send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: b64(CFG) });
      if (!u.startsWith(BASE + "/") && !u.startsWith("data:")) { leaked.push(u.split("?")[0]); return send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }); }
      await send("Fetch.continueRequest", { requestId: p.requestId });
    } catch (e) {}
  });
  const until = async (f, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(100); } return false; };

  // ═══ 首页联系表单 ═══
  console.log("\n=== 首页联系表单（main.js）===");
  await send("Page.navigate", { url: BASE + "/index.html" }); await sleep(1500);
  const fillContact = `(()=>{const f=document.querySelector('#contactForm');
    f.querySelector('[name=name]').value='测试访客'; f.querySelector('[name=contact]').value='visitor@example.invalid';
    f.querySelector('[name=message]').value='想了解课程'; f.requestSubmit(); return true;})()`;
  await ev(fillContact);
  await until(() => log.some((x) => x.kind === "mail-done")); await sleep(500);
  const firstDb = log.findIndex((x) => x.kind === "db"), firstMail = log.findIndex((x) => x.kind === "mail-done");
  const db1 = log[firstDb]?.body;
  ok("D1 邮件失败（500）时后台照样收到这份", firstDb > -1 && db1?.type === "contact" && db1?.name === "测试访客", JSON.stringify(log.map((x) => x.kind)));
  ok("D2 存后台不等邮件结果（邮件还没回话就已经发出）", firstDb > -1 && firstDb < firstMail, `db@${firstDb} mail-done@${firstMail}`);
  ok("D3 带内容指纹 dedupeKey", /^[0-9a-f]{24}$/.test(db1?.data?.dedupeKey || ""), db1?.data?.dedupeKey);
  const n0 = log.length;
  await sleep(500); await ev(fillContact);
  await until(() => log.slice(n0).some((x) => x.kind === "mail-done")); await sleep(500);
  const db2 = log.slice(n0).find((x) => x.kind === "db")?.body;
  ok("D4 同样内容重交，指纹相同（数据库只会存一份）", db2 && db2.data.dedupeKey === db1.data.dedupeKey, `${db1?.data?.dedupeKey} / ${db2?.data?.dedupeKey}`);

  // ═══ 奉献页 ═══
  console.log("\n=== 奉献页（giving.html）===");
  log.length = 0;
  await send("Page.navigate", { url: BASE + "/giving.html" }); await sleep(1500);
  await ev(`(()=>{const r=document.querySelector('#purposeOpts input[value=pray]'); r.closest('label').click(); r.checked=true; r.dispatchEvent(new Event('change',{bubbles:true}));
    const f=document.querySelector('#gvForm'); f.querySelector('[name=name]').value='代祷同工甲'; f.querySelector('[name=contact]').value='13900000000';
    f.requestSubmit(); return true;})()`);
  await until(() => log.some((x) => x.kind === "mail-done")); await sleep(500);
  const gDb = log.findIndex((x) => x.kind === "db"), gMail = log.findIndex((x) => x.kind === "mail-done");
  const g = log[gDb]?.body;
  ok("G1 邮件失败时后台照样收到奉献意向", g?.type === "giving" && g?.name === "代祷同工甲", JSON.stringify(log.map((x) => x.kind)));
  ok("G2 存后台不等邮件结果", gDb > -1 && gDb < gMail, `db@${gDb} mail-done@${gMail}`);
  ok("G3 带内容指纹 dedupeKey", /^[0-9a-f]{24}$/.test(g?.data?.dedupeKey || ""), g?.data?.dedupeKey);

  ok("O1 没有请求离开本机（字体除外）", leaked.every((u) => /fonts\.(googleapis|gstatic)/.test(u)), leaked.join(" "));
} catch (e) { fail++; console.log("  FAIL  测试过程抛错：" + e.message); }
try { ws?.close(); } catch {}
chrome.kill(); server.close();
console.log(`\nSUBMIT DB-FIRST: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
