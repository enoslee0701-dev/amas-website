// portal/mfa/ 的注册与验证完整客户端状态机。
//
// ── 状态机 ────────────────────────────────────────────────────────────
//   会话? → aal2? → listFactors → 已验证因子 ? 挑战 : (未完成的因子 ? 续做 : 新注册)
//        → 输入 6 位码 → challenge → verify → 回到 next
//
// ── 本轮核实过的 SDK 契约（supabase-js 2.116.0 产物，非文档推测）──────
//   ① mfa.enroll() 把二维码包成 **data URI**：
//        a.totp.qr_code = `data:image/svg+xml;utf-8,${a.totp.qr_code}`
//      页面却当成内联 SVG 用 innerHTML 塞进去（注释还写着「Supabase 返回内联 SVG」），
//      于是 `data:image/svg+xml;utf-8,` 这段前缀被当文本画在二维码上方。
//   ② mfa.listFactors() 的 data.totp **只含已验证**的因子：
//        for (t of user.factors) { all.push(t); t.status==="verified" && n[t.factor_type].push(t) }
//      上次开了头没做完的 unverified 因子只在 data.all 里。页面只看 totp[0]，
//      看不见它，于是每次进来都再 enroll 一个新的。
//   ③ mfa.challenge / verify / enroll 的 catch 是
//        catch(e){ if (isAuthError(e)) return {data:null,error:e}; throw e }
//      —— **非 AuthError（比如断网的 TypeError）是重新抛出的**，不是返回 {error}。
//      页面两个 submit 处理器都没有 try/catch，异常一路穿出去，
//      按钮停在原地、一句话都不说。
//   ④ verify 成功后 _saveSession + _notifyAllSubscribers("MFA_CHALLENGE_VERIFIED")，
//      所以回跳后的页面读到的确实是 aal2，不会来回弹。
//
// ── 用的是什么、不是什么 ──────────────────────────────────────────────
// stub 按上面四条契约仿真，**没有任何真实因子、真实密钥、真实二维码**：
// 因子 id 一律 "fixture-…"，密钥是字面量 FIXTURE-NOT-A-REAL-SECRET。
// 不读工作树里的本地配置，不发任何外网请求（supabase 域名钉到 0.0.0.0 并有断言兜底）。
// 全程不调用 unenroll —— 套件专门有一条断言守住「不自动删除因子」。
//
// ── 端口 ──────────────────────────────────────────────────────────────
// **独占动态端口**：--remote-debugging-port=0 让操作系统分配，端口号从本进程
// 自己 Chrome 的 <user-data-dir>/DevToolsActivePort 读。绝不附着现成的 Chrome，
// 拿不到就直接退出 —— 上一轮固定 9417 被两个进程共用，跑出一组串台假红。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

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
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
                       "Cache-Control":"no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-mfa-"));
const CHROME = process.env.CHROME_PATH || process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0",
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP *.supabase.co 0.0.0.0, MAP *.supabase.in 0.0.0.0",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

/** 本进程自己那个 Chrome 分到的调试端口。读它自己的 DevToolsActivePort，
    绝不去猜、也绝不去连别人已经开着的调试端口。拿不到就让整个套件失败退出。 */
