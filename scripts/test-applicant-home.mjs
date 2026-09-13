// 申请者中心首页。PORTAL-blueprint 第 234 行规定这一页是
//   /portal/applicant/    首页：状态卡 + 下一步 + **通知**
// 状态卡和下一步都在，**通知整块没有**。
//
// 具体后果：my_application 明明返回了 applicant_visible_message（教务写给
// 申请人的话，见 migrations/0008_applications.sql:197/201），
// 申请详情页与历史页都把它显示成「招生同工留言」，唯独申请人自己的**首页**
// 不显示。于是教务让他补材料、或者给了录取说明，他登进来只看到一个状态标签
// 和一句固定描述，得再点一层才知道对方说了什么。
//
// 另一处同类：待补充项数读失败时被当成 0 —— 横幅直接消失，
// 申请人以为没有待办。读不到 ≠ 没有。
//
// 本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。
// 端口与 profile 由本次实例真正拥有（共享启动器）。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnChrome } from "./lib/chrome-launcher.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".webp":"image/webp",
  ".svg":"image/svg+xml", ".ico":"image/x-icon", ".woff2":"font/woff2" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control":"no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const { chrome, port } = await launchOwnChrome({
  profilePrefix: "amas-applhome-",
  extraArgs: ["--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0", "--disable-gpu", "--hide-scrollbars"],
});

let externalHits = 0;
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  on(m, f) { this.handlers.set(m, f); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
      if (!url) await sleep(200);
    }
    if (!url) throw new Error("连不上自己的调试端口 " + port);
    const s = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
    const c = new Cdp(s);
    s.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method && c.handlers.has(m.method)) c.handlers.get(m.method)(m.params); };
    return c;
  }
  send(method, params = {}, ms = 25000) {
    return new Promise((res, rej) => { const i = ++this.id;
      const t = setTimeout(() => { if (this.pending.delete(i)) rej(new Error("TIMEOUT " + method)); }, ms);
      this.pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id: i, method, params })); });
  }
  async ev(x) {
    const r = await this.send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval 抛错: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  }
}
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d ? "  ← " + d : "")); } };
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';

