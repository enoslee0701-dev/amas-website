// 只读页面把「读不到」说成了「没有」。
//
//   portal/student/            my_action_items 读失败 → acts 是 undefined →
//     (acts || []) 为空 → 页面写「目前没有需要你处理的事项。」
//     一个正被教务要求补件的学员，会被告知没事要做。
//     my_learning 读失败同理 → 「AMAS 正式课程共 0 门，其中 0 门已有线上学习内容。」
//     ——学校有 67 门课，这是一句平白的假话。
//
//   portal/applicant/history/  两处把**错误对象**传给了只收 code 字符串的 Api.msg
//     （`msg = (code) => MESSAGES[code] || MESSAGES.unknown`），
//     于是任何原因都被压成「操作未能完成，请稍后再试。」。
//     这与第二十五包在 applicant/profile 修掉的是同一个坑 —— 当时漏了这个入口。
//
// 本地 stub：无真实账号/凭据/服务，无远端写入，无外网请求。
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
  profilePrefix: "amas-readfail-",
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
  /* 真实鼠标点击：beforeunload 只有在页面有过用户交互（sticky activation）之后
     才会真的弹出来，纯脚本改值不算。 */
  async clickReal(sel) {
    const pt = await this.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null; el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,ok:!!hit&&(hit===el||el.contains(hit)||hit.contains(el))};})()`);
    if (!pt || !pt.ok) throw new Error("点不到 " + sel);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await sleep(200);
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
    var fail = function(name){ return (S().failRpc || []).indexOf(name) > -1; };
    /* 「无结论」和「报错」是两种不同的返回，页面对它们的反应也该不同：
       nullRpc 里的名字返回 error 为空、data 不是可用数组 —— 服务端没给出可读结论。 */
    var noConc = function(name){ return (S().nullRpc || []).indexOf(name) > -1; };
    function table(name){
      var q = { select:function(){return q;}, eq:function(){return q;}, in:function(){return q;},
        order:function(){return q;}, range:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
        then:function(res, rej){
          var t = (S().tables && S().tables[name]) || { data: [], error: null };
          return Promise.resolve({ data:t.data, error:t.error||null, status:t.error?500:200 }).then(res, rej);
        } };
      return q;
    }
    return {
      auth: {
        getSession: function(){ return reply({ data:{ session:{ user:{id:"u-fx"}, access_token:"fx" } }, error:null }); },
        mfa: { getAuthenticatorAssuranceLevel: function(){ return reply({ data:{ currentLevel:"aal1", nextLevel:"aal1" }, error:null }); } },
        onAuthStateChange: function(){ return { data:{ subscription:{ unsubscribe:function(){} } } }; },
        signOut: function(){ return reply({}); }
      },
      from: table,
      rpc: function(name){
        var sc = S();
        /* 页内计数：点击不导航，计数不会被冲掉；用来量「再点一次有没有真的重新请求」。 */
        try { window.__rpcCalls = window.__rpcCalls || {}; window.__rpcCalls[name] = (window.__rpcCalls[name] || 0) + 1; } catch (e) {}
        if (fail(name)) return reply({ data:null, error:{ message:"boom" }, status:500 });
        if (noConc(name)) return reply({ data:(sc.nullShape !== undefined ? sc.nullShape : null), error:null, status:200 });
        if (name === "my_roles") return reply({ data:(sc.roles||["student"]).map(function(r){return {role:r};}), error:null, status:200 });
        if (name === "my_profile") return reply({ data:{ display_name:"测试学员", email:"a@example.invalid" }, error:null, status:200 });
        if (name === "my_student_record") return reply({ data:[{ student_number:"S-FX", status:"active", program_code:"bth", enrolled_at:"2026-01-01" }], error:null, status:200 });
        if (name === "my_student_timeline") return reply({ data:[], error:null, status:200 });
        if (name === "my_student_capabilities") return reply({ data:{}, error:null, status:200 });
        if (name === "my_action_items") return reply({ data:[{ source_type:"student_record", title:"补交受洗证明",
          status:"open", reason:"教务要求补充", target_url:"portal/student/profile/" }], error:null, status:200 });
        if (name === "my_learning") return reply({ data:[{ code:"c1", availability:"available" },
          { code:"c2", availability:"planned" }], error:null, status:200 });
        if (name === "my_application_timeline") return reply({ data:[{ to_status:"submitted",
          applicant_visible_message:"已收到", created_at:"2026-09-01T00:00:00Z" }], error:null, status:200 });
        return reply({ data:null, error:null, status:200 });
      },
      functions: { invoke: function(){ return reply({ data:null, error:null }); } }
    };
  }
};`;

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 900, deviceScaleFactor: 1, mobile: false });
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
  const open = async (page, scen, wait) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__SCEN = " + JSON.stringify(scen) + ";" });
    await cdp.send("Page.navigate", { url: `${BASE}/${page}?r=${++nav}` });
    await sleep(wait || 3000);
  };
  const vis = async () => cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template,[hidden]").forEach(n=>n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);

  // ════════ S 学员首页：读不到 ≠ 没有 ════════
  console.log("\n=== S 学员首页 ===");
  await open("portal/student/", { roles:["student"] });
  const s0 = await vis();
  ok("S0 前提：正常时显示待办与课程数",
     /补交受洗证明/.test(s0) && /共\s*<?b?>?2/.test(s0.replace(/\s/g,"").replace("共2","共 2")) || /共 2 门|共2门/.test(s0),
     s0.slice(0, 220));

  await open("portal/student/", { roles:["student"], failRpc:["my_action_items"] });
  const s1 = await vis();
  ok("S1 待办读失败时**不**说「目前没有需要你处理的事项」",
     !/目前没有需要你处理的事项/.test(s1), s1.slice(0, 260));
  ok("S1b 而是如实说这一次没读到", /没能读到|没能确认|暂时读不到/.test(s1), s1.slice(0, 260));

  await open("portal/student/", { roles:["student"], failRpc:["my_learning"] });
  const s2 = await vis();
  ok("S2 课程读失败时不写成「共 0 门」",
     !/共\s*0\s*门/.test(s2), s2.slice(0, 260));
  ok("S2b 而是如实说这一次没读到课程目录",
     /没能读到|暂时读不到/.test(s2), s2.slice(0, 260));

  // ════════ H 历史申请：错误原因不能被压成一句 ════════
  console.log("\n=== H 历史申请 ===");
  await open("portal/applicant/history/", { roles:["applicant"],
    tables:{ applications:{ data:null, error:{ message:"permission denied" }, status:403 } } });
  const h1 = await vis();
  ok("H1 列表读失败时说得出具体原因，不是笼统的「操作未能完成」",
     !/操作未能完成/.test(h1), h1.slice(0, 220));

  await open("portal/applicant/history/", { roles:["applicant"],
    tables:{ applications:{ data:[{ id:"a1", pathway:"degree", status:"rejected",
      applicant_visible_message:"很遗憾", submitted_at:"2026-08-01T00:00:00Z",
      decided_at:"2026-08-10T00:00:00Z", created_at:"2026-07-01T00:00:00Z" }] } },
    failRpc:["my_application_timeline"] });
  await cdp.ev(`(()=>{const b=document.querySelector("[data-tl]"); if(b) b.click(); return !!b;})()`);
  await sleep(1500);
  const h2 = await vis();
  ok("H2 时间线读失败时同样说得出具体原因",
     !/操作未能完成/.test(h2), h2.slice(0, 240));

  // ════════ Hn 历史页：没读到 ≠ 没有 ════════
  console.log("\n=== Hn 历史申请：读不到时不许说成「没有」===");

  /* 已有的 H1/H2 覆盖的是 **error 有值** 那一支（原因要说得具体）。
     没覆盖的是「无结论」：error 为空、data 却不是可用数组。
     列表那一处是 `const list = rows || []; if (!list.length) → 「还没有历史记录 /
     你目前没有已结束的申请」`；这是在替服务端下判断，和申请页首屏那处是同一族。 */
  await open("portal/applicant/history/", { roles:["applicant"],
    tables:{ applications:{ data:null, error:null } } });
  const hn1 = await vis();
  /* 判据要对准**空态那句原文**。写成 /没有已结束的申请/ 会连新文案里
     「无法确认你有没有已结束的申请」一起命中 —— 那是我自己的措辞，不是缺陷。 */
  ok("Hn1 列表没读到时，不咬定「你目前没有已结束的申请」",
     !/你目前没有已结束的申请|还没有历史记录/.test(hn1), hn1.slice(0, 240));
  ok("Hn1b 而是如实说这一次没读到，并给刷新",
     /没能读到|没读到|暂时读不到/.test(hn1) && /刷新/.test(hn1), hn1.slice(0, 280));

  await open("portal/applicant/history/", { roles:["applicant"],
    tables:{ applications:{ data:{}, error:null } } });
  const hn2 = await vis();
  ok("Hn2 返回的不是数组时，同样不当成「没有历史」",
     !/你目前没有已结束的申请|还没有历史记录/.test(hn2), hn2.slice(0, 240));

  /* 时间线那一处：`const items = tl || []; items.length ? … : 「这份申请没有可显示的状态变化记录。」`
     按契约这句话**不可达** —— 撤回（0008:278）与退回/拒绝（0008:332）都会写一行
     application_status_history，而历史页只列 rejected/withdrawn 两种。
     所以它一旦显示出来，说的就是假话。 */
  const ONE_REJ = { applications:{ data:[{ id:"a1", pathway:"degree", status:"rejected",
    applicant_visible_message:"很遗憾", submitted_at:"2026-08-01T00:00:00Z",
    decided_at:"2026-08-10T00:00:00Z", created_at:"2026-07-01T00:00:00Z" }] } };
  await open("portal/applicant/history/", { roles:["applicant"], tables:ONE_REJ,
    nullRpc:["my_application_timeline"] });
  await cdp.ev(`(()=>{const b=document.querySelector("[data-tl]"); if(b) b.click(); return !!b;})()`);
  await sleep(1500);
  const hn3 = await vis();
  ok("Hn3 时间线没读到时，不说成「这份申请没有可显示的状态变化记录」",
     !/没有可显示的状态变化记录/.test(hn3), hn3.slice(0, 300));
  ok("Hn3b 而是如实说这一次没读到",
     /没能读到|没读到/.test(hn3), hn3.slice(0, 300));
  ok("Hn3c 而且没被标成已加载 —— 下次点还能再试",
     (await cdp.ev(`(()=>{const b=document.querySelector("[data-tl]"); return !b || b.dataset.loaded !== "1";})()`)) === true);
  /* Hn3c 只看了标记。真正要紧的是**再点一次就重新去读** —— 原来读不到时再点只会把提示收起来，
     要点第二下才重试（T-012 修复；node:vm 边界检查 test-applicant-history-read-boundary.mjs 也钉了）。
     这里在真实浏览器里再钉一次：点击、hidden 属性、dataset 都是真 DOM。 */
  const tlCalls = async () => (await cdp.ev(`(window.__rpcCalls || {}).my_application_timeline || 0`)) || 0;
  const tl1 = await tlCalls();
  await cdp.ev(`(()=>{const b=document.querySelector("[data-tl]"); if(b) b.click(); return !!b;})()`);
  await sleep(1500);
  const tl2 = await tlCalls();
  const hn3d = await vis();
  ok("Hn3d 读不到之后照提示「再点一次」，确实重新请求了时间线，而不是只把提示收起来",
     tl1 === 1 && tl2 === 2 && /没能读到|没读到/.test(hn3d), JSON.stringify({ before: tl1, after: tl2, text: hn3d.slice(-120) }));

  /* 反面：真的没有历史 / 时间线真的为空时，原来的说法照旧，不能为修这个把正常话堵掉。 */
  await open("portal/applicant/history/", { roles:["applicant"],
    tables:{ applications:{ data:[], error:null } } });
  ok("Hn4 真的没有历史时（data: []），照常说「还没有历史记录」",
     /还没有历史记录/.test(await vis()));

  await open("portal/applicant/history/", { roles:["applicant"], tables:ONE_REJ,
    nullRpc:["my_application_timeline"], nullShape:[] });
  await cdp.ev(`(()=>{const b=document.querySelector("[data-tl]"); if(b) b.click(); return !!b;})()`);
  await sleep(1500);
  ok("Hn5 时间线确实是空数组时，照常说「没有可显示的状态变化记录」",
     /没有可显示的状态变化记录/.test(await vis()));

  // ════════ Ht 终态划分：两页加契约，三处必须说同一件事 ════════
  console.log("\n=== Ht 终态划分：「我的申请」排除的，正好是「历史申请」列出的 ===");

  /* 这一组是**源码/契约一致性检查**，不是浏览器行为检查 —— 如实标明。
     理由：stub 不执行 .in() 过滤，喂什么列什么，所以「只列终态」这件事
     在本机 stub 里量不出来；能量的是三处定义有没有说同一件事。
     一旦它们分了岔，就会有某个状态**两页都不显示** —— 申请人那份申请凭空消失。 */
  const SRC = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const sql  = SRC("supabase/migrations/0008_applications.sql");
  const appP = SRC("portal/applicant/application/index.html");
  const hisP = SRC("portal/applicant/history/index.html");

  const enumStates = (sql.match(/create type application_status as enum\s*\(([^)]*)\)/) || [])[1] || "";
  const ENUM = [...enumStates.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  ok("Ht0 前提：契约里的状态枚举读得到（7 个）", ENUM.length === 7, JSON.stringify(ENUM));

  const excluded = [...(sql.match(/status not in \('rejected','withdrawn'\)/g) || [])];
  ok("Ht1 契约两处（唯一活动索引 :43、my_application :205）用的是同一条界线",
     excluded.length >= 2, "命中 " + excluded.length + " 处");

  const hisIn = (hisP.match(/in:\s*\{\s*status:\s*\[([^\]]*)\]/) || [])[1] || "";
  const HIS = [...hisIn.matchAll(/"([a-z_]+)"/g)].map(m => m[1]).sort();
  ok("Ht2 历史页查的正好是被排除的那两个",
     JSON.stringify(HIS) === JSON.stringify(["rejected", "withdrawn"]), JSON.stringify(HIS));

  const active = ENUM.filter(x => HIS.indexOf(x) < 0).sort();
  ok("Ht3 不重不漏：活动集 ∪ 终态集 = 全部枚举，且交集为空",
     active.length + HIS.length === ENUM.length &&
     active.every(x => HIS.indexOf(x) < 0), JSON.stringify({ active, HIS }));

  /* 同一个状态在两页必须叫同一个名字 —— 他在「我的申请」上看到「已撤回」，
     到了「历史申请」就不该变成别的说法。 */
  const labelOf = (src, key) => {
    const m = src.match(new RegExp(key + "\\s*:\\s*\\{\\s*t\\s*:\\s*\"([^\"]+)\""));
    return m ? m[1] : null;
  };
  for (const k of HIS) {
    ok("Ht4 「" + k + "」在两页叫同一个名字",
       labelOf(appP, k) !== null && labelOf(appP, k) === labelOf(hisP, k),
       JSON.stringify({ 申请页: labelOf(appP, k), 历史页: labelOf(hisP, k) }));
  }

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