async function ownDebugPort() {
  const f = path.join(prof, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    try {
      const t = fs.readFileSync(f, "utf8").split("\n")[0].trim();
      const n = Number(t);
      if (Number.isInteger(n) && n > 0) return n;
    } catch (e) { /* 还没写出来 */ }
    if (chrome.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error("没能从自己的 Chrome 取得独占调试端口（DevToolsActivePort 未出现）。" +
    "本套件**不附着**任何现成的 Chrome，直接退出。");
}

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
    if (!url) throw new Error("连不上自己的 Chrome 调试端口 " + port);
    const s = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
    const c = new Cdp(s);
    s.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method && c.handlers.has(m.method)) c.handlers.get(m.method)(m.params); };
    return c;
  }
  send(method, params = {}, ms = 30000) {
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
  async clickReal(sel) {
    const pt = await this.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null; el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,ok:!!hit&&(hit===el||el.contains(hit)||hit.contains(el)),dis:!!el.disabled};})()`);
    if (!pt) throw new Error("找不到 " + sel);
    if (!pt.ok) throw new Error("点没命中 " + sel);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await sleep(340);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const CFG = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';

// ── fixture：全部是明显的假数据，不是任何真实因子/密钥/二维码 ──────────
const FIX_SECRET = "FIXTURE-NOT-A-REAL-SECRET";
const FIX_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='190' height='190'><rect width='190' height='190' fill='%23fff'/></svg>";
const FIX_QR = "data:image/svg+xml;utf-8," + FIX_SVG;   // ← 与 2.116.0 产物一致的形状

/** 假客户端。按 §契约 ①②③④ 仿真，不多不少。
    __SCEN:
      factors      listFactors 的原始因子表（含 status，stub 自己按 verified 过滤出 totp）
      aal          当前 AAL
      enrollError  enroll 返回的错误
      chError/vfError  challenge / verify 返回的 AuthError（{status, message}）
      chThrow/vfThrow  challenge / verify **抛出**的非 AuthError（断网形态）
      slow         { challenge|verify|enroll|listFactors|aal: 毫秒 }
      killAfter    毫秒后发一次 SIGNED_OUT */
const STUB = `
window.supabase = {
  createClient: function(){
    var reply = function(v){ return Promise.resolve(v); };
    var S = function(){ return window.__SCEN || {}; };
    var ss = function(k){ try { return sessionStorage.getItem(k); } catch (e) { return null; } };
    var set = function(k,v){ try { sessionStorage.setItem(k,v); } catch (e) {} };
    /* 计数器必须**跨导航存活**：验证成功后页面会跳走，写在 window 上的
       计数随旧文档一起没了，读出来是 undefined —— 断言不是变红，是直接崩。 */
    var bump = function(k){
      try { var o = JSON.parse(sessionStorage.getItem("mfaCalls") || "{}");
            o[k] = (o[k] || 0) + 1; sessionStorage.setItem("mfaCalls", JSON.stringify(o)); } catch (e) {}
    };
    var noteVerify = function(fid){
      try { var a = JSON.parse(sessionStorage.getItem("mfaVerifiedWith") || "[]");
            a.push(fid); sessionStorage.setItem("mfaVerifiedWith", JSON.stringify(a)); } catch (e) {}
    };

    var wait = function(key){
      var ms = (S().slow || {})[key] || 0;
      return ms ? new Promise(function(r){ setTimeout(r, ms); }) : Promise.resolve();
    };
    var authErr = function(o){
      var e = new Error(o.message || "auth error");
      e.__isAuthError = true; e.name = o.name || "AuthApiError"; e.status = o.status;
      return e;
    };

    window.__authSubs = window.__authSubs || [];
    window.__fireAuth = function(ev, sess){
      if (ev === "SIGNED_OUT") set("sessionDead", "1");
      (window.__authSubs || []).slice().forEach(function(f){ try { f(ev, sess || null); } catch (e) {} });
    };
    if (S().killAfter) setTimeout(function(){ window.__fireAuth("SIGNED_OUT"); }, S().killAfter);

    return {
      auth: {
        getSession: function(){
          return reply({ data: { session: ss("sessionDead") === "1" ? null
            : { user: { id: "u-fixture" }, access_token: "fixture-token" } } });
        },
        onAuthStateChange: function(cb){
          window.__authSubs.push(cb);
          return { data: { subscription: { unsubscribe: function(){
            var i = window.__authSubs.indexOf(cb); if (i > -1) window.__authSubs.splice(i, 1);
          } } } };
        },
        signOut: function(){ set("sessionDead","1"); window.__fireAuth("SIGNED_OUT"); return reply({}); },
        mfa: {
          getAuthenticatorAssuranceLevel: function(){
            return wait("aal").then(function(){
              var a = ss("verified") === "1" ? "aal2" : (S().aal || "aal1");
              return { data: { currentLevel: a, nextLevel: "aal2" }, error: null };
            });
          },
          /* 契约②：data.totp 只含 verified；未验证的只在 data.all 里 */
          listFactors: function(){
            bump("listFactors");
            return wait("listFactors").then(function(){
              var raw = S().factors || [];
              var out = { all: [], phone: [], totp: [], webauthn: [], recovery_code: [] };
              raw.forEach(function(f){
                out.all.push(f);
                if (f.status === "verified" && Array.isArray(out[f.factor_type])) out[f.factor_type].push(f);
              });
              return { data: out, error: null };
            });
          },
          /* 契约①：qr_code 是 data URI，不是内联 SVG */
          enroll: function(){
            bump("enroll");
            return wait("enroll").then(function(){
              if (S().enrollError) return { data: null, error: authErr(S().enrollError) };
              return { data: { id: "fixture-totp-new", type: "totp",
                totp: { qr_code: ${JSON.stringify(FIX_QR)}, secret: ${JSON.stringify(FIX_SECRET)},
                        uri: "otpauth://totp/fixture" } }, error: null };
            });
          },
          unenroll: function(){ bump("unenroll"); return reply({ data: {}, error: null }); },
          challenge: function(a){
            bump("challenge");
            var fid = a && a.factorId;
            return wait("challenge").then(function(){
              /* 契约③：非 AuthError 是**抛出**的 */
              if (S().chThrow) throw new TypeError("Failed to fetch");
              if (S().chError) return { data: null, error: authErr(S().chError) };
              return { data: { id: "fixture-challenge", factorId: fid }, error: null };
            });
          },
          verify: function(a){
            bump("verify");
            noteVerify(a && a.factorId);
            return wait("verify").then(function(){
              if (S().vfThrow) throw new TypeError("Failed to fetch");
              if (S().vfError) return { data: null, error: authErr(S().vfError) };
              set("verified", "1");          // 契约④：verify 成功后会话真的升到 aal2
              return { data: { access_token: "fixture-token-aal2" }, error: null };
            });
          }
        }
      },
      from: function(){ var q = { select:function(){return q;}, eq:function(){return q;},
        order:function(){return q;}, limit:function(){return q;}, maybeSingle:function(){return q;},
        then:function(r){ return Promise.resolve({ data: [], error: null }).then(r); } }; return q; },
      rpc: function(name){
        if (name === "my_roles") return reply({ data: [{ role: "teacher" }], error: null });
        if (name === "my_profile") return reply({ data: { display_name: "测试用户", email: "a@example.invalid" }, error: null });
        return reply({ data: null, error: null });
      },
      functions: { invoke: function(){ return reply({ data: null, error: null }); } }
    };
  }
};`;

let port;
try {
  port = await ownDebugPort();
  console.log("  独占调试端口（本进程自己的 Chrome 分配）: " + port);
} catch (e) {
  chrome.kill(); server.close();
  console.error("  " + e.message);
  process.exit(1);
}

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 820, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("cdn.jsdelivr.net") > -1 && u.indexOf("supabase-js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" },
                            { name: "Cache-Control", value: "no-store" }], body: b64(STUB) });
        return;
      }
      if (u.indexOf("supabase-config.js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" },
                            { name: "Cache-Control", value: "no-store" }], body: b64(CFG) });
        return;
      }
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });

  const navLog = [];
  cdp.on("Page.frameNavigated", (p) => {
    if (p.frame && !p.frame.parentId) navLog.push(String(p.frame.url || ""));
  });

  const MFA = "portal/mfa/?next=%2Fhelp%2F";
  const open = async (scen, wait, page) => {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__SCEN = " + JSON.stringify(scen) + ";",
    });
    await cdp.ev(`(()=>{try{["sessionDead","verified","mfaCalls","mfaVerifiedWith"].forEach(k=>sessionStorage.removeItem(k));}catch(e){} return true;})()`).catch(() => {});
    navLog.length = 0;
    await cdp.send("Page.navigate", { url: `${BASE}/${page || MFA}` });
    await sleep(wait || 2200);
  };
  const txt = async () => cdp.ev(`(()=>{const c=document.body.cloneNode(true);
    c.querySelectorAll("script,style,template").forEach(n=>n.remove());
    return (c.textContent||"").replace(/\\s+/g," ").trim();})()`);
  const calls = async () => {
    const c = (await cdp.ev(`(()=>{try{return JSON.parse(sessionStorage.getItem("mfaCalls")||"{}");}catch(e){return {};}})()`)) || {};
    return { enroll: c.enroll||0, challenge: c.challenge||0, verify: c.verify||0,
             listFactors: c.listFactors||0, unenroll: c.unenroll||0 };
  };
  const verifiedWith = async () =>
    (await cdp.ev(`(()=>{try{return JSON.parse(sessionStorage.getItem("mfaVerifiedWith")||"[]");}catch(e){return [];}})()`)) || [];
  const typeCode = async (sel, v) => cdp.ev(`(()=>{const e=document.getElementById(${JSON.stringify(sel)});
    if(!e) return false; e.value=${JSON.stringify(v)}; return true;})()`);

  const UNVERIFIED = [{ id: "fixture-totp-pending", factor_type: "totp", status: "unverified", friendly_name: "AMAS TOTP" }];
  const VERIFIED  = [{ id: "fixture-totp-ok", factor_type: "totp", status: "verified", friendly_name: "AMAS TOTP" }];

  // ════════ Q 二维码与密钥的呈现 ════════
  console.log("\n=== Q 注册卡：二维码与密钥 ===");
  await open({ aal: "aal1", factors: [] });
  const q = await cdp.ev(`(()=>{
    const box = document.getElementById("qrBox");
    const img = box.querySelector("img");
    const svg = box.querySelector("svg");
    return { text: (box.textContent||"").trim().slice(0,60),
             hasImg: !!img, imgSrc: img ? String(img.getAttribute("src")||"").slice(0,40) : null,
             hasSvg: !!svg, secret: (document.getElementById("secretBox").textContent||"").trim() };
  })()`);
  ok("Q1 二维码真的渲染成图片（可扫）", q.hasImg === true && /^data:image\/svg\+xml/.test(q.imgSrc || ""),
     JSON.stringify(q));
  ok("Q2 页面上不出现 data:image/svg+xml 这段前缀文本", q.text.indexOf("data:image") === -1, JSON.stringify(q));
  ok("Q3 手动输入用的密钥照常显示", q.secret === FIX_SECRET, JSON.stringify(q));
  const src = await cdp.ev(`(async()=>{const t=await (await fetch("${BASE}/portal/mfa/index.html")).text();
    return { innerHTMLQr: /qrBox"\\)\\.innerHTML/.test(t) || /qrBox"\\)\\s*\\.innerHTML/.test(t) };})()`);
  ok("Q4 不再用 innerHTML 把服务端返回的串塞进 DOM", src.innerHTMLQr === false, JSON.stringify(src));

  // ════════ P 已存在「没做完」的因子（本轮核心）════════
  console.log("\n=== P 上次开了头没做完的因子 ===");
  await open({ aal: "aal1", factors: UNVERIFIED });
  const p1 = await calls();
  ok("P1 不再新建因子（看得见 all 里那个未验证的）", p1.enroll === 0, JSON.stringify(p1));
  /* 只读**当前显示的那张卡**：body.textContent 连 hidden 节点一起收，
     而挑战卡里本来就写着那个邮箱 —— 不收紧的话 P2b 修前就绿，是空转。 */
  const p2 = await cdp.ev(`(()=>{const c=document.getElementById("cardEnroll");
    if(!c||c.hidden) return "";
    const k=c.cloneNode(true); k.querySelectorAll("[hidden]").forEach(n=>n.remove());
    return (k.textContent||"").replace(/\\s+/g," ").trim();})()`);
  ok("P2 如实说明上次没做完，并给出继续的路",
     /没有完成|没完成|上次/.test(p2) && /动态码|验证器/.test(p2), p2.slice(0, 200));
  ok("P2b 同时给出「验证器已经删掉了怎么办」的出口（沿用既有人工核验规范）",
     /amasthai2026@gmail\.com/.test(p2), p2.slice(0, 260));
  await typeCode("enCode", "123456");
  await cdp.clickReal("#btnEnroll");
  await sleep(1600);
  const p3 = await verifiedWith();
  ok("P3 验证打在**那个已存在的因子**上，不是新建的",
     Array.isArray(p3) && p3.length === 1 && p3[0] === "fixture-totp-pending", JSON.stringify(p3));
  ok("P4 全程没有调用 unenroll（不自动删除任何因子）", (await calls()).unenroll === 0, JSON.stringify(await calls()));

  // ════════ E enroll 失败 ════════
  console.log("\n=== E 初始化注册失败 ===");
  await open({ aal: "aal1", factors: [], enrollError: { status: 422, message: 'A factor with the friendly name AMAS TOTP for this user already exists' } });
  const e1 = await txt();
  ok("E1 给的是可读的中文说明，不是把英文原文抛给用户",
     /无法|没能|暂时/.test(e1) && !/friendly name/i.test(e1), e1.slice(0, 220));
  const e2 = await cdp.ev(`(()=>{
    const f = document.getElementById("enrollForm");
    const btn = document.getElementById("btnEnroll");
    return { formHidden: !f || f.hidden || f.closest("[hidden]") !== null,
             retry: !!document.getElementById("enRetry") };
  })()`);
  ok("E2 初始化都没成功时不留一个点了会静默重载页面的表单，并给出重试出口",
     e2.formHidden === true && e2.retry === true, JSON.stringify(e2));

  // ════════ R 重复提交 ════════
  console.log("\n=== R 重复提交 ===");
  await open({ aal: "aal1", factors: VERIFIED, slow: { challenge: 700, verify: 700 } });
  ok("R0 前提：已验证因子 → 停在挑战卡", /请完成两步验证/.test(await txt()));
  await typeCode("chCode", "123456");
  await cdp.clickReal("#btnCh");
  const rBusy = await cdp.ev(`(()=>{const b=document.getElementById("btnCh");
    return { disabled: !!b.disabled, label: (b.textContent||"").trim() };})()`);
  ok("R1 进行中按钮禁用", rBusy.disabled === true, JSON.stringify(rBusy));
  ok("R2 进行中有「正在做」的反馈，不是毫无动静", /验证中|处理中|…/.test(rBusy.label), JSON.stringify(rBusy));
  /* 第二次不点按钮，直接 requestSubmit：绕开「按钮已被禁用」这一层，
     量的是处理器**自己**的进行中闸。只靠 disabled 的话，键盘回车、
     自动填充、脚本触发的提交都还是会打进来。 */
  await cdp.ev(`(()=>{const f=document.getElementById("chForm"); if(f) f.requestSubmit(); return true;})()`);
  await sleep(2600);
  const rc = await calls();
  ok("R3 连点两次也只发出一次 challenge/verify（TOTP 码一次性，第二次必然误报「码不对」）",
     rc.challenge === 1 && rc.verify === 1, JSON.stringify(rc));

  // ════════ N 网络 / 异常 / 超时 / 限流 ════════
  console.log("\n=== N 连不上 ≠ 码不对 ===");
  await open({ aal: "aal1", factors: VERIFIED, vfThrow: true });
  await typeCode("chCode", "123456");
  await cdp.clickReal("#btnCh");
  await sleep(1400);
  const n1 = await cdp.ev(`(()=>{const e=document.getElementById("chErr");
    const b=document.getElementById("btnCh");
    return { msg:(e.textContent||"").trim(), shown:e.classList.contains("show"), btnDisabled:!!b.disabled };})()`);
  ok("N1 verify 抛出（断网）时页面说话，不静默", n1.shown === true && n1.msg.length > 0, JSON.stringify(n1));
  ok("N2 且不谎称「动态码不正确」", !/动态码不正确/.test(n1.msg), JSON.stringify(n1));
  ok("N3 按钮恢复可用 —— 错误不是单向门", n1.btnDisabled === false, JSON.stringify(n1));

  await open({ aal: "aal1", factors: VERIFIED, chThrow: true });
  await typeCode("chCode", "123456");
  await cdp.clickReal("#btnCh");
  await sleep(1400);
  const n4 = await cdp.ev(`(()=>{const e=document.getElementById("chErr");
    return { msg:(e.textContent||"").trim(), shown:e.classList.contains("show") };})()`);
  ok("N4 challenge 抛出时同样说话、同样不赖到动态码上",
     n4.shown === true && !/动态码不正确/.test(n4.msg), JSON.stringify(n4));

  await open({ aal: "aal1", factors: VERIFIED, vfError: { status: 429, message: "rate limit" } });
  await typeCode("chCode", "123456");
  await cdp.clickReal("#btnCh");
  await sleep(1400);
  const n5 = await cdp.ev(`(()=>({msg:(document.getElementById("chErr").textContent||"").trim()}))()`);
  ok("N5 429 说的是「太频繁」，不是「码不对」",
     /频繁|稍等|稍后/.test(n5.msg) && !/动态码不正确/.test(n5.msg), JSON.stringify(n5));

  await open({ aal: "aal1", factors: VERIFIED, vfError: { status: 422, message: "Invalid TOTP code entered" } });
  await typeCode("chCode", "123456");
  await cdp.clickReal("#btnCh");
  await sleep(1400);
  const n6 = await cdp.ev(`(()=>({msg:(document.getElementById("chErr").textContent||"").trim()}))()`);
  ok("N6 真的码错时仍然如实说码不对（没有矫枉过正）", /动态码/.test(n6.msg), JSON.stringify(n6));

  console.log("  （N7 超时用例要等页面自己的超时闸，约 17 秒）");
  await open({ aal: "aal1", factors: VERIFIED, slow: { challenge: 99000 } });
  await typeCode("chCode", "123456");
  await cdp.clickReal("#btnCh");
  await sleep(17000);
  const n7 = await cdp.ev(`(()=>{const e=document.getElementById("chErr");
    const b=document.getElementById("btnCh");
    return { msg:(e.textContent||"").trim(), shown:e.classList.contains("show"), btnDisabled:!!b.disabled };})()`);
  ok("N7 一直没有结果时有兜底提示，不是永远卡在「验证中…」",
     n7.shown === true && n7.msg.length > 0, JSON.stringify(n7));
  ok("N7 措辞是「还不确定」而不是断定码错", !/动态码不正确/.test(n7.msg), JSON.stringify(n7));
  ok("N7 按钮恢复可用", n7.btnDisabled === false, JSON.stringify(n7));

  // ════════ A 回跳 / 会话 / 闸门（round1+2 成果的定向回归）════════
  console.log("\n=== A 回跳与闸门 ===");
  await open({ aal: "aal2", factors: VERIFIED });
  ok("A1 已经是 aal2 → 直接回跳到 next", navLog.some((u) => /\/help\//.test(u)), JSON.stringify(navLog.slice(0, 3)));

  await open({ aal: "aal1", factors: VERIFIED });
  await typeCode("chCode", "123456");
  await cdp.clickReal("#btnCh");
  await sleep(2000);
  ok("A2 验证通过后回到 next（端到端）",
     (await cdp.ev(`location.pathname`)) === "/help/", "落点=" + (await cdp.ev(`location.pathname`)));

  await open({ aal: "aal1", factors: VERIFIED, slow: { verify: 1200 } });
  await typeCode("chCode", "123456");
  await cdp.clickReal("#btnCh");
  await cdp.ev(`(()=>{window.__fireAuth("SIGNED_OUT");return true;})()`);
  await sleep(3000);
  ok("A3 verify 期间会话失效 → 不拿死会话回跳进受保护区（round1 成果没被改坏）",
     !navLog.some((u) => /\/help\//.test(u)), JSON.stringify(navLog.slice(0, 4)));

  await open({ aal: "aal1", factors: [] });
  ok("A4 aal1 且一个因子都没有时不放行，停在注册卡（要求没降低）",
     /启用两步验证/.test(await txt()) && !navLog.some((u) => /\/help\//.test(u)));

  // ════════ G 隐私与外发 ════════
  console.log("\n=== G 隐私与外发 ===");
  ok("G1 全程没有一个请求到达真实 supabase 域名", externalHits === 0, "命中 " + externalHits + " 次");
  ok("G2 全程一次都没有调用 unenroll（不自动删除真实因子）",
     (await calls()).unenroll === 0, JSON.stringify(await calls()));

  cdp.ws.close();
} finally {
  chrome.kill(); server.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  全程本机 stub + 明确伪造的 fixture 因子/密钥：");
console.log("  无真实 MFA 因子、无真实密钥、无真实二维码、无远端写入、无外网请求。");
console.log("  绿灯只证明「给定这些返回值时客户端状态机做对了事」，不证明真实 MFA 已验收。");
process.exit(fail ? 1 : 0);