const STUB = `
window.supabase = {
  createClient: function(){
    var S = function(){ return window.__SCEN || {}; };
    var reply = function(v){ return Promise.resolve(v); };
    function table(name){
      var q = { select:function(){return q;}, eq:function(){return q;}, in:function(){return q;},
        order:function(){return q;}, range:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
        then:function(res, rej){
          var t = (S().tables && S().tables[name]) || { data: [], error: null };
          return Promise.resolve({ data:t.data, error:t.error||null,
            status: t.status != null ? t.status : (t.error ? 500 : 200) }).then(res, rej);
        } };
      return q;
    }
    return {
      auth: {
        getSession: function(){ return reply({ data:{ session:{ user:{id:"u-appl"}, access_token:"fx" } }, error:null }); },
        mfa: { getAuthenticatorAssuranceLevel: function(){ return reply({ data:{ currentLevel:"aal1", nextLevel:"aal1" }, error:null }); } },
        onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
        signOut: function(){ return reply({}); }
      },
      from: table,
      rpc: function(name){
        var sc = S();
        if (name === "my_roles") return reply({ data:[{ role:"applicant" }], error:null, status:200 });
        if (name === "my_profile") return reply({ data:{ display_name:"测试申请人", email:"a@example.invalid" }, error:null, status:200 });
        var r = (sc.rpc && sc.rpc[name]) || { data:null, error:null };
        return reply({ data:r.data, error:r.error||null, status:r.status!=null?r.status:(r.error?500:200) });
      },
      functions: { invoke: function(){ return reply({ data:null, error:null }); } }
    };
  }
};`;

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("cdn.jsdelivr.net") > -1 && u.indexOf("supabase-js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name:"Content-Type", value:"application/javascript" }, { name:"Cache-Control", value:"no-store" }], body: b64(STUB) }); return; }
      if (u.indexOf("supabase-config.js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name:"Content-Type", value:"application/javascript" }, { name:"Cache-Control", value:"no-store" }], body: b64(CFG) }); return; }
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });

  let nav = 0;
  const open = async (scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    await cdp.send("Page.navigate", { url: `${BASE}/portal/applicant/?r=${++nav}` });
    await sleep(wait || 2800);
  };
  const vis = async () => cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template,[hidden]").forEach(n=>n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);
  const html = async () => cdp.ev(`document.getElementById("main") ? document.getElementById("main").innerHTML : ""`);

  const MSG = "请补交受洗证明与最高学历证书扫描件。";
  const appOf = (status, extra) => Object.assign({
    id:"app-fx-1", pathway:"degree", status, form_data:{ name_zh:"测试申请人", programs:["bth"] },
    form_version:"v1", locked_fields:[], applicant_visible_message: null,
    submitted_at:"2026-09-01T00:00:00Z", decided_at:null, updated_at:"2026-09-02T00:00:00Z",
  }, extra || {});
  const CAT = { program_catalog: { data:[{ code:"bth", name_zh:"神学本科", short_label:"B.Th" }] } };

  // ════════ N 通知：教务写给申请人的话 ════════
  console.log("\n=== N 通知（招生同工留言）===");
  await open({ tables: Object.assign({}, CAT, { application_requirements: { data:[{ id:"r1", resolved:false }] } }),
    rpc: { my_application: { data:[ appOf("needs_information", { applicant_visible_message: MSG }) ] } } });
  const t1 = await vis();
  ok("N0 前提：首页正常渲染出状态卡", /需补充资料/.test(t1), t1.slice(0, 120));
  ok("N1 首页显示教务写给申请人的留言（blueprint §234 的「通知」）",
     t1.indexOf(MSG) > -1, t1.slice(0, 260));
  ok("N2 留言带明确标签，不是一段没头没尾的话",
     /留言|通知|说明/.test(t1) && t1.indexOf(MSG) > -1, t1.slice(0, 260));

  // 转义：留言是服务端来的文本，不能当 HTML 解析
  await open({ tables: CAT,
    rpc: { my_application: { data:[ appOf("accepted", { applicant_visible_message: '<img src=x onerror=alert(1)>恭喜' }) ] } } });
  const h = await html();
  ok("N3 留言经过转义，不会被当成 HTML 执行",
     h.indexOf("&lt;img") > -1 && h.indexOf("<img src=x") === -1,
     (h.match(/.{0,60}img.{0,40}/) || [""])[0]);

  await open({ tables: CAT, rpc: { my_application: { data:[ appOf("submitted") ] } } });
  const t3 = await vis();
  ok("N4 没有留言时不显示空的通知块", !/留言[:：]?\s*$/.test(t3) && !/招生同工留言/.test(t3), t3.slice(0, 200));

  // ════════ P 待补充项数 ════════
  console.log("\n=== P 待补充项数 ===");
  await open({ tables: Object.assign({}, CAT, { application_requirements: { data:[{ id:"r1", resolved:false }, { id:"r2", resolved:false }, { id:"r3", resolved:true }] } }),
    rpc: { my_application: { data:[ appOf("needs_information", { applicant_visible_message: MSG }) ] } } });
  ok("P0 正常时显示待补充的项数", /有\s*2\s*项/.test(await vis()), (await vis()).slice(0, 200));

  await open({ tables: Object.assign({}, CAT, { application_requirements: { data:null, error:{ message:"boom" }, status:500 } }),
    rpc: { my_application: { data:[ appOf("needs_information", { applicant_visible_message: MSG }) ] } } });
  const t5 = await vis();
  ok("P1 读不到待补充清单时不静默（不把读不到当成 0 项）",
     /没能确认|无法确认/.test(t5), t5.slice(0, 240));
  ok("P1b 也不谎称一个具体数字", !/有\s*0\s*项/.test(t5), t5.slice(0, 240));

  // ════════ S 状态卡与下一步（回归）════════
  console.log("\n=== S 状态卡与下一步 ===");
  await open({ tables: CAT, rpc: { my_application: { data: [] } } });
  ok("S1 没有申请时显示开始入口（没改坏）", /开始你的入学申请/.test(await vis()));
  await open({ tables: CAT, rpc: { my_application: { data:[ appOf("accepted") ] } } });
  const t6 = await vis();
  ok("S2 已录取时保留「录取不等于学籍建立」的既有说明（没改坏）",
     /录取不等于学籍建立/.test(t6), t6.slice(0, 200));

  console.log("\n=== G 外发 ===");
  ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");
  cdp.ws.close();
} finally {
  try { chrome.kill(); } catch (e) {}
  server.close();
}
console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。");
process.exit(fail ? 1 : 0);
