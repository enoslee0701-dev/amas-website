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

  // ════════ R 补完之后的下一步（needs_information 的三种不同处境）════════
  console.log("\n=== R 补完之后，首页说的下一步对不对 ===");
  /* 服务端 0008_applications.sql:241-246 说得很死：needs_information 重新提交时，
     只要还有 resolved = false 的条目就回 requirements_pending，全部完成才放行。
     而 review_application 的 p_requirements 是**可选**的（0008 那一段 `if … is not null`）——
     教务完全可以只写一句留言、不列任何条目。
     所以「需补充资料」底下其实有三种不同的下一步，首页此前都压成同一句
     「有资料需要你补充后重新提交」+ 一个「立即补充」按钮：
       还有没标完的  → 去补（已有）
       全部标完了    → 就差**重新提交**这一下（缺）
       教务没列条目  → 按留言补（缺，不能谎称「都已完成」） */
  const btnText = async () => cdp.ev(`(()=>{const a=document.querySelector("#main a.btn");
    return a ? (a.textContent||"").trim() : null;})()`);
  /* 只看状态卡那一张卡里的提示块，别把整页（含底部帮助中心入口）都算进来。 */
  const cardNote = async () => cdp.ev(`(()=>{const c=document.querySelector("#main .card");
    if(!c) return null; return [...c.querySelectorAll(".msg")].map(n=>(n.textContent||"").replace(/\s+/g," ").trim()).join(" | ");})()`);
  const cardHelpLink = async () => cdp.ev(`(()=>{const c=document.querySelector("#main .card");
    return !!(c && c.querySelector('a[href$="help/"]'));})()`);

  await open({ tables: Object.assign({}, CAT, { application_requirements: {
      data:[{ id:"r1", resolved:true }, { id:"r2", resolved:true }] } }),
    rpc: { my_application: { data:[ appOf("needs_information", { applicant_visible_message: MSG }) ] } } });
  const r1 = await vis();
  ok("R0 前提：状态确实是需补充资料", /需补充资料/.test(r1), r1.slice(0, 120));
  /* 判据不能用「重新提交」四个字 —— 状态描述里本来就有「…后重新提交。」，
     那一句在**没补完**的时候也在，用它做判据等于白给一个绿。 */
  ok("R1 条目全部标记完成时，首页说得出「都已标记为完成」",
     /都已标记为完成/.test(r1), r1.slice(0, 300));
  ok("R1b 并且不再同时说「还有几项要补」", !/有\s*\d+\s*项资料需要补充/.test(r1), r1.slice(0, 300));
  ok("R2 入口按钮不再写「立即补充」（已经没有要补的了）",
     (await btnText()) !== "立即补充", JSON.stringify(await btnText()));

  await open({ tables: Object.assign({}, CAT, { application_requirements: { data:[] } }),
    rpc: { my_application: { data:[ appOf("needs_information", { applicant_visible_message: MSG }) ] } } });
  const r3 = await vis();
  ok("R3 教务没有列具体条目时，不谎称「都已完成」",
     !/都已标记|都已完成|全部标记完成/.test(r3), r3.slice(0, 300));
  ok("R4 而是说清楚没有具体条目、按留言补充",
     /没有列出|未列出|没有具体条目/.test(r3), r3.slice(0, 300));

  /* 上一包新加的「没有条目」那一支无条件说「请按上面的留言补充」，
     而 notice 只有 applicant_visible_message 有内容时才渲染 ——
     没有留言却这么说，等于把他指向一段**不存在**的说明。
     这一支能不能出现？读了契约：
       · 我们自己的招生页要求至少一条补件（admissions/index.html:716 `if (!items.length)`），
         留言也 .trim() || null（:717），所以空白留言进不来；
       · Edge review-application 明确拒绝空 requirements
         （functions/review-application/validate.mjs:59-61 → requirements_required）；
       · 但 DB 函数 review_application 本身两个参数都可选
         （0008_applications.sql `if p_action = 'needs_information' and p_requirements is not null`，
         message 走 coalesce 且不 trim），而它 grant 给 service_role；Edge 目前**未部署**。
     所以这是**防御性分支**，不是常规路径 —— 但既然它会显示给人看，就不能指错路。 */
  await open({ tables: Object.assign({}, CAT, { application_requirements: { data:[] } }),
    rpc: { my_application: { data:[ appOf("needs_information", { applicant_visible_message: null }) ] } } });
  const b1 = await vis();
  ok("B1 没有条目**也没有留言**时，不把他指向不存在的「上面的留言」",
     !/上面的留言/.test(b1), b1.slice(0, 320));
  ok("B1b 而是说清楚现在无法确认要补什么",
     /无法确认|不能确认/.test(b1), b1.slice(0, 320));
  /* 不能拿整页文本判 —— 底部「💬帮助中心 常见问题与联系招生同工」本来就在，
     那条断言在修前就是绿的。要的是**状态卡里**那条下一步给出的联系入口。 */
  ok("B1c 并在状态卡里给出联系招生同工的入口",
     (await cardHelpLink()) === true, JSON.stringify(await cardNote()));
  ok("B1d 不自行推断已补完，也不叫他直接重新提交",
     !/都已标记为完成/.test(b1) && (await btnText()) !== "去重新提交",
     JSON.stringify([await btnText(), b1.slice(0, 200)]));

  await open({ tables: Object.assign({}, CAT, { application_requirements: { data:[] } }),
    rpc: { my_application: { data:[ appOf("needs_information", { applicant_visible_message: "   " }) ] } } });
  const b2 = await vis();
  ok("B2 留言是全空白时同样不指向它", !/上面的留言/.test(b2) && /无法确认|不能确认/.test(b2), b2.slice(0, 320));
  ok("B2b 也不渲染一个空的「招生同工留言：」", !/招生同工留言/.test(b2), b2.slice(0, 320));

  await open({ tables: Object.assign({}, CAT, { application_requirements: { data:[] } }),
    rpc: { my_application: { data:[ appOf("needs_information", { applicant_visible_message: MSG }) ] } } });
  const b3 = await vis();
  ok("B3 对照：确实有留言时，仍然让他按留言补充",
     /上面的留言/.test(b3) && b3.indexOf(MSG) > -1, b3.slice(0, 320));

  // 对照：还有没标完的时候，原来的说法和入口一个字都不变
  await open({ tables: Object.assign({}, CAT, { application_requirements: {
      data:[{ id:"r1", resolved:false }, { id:"r2", resolved:true }] } }),
    rpc: { my_application: { data:[ appOf("needs_information", { applicant_visible_message: MSG }) ] } } });
  const r5 = await vis();
  ok("R5 对照：还有 1 项没标完时，仍然是「有 1 项资料需要补充」",
     /有\s*1\s*项/.test(r5), r5.slice(0, 300));
  ok("R6 对照：这时候按钮仍然是「立即补充」", (await btnText()) === "立即补充", JSON.stringify(await btnText()));

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
