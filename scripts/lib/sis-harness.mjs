// 门户页面的本机浏览器测试夹具：本地静态服务 + 自有 Chrome + 假 supabase 客户端。
// supabase-js 换成按 window.__SCEN 回答的假客户端；Edge 调用只换最底层 fetch（armFn）；
// 页面自己的 Shell.mount / Api / callFn 保持真身。不联网、不用真实凭据、不写远端。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnChrome } from "./chrome-launcher.mjs";
import { refuseLocalConfig } from "./no-local-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';
const STUB = `
window.supabase = { createClient: function(){
  var S = function(){ return window.__SCEN || {}; };
  var reply = function(v){ return Promise.resolve(v); };
  function table(name){ var q = { select:function(){return q;}, eq:function(){return q;}, in:function(){return q;},
    order:function(){return q;}, range:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
    single:function(){return q;},
    update:function(p){ window.__upd = window.__upd || []; window.__upd.push({ table: name, patch: p }); q._u = ":update"; return q; },
    insert:function(p){ window.__upd = window.__upd || []; window.__upd.push({ table: name, insert: p }); q._u = ":insert"; return q; },
    then:function(res, rej){ var t = (S().tables && S().tables[q._u ? name + q._u : name]) || { data: [], error: null };
      return Promise.resolve({ data: t.data, error: t.error || null, status: t.error ? 500 : 200 }).then(res, rej); } };
    return q; }
  return {
    auth: { getSession:function(){ return reply({ data: { session: S().session || null } }); },
      mfa: { getAuthenticatorAssuranceLevel:function(){ return reply({ data: { currentLevel: S().aal || "aal1", nextLevel: S().aal || "aal1" } }); } },
      onAuthStateChange:function(){ return { data: { subscription: { unsubscribe:function(){} } } }; },
      signOut:function(){ return reply({}); } },
    from: table,
    rpc: function(name, args){ window.__rpc = window.__rpc || []; window.__rpc.push({ name: name, args: args, t: performance.now() });
      var r = S().rpc && S().rpc[name]; if (!r) r = { data: null, error: null };
      var out = { data: r.data, error: r.error || null, status: r.error ? 500 : 200 };
      if (r.delay) return new Promise(function(ok){ setTimeout(function(){ ok(out); }, r.delay); });
      return reply(out); },
    functions: { invoke:function(){ return reply({ data: null, error: null }); } }
  }; } };`;

export async function startHarness({ profilePrefix = "amas-h-", shotPrefix = "h" } = {}) {
  const SHOT_DIR = process.argv.includes("--shots") ? (process.env.SHOT_DIR || path.join(os.tmpdir(), "amas-shots")) : null;
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (refuseLocalConfig(p, res)) return;
    if (p.endsWith("/")) p += "index.html";
    const abs = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(abs).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const BASE = `http://127.0.0.1:${server.address().port}`;
  const { chrome, port, profileDir } = await launchOwnChrome({ profilePrefix, extraArgs: ["--disable-gpu", "--hide-scrollbars"] });

  let ws, seq = 0; const pending = new Map(), handlers = new Map();
  for (let i = 0; i < 80 && !ws; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const u = j.find((x) => x.type === "page")?.webSocketDebuggerUrl;
      if (u) ws = await new Promise((ok, no) => { const s = new WebSocket(u); s.onopen = () => ok(s); s.onerror = no; });
    } catch {}
    if (!ws) await sleep(250);
  }
  if (!ws) { chrome.kill(); server.close(); throw new Error("连不上 Chrome"); }
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method && handlers.has(m.method)) handlers.get(m.method)(m.params); };
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval"); return r.result?.result?.value; };
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
  await send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  let external = 0;
  handlers.set("Fetch.requestPaused", async (p) => {
    const u = p.request.url;
    try {
      if (u.includes("cdn.jsdelivr.net") && u.includes("supabase-js")) {
        return void await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: b64(STUB) });
      }
      if (u.includes("supabase-config.js")) {
        return void await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" }], body: b64(CFG) });
      }
      if (!u.startsWith(BASE)) external++;
      await send("Fetch.continueRequest", { requestId: p.requestId });
    } catch {}
  });

  let pass = 0, fails = 0, scriptId = null;
  const h = {
    sleep, ev, send,
    ok(name, cond, detail) { if (cond) { pass++; console.log("  PASS  " + name); }
      else { fails++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); } },
    async open(page, scen, wait = 1800) {
      if (scriptId) await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId });
      const r = await send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN=" + JSON.stringify(scen) + ";window.__rpc=[];" });
      scriptId = r.result.identifier;
      await send("Page.navigate", { url: `${BASE}/${page}` });
      await sleep(wait);
    },
    txt: () => ev(`(()=>{const c=document.body.cloneNode(true);c.querySelectorAll("script,style").forEach(n=>n.remove());return (c.textContent||"").replace(/\\s+/g," ").trim();})()`),
    click: (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true;})()`),
    setVal: (sel, v) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.value=${JSON.stringify(v)};
      e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`),
    /** 页面里改场景（例如写入成功后下一次读到的数据）。 */
    setScen: (patch) => ev(`(()=>{ const p = ${JSON.stringify(patch)}; const s = window.__SCEN;
      for (const k of Object.keys(p)) s[k] = Object.assign({}, s[k] || {}, p[k]); return true; })()`),
    rpcCalls: (name) => ev(`(window.__rpc||[]).filter(r=>r.name===${JSON.stringify(name)})`),
    armFn: (mode, payload, delay = 0) => ev(`(()=>{ window.__fn = []; const orig = window.__origFetch || (window.__origFetch = window.fetch);
      window.fetch = function(u, opt){ if (String(u).indexOf("/functions/v1/") < 0) return orig.apply(this, arguments);
        window.__fn.push({ url: String(u), body: JSON.parse(opt.body) });
        const m = ${JSON.stringify(mode)}, p = ${JSON.stringify(payload ?? null)};
        const later = (v) => new Promise(r => setTimeout(() => r(v), ${delay}));
        if (m === "throw") return Promise.reject(new TypeError("Failed to fetch"));
        if (m === "reject") return later(new Response(JSON.stringify(p), { status: 409, headers: { "Content-Type": "application/json" } }));
        return later(new Response(JSON.stringify(p), { status: 200, headers: { "Content-Type": "application/json" } })); };
      return true; })()`),
    fnCalls: () => ev(`window.__fn || []`),
    async shot(name) {
      if (!SHOT_DIR) return;
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
      fs.writeFileSync(path.join(SHOT_DIR, `${shotPrefix}-${name}.png`), Buffer.from(r.result.data, "base64"));
    },
    external: () => external,
    fail(msg) { fails++; console.log("  FAIL  " + msg); },
    async close(label) {
      try { ws.close(); } catch {}
      chrome.kill(); server.close();
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
      console.log(`\n${label}: ${pass} PASS / ${fails} FAIL`);
      return fails;
    },
  };
  return h;
}
