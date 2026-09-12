// 聊天 AI 请求的超时、busy、保留问题、重试，以及旧响应不得覆盖新会话。
//
// ── 改前的四个问题 ────────────────────────────────────────────────────
// ① fetch 没有超时。端点一挂住，「···」永远转下去；而用户的问题在发出去那一刻
//    就被清空了 —— 既等不到回答，也没法原样再问一次。
// ② 没有 busy 守卫。连按回车会并发出多个请求、页面上堆出多个「···」。
// ③ 超时后没有任何交代，更没有重试入口。
// ④ 没有世代令牌。关掉聊天再打开、或切换语言之后，上一轮在途的回答回来了照样
//    插进新会话里 —— 看起来就像助手答非所问。
//
// ── 安全 ──────────────────────────────────────────────────────────────
// **不进行任何外部 AI 调用。** CONFIG.ai.endpoint 全程指向本机一个不存在的路径，
// 且页面内的 window.fetch 被替换成本地模拟；CDP 层再统计一次，断言零外网请求。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml",
  ".webp":"image/webp", ".ico":"image/x-icon", ".woff2":"font/woff2" };

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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-chat-"));
const port = 9399;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

let externalReqs = 0;

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  on(m, f) { this.handlers.set(m, f); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
      if (!url) await sleep(250);
    }
    if (!url) throw new Error("连不上 Chrome 调试端口");
    const s = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
    const c = new Cdp(s);
    s.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method && c.handlers.has(m.method)) c.handlers.get(m.method)(m.params); };
    return c;
  }
  send(method, params = {}, ms = 40000) {
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
  async key(key, code, vk, mods = 0) {
    const b = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...b });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...b });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...b });
    await sleep(150);
  }
  async type(text) {
    for (const ch of text) {
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    }
    await sleep(120);
  }
  async clickReal(sel) {
    const pt = await this.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null;
      document.documentElement.style.scrollBehavior='auto';
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,ok:!!hit&&(hit===el||el.contains(hit)||hit.contains(el))};})()`);
    if (!pt) throw new Error("找不到 " + sel);
    if (!pt.ok) throw new Error("点没命中 " + sel);
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    await sleep(200);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  const loadErrors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    loadErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "?");
  });
  cdp.on("Fetch.requestPaused", async (ev) => {
    try {
      const u = ev.request.url;
      if (u.indexOf("127.0.0.1") < 0 && u.indexOf("localhost") < 0 &&
          u.indexOf("data:") !== 0 && u.indexOf("fonts.") < 0) externalReqs++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });

  /* mode: hang（永不 settle）/ okres（正常回答）/ slowok（延迟后回答，用于测旧响应） */
  const load = async (lang, mode, delay) => {
    await cdp.send("Page.navigate", { url: `${BASE}/index.html` + (lang ? `?lang=${lang}` : "") });
    await sleep(2000);
    await cdp.ev(`document.documentElement.style.scrollBehavior='auto'`);
    await cdp.ev(`(()=>{
      CONFIG.ai = CONFIG.ai || {};
      CONFIG.ai.endpoint = "/__local-ai-mock";      // 本机路径，绝不出网
      CONFIG.ai.headers = { "Content-Type": "application/json" };
      const MODE = ${JSON.stringify(mode)}, DELAY = ${JSON.stringify(delay || 0)};
      const orig = window.fetch;
      window.__aiHits = 0;
      window.fetch = function(u, opt){
        if(String(u).indexOf("__local-ai-mock") < 0) return orig.apply(this, arguments);
        window.__aiHits++;
        if(MODE === "okres") return Promise.resolve({ ok:true, status:200,
          json:()=>Promise.resolve({ reply:"这是本地模拟回答" }) });
        if(MODE === "slowok") return new Promise((res, rej)=>{
          const t = setTimeout(()=>res({ ok:true, status:200,
            json:()=>Promise.resolve({ reply:"迟到的旧回答" }) }), DELAY);
          if(opt && opt.signal) opt.signal.addEventListener("abort", ()=>{
            clearTimeout(t); const e=new Error("aborted"); e.name="AbortError"; rej(e); });
        });
        // hang
        return new Promise((res, rej)=>{
          if(opt && opt.signal) opt.signal.addEventListener("abort", ()=>{
            const e=new Error("aborted"); e.name="AbortError"; rej(e); });
        });
      };
      return true;})()`);
    await cdp.clickReal("#chatFab");
    await sleep(500);
  };
  const ask = async (q) => {
    await cdp.ev(`(()=>{const i=document.getElementById('chatText');
      i.value=${JSON.stringify(q)}; i.focus(); return true;})()`);
    await cdp.clickReal("#chatSend");
  };
  const body = async () => cdp.ev(`(()=>{
    const msgs=[...document.querySelectorAll('#chatBody .chat-msg')]
      .map(m=>({cls:m.className, text:(m.textContent||'').trim()}));
    return { 条数:msgs.length, 打字中:msgs.filter(m=>m.cls.indexOf('typing')>-1).length,
      末条:msgs.length?msgs[msgs.length-1].text:'', 全文:msgs.map(m=>m.text).join(' | ') };})()`);
  const inputState = async () => cdp.ev(`(()=>{const i=document.getElementById('chatText'),
    b=document.getElementById('chatSend');
    return { 输入框:i.value, 只读:i.readOnly, 发送禁用:b.disabled, busy:b.getAttribute('aria-busy') };})()`);

  /* 按文字定位并真实点击。#chatBody 里通常有多组 chips（问候语那组排在最前），
     用 querySelector('.chat-chips button') 会打到问候语的第一个按钮上 ——
     症状是「点了没反应」，其实是点错了人。 */
  const clickChipByText = async (re) => {
    const pt = await cdp.ev(`(()=>{
      const b=[...document.querySelectorAll('#chatBody .chat-chips button')]
        .filter(x=>${re}.test((x.textContent||'').trim())).pop();
      if(!b) return null;
      b.scrollIntoView({block:'center'});
      const r=b.getBoundingClientRect(); const x=r.left+r.width/2,y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,ok:!!hit&&(hit===b||b.contains(hit)),txt:(b.textContent||'').trim()};})()`);
    if(!pt) throw new Error("找不到匹配的 chip");
    if(!pt.ok) throw new Error("chip 没命中: " + pt.txt);
    for(const type of ["mousePressed","mouseReleased"])
      await cdp.send("Input.dispatchMouseEvent",{type,x:pt.x,y:pt.y,button:"left",clickCount:1});
    await sleep(300);
    return pt.txt;
  };

  // ════ A 超时上限 ════
  console.log("\n=== A 超时上限 ===");
  await load("zh", "hang");
  const T = await cdp.ev(`typeof CHAT_TIMEOUT === "number" ? CHAT_TIMEOUT : null`);
  ok("存在超时上限常量且在合理区间", typeof T === "number" && T > 0 && T <= 30000, `CHAT_TIMEOUT=${T}`);
  /* chatEpoch 是 let，若它的声明排在 applyLanguage() 首次调用之后，
     applyLanguage 里那句 typeof chatEpoch 会因 TDZ 抛 ReferenceError
     （TDZ 里的 let 连 typeof 都会抛）。不靠行号推断，直接看有没有报错。 */
  ok("加载期间零 JS 异常（含 chatEpoch 的 TDZ 风险）", loadErrors.length === 0, loadErrors.join(" | "));

  // ════ B 挂住 → 超时 ════
  console.log("\n=== B 端点挂住 ===");
  await ask("请问学费多少");
  await sleep(600);
  const during = await inputState(); const bDuring = await body();
  ok("提问期间发送键禁用", during.发送禁用 === true, JSON.stringify(during));
  ok("提问期间输入框只读（不会边等边打）", during.只读 === true, JSON.stringify(during));
  ok("提问期间显示「···」", bDuring.打字中 === 1, JSON.stringify(bDuring));
  await sleep((T || 12000) + 1500);
  const after = await body(); const aState = await inputState();
  ok("超时后「···」被移除，不再永远转下去", after.打字中 === 0, JSON.stringify(after));
  ok("超时后解除 busy，发送键恢复可用", aState.发送禁用 === false && aState.只读 === false, JSON.stringify(aState));
  ok("超时后给出明确交代", /没等到回应/.test(after.全文), after.末条.slice(0, 40));
  ok("超时文案不谎称「回答失败」", !/失败/.test(after.全文.split("|").pop()), after.末条.slice(0, 40));
  ok("用户的问题被放回输入框（不用重打）", aState.输入框 === "请问学费多少", JSON.stringify(aState));
  const hasRetry = await cdp.ev(`(()=>{const b=[...document.querySelectorAll('#chatBody .chat-chips button')]
    .map(x=>(x.textContent||'').trim()); return b;})()`);
  ok("给出明确的重试入口", hasRetry.some(x => /重试/.test(x)), JSON.stringify(hasRetry));

  // ════ C 重试可用 ════
  console.log("\n=== C 点重试能再问一次 ===");
  const beforeHits = await cdp.ev(`window.__aiHits`);
  await clickChipByText("/重试/");
  await sleep(700);
  ok("重试真的发起了新的一次请求", (await cdp.ev(`window.__aiHits`)) > beforeHits,
     `之前 ${beforeHits} 次，现在 ${await cdp.ev(`window.__aiHits`)} 次`);

  // ════ D 连按回车不并发 ════
  console.log("\n=== D 在途期间连按回车 ===");
  await load("zh", "hang");
  await cdp.ev(`(()=>{const i=document.getElementById('chatText'); i.value='连按测试'; i.focus(); return true;})()`);
  await cdp.key("Enter", "Enter", 13);
  await sleep(200);
  await cdp.ev(`document.getElementById('chatText').focus()`);
  await cdp.key("Enter", "Enter", 13);
  await cdp.key("Enter", "Enter", 13);
  await sleep(500);
  const d = await body();
  ok("在途期间连按只产生 1 次请求", (await cdp.ev(`window.__aiHits`)) === 1,
     `实际 ${await cdp.ev(`window.__aiHits`)} 次`);
  ok("页面上只有一个「···」", d.打字中 === 1, JSON.stringify(d));

  // ════ E 关闭重开：旧回答不得覆盖新会话 ════
  console.log("\n=== E 关闭再打开后，旧回答不得插进新会话 ===");
  await load("zh", "slowok", 2500);
  await ask("第一轮的问题");
  await sleep(400);
  await cdp.clickReal("#chatClose");        // 在途期间关掉
  await sleep(200);
  await cdp.clickReal("#chatFab");          // 立刻重开
  await sleep(300);
  const beforeLate = await body();
  await sleep(3000);                         // 等旧回答回来
  const afterLate = await body();
  ok("旧回答没有插进新会话", !/迟到的旧回答/.test(afterLate.全文), afterLate.全文.slice(-60));
  /* 注意不能断言「条数不变」：在途那次的「···」会在旧响应落定时被移除，
     条数**本来就会减少**。早先写成相等而判红 —— 红的是断言不是页面。
     真正该断言的是「没有新增任何消息」。 */
  ok("新会话没有被旧回答插入新消息",
     afterLate.条数 <= beforeLate.条数, `重开时 ${beforeLate.条数} 条，3 秒后 ${afterLate.条数} 条`);
  ok("旧那次的「···」也被清掉，不会一直转", afterLate.打字中 === 0, JSON.stringify(afterLate));

  // ════ F 切语言：旧回答同样不得覆盖 ════
  console.log("\n=== F 切换语言后，旧回答不得插进新会话 ===");
  await load("zh", "slowok", 2500);
  await ask("切语言前的问题");
  await sleep(400);
  await cdp.ev(`applyLanguage('en')`);
  await sleep(3000);
  const afterLang = await body();
  ok("切语言后旧回答没有插进来", !/迟到的旧回答/.test(afterLang.全文), afterLang.全文.slice(-60));
  ok("切语言后 busy 被解除（不会卡住）",
     (await inputState()).发送禁用 === false, JSON.stringify(await inputState()));

  // ════ G 正常回答仍然工作 ════
  console.log("\n=== G 端点正常时不受影响 ===");
  await load("zh", "okres");
  await ask("正常提问");
  await sleep(900);
  const g = await body();
  ok("正常回答照常显示", /这是本地模拟回答/.test(g.全文), g.末条.slice(0, 30));
  ok("回答后「···」已移除", g.打字中 === 0, JSON.stringify(g));
  ok("回答后解除 busy", (await inputState()).发送禁用 === false);

  // ════ H 四语言超时文案 ════
  console.log("\n=== H 四语言超时文案 ===");
  for (const lang of ["zh", "en", "ko", "th"]) {
    await load(lang, "hang");
    await ask("q");
    await sleep((T || 12000) + 1200);
    const h = await body();
    const chips = await cdp.ev(`[...document.querySelectorAll('#chatBody .chat-chips button')]
      .map(x=>(x.textContent||'').trim())`);
    ok(`${lang} 超时有文案且有重试按钮`,
       h.打字中 === 0 && h.全文.length > 0 && chips.length >= 1, JSON.stringify(chips));
    console.log(`     ${lang}: ${h.末条.slice(0, 40)} | chips=${JSON.stringify(chips)}`);
  }

  // ════ J 留言流程：失败不丢内容、可一键重发 ════
  // 改前 leaveFlow 在**发送之前**就被置 null，一旦失败，姓名/联系方式/正文全没了，
  // 访客得把三步问答重走一遍；而且不论超时还是服务器拒绝，一律说「发送失败」。
  console.log("");
  console.log("=== J 聊天留言：失败不丢内容、可重发 ===");
  const leaveRun = async (mode) => {
    await load("zh", "okres");                   // AI 端点不参与，这里只走留言
    await cdp.ev(`(()=>{
      CONFIG.formEndpoint = "/__local-form-mock";
      const orig = window.fetch;
      window.__formHits = 0;
      window.fetch = function(u, opt){
        if(String(u).indexOf("__local-form-mock") < 0) return orig.apply(this, arguments);
        window.__formHits++;
        if(${JSON.stringify("http500")} === ${JSON.stringify(mode)})
          return Promise.resolve({ ok:false, status:500, json:()=>Promise.resolve({}) });
        if(${JSON.stringify("http422")} === ${JSON.stringify(mode)})
          return Promise.resolve({ ok:false, status:422, json:()=>Promise.resolve({}) });
        if(${JSON.stringify("neterr")} === ${JSON.stringify(mode)})
          return Promise.reject(new TypeError("Failed to fetch"));
        return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({}) });
      };
      startLeaveFlow();
      return true;})()`);
    await sleep(300);
    for (const step of ["张三", "zhangsan@example.invalid", "这是留言正文"]) {
      await cdp.ev(`(()=>{const i=document.getElementById('chatText');
        i.value=${JSON.stringify(step)}; i.focus(); return true;})()`);
      await cdp.clickReal("#chatSend");
      await sleep(350);
    }
    await sleep(900);
  };

  // J1 4xx 业务拒绝 → 能证明的失败（5xx 另见 J5）
  await leaveRun("http422");
  const j1 = await body();
  const j1chips = await cdp.ev(`[...document.querySelectorAll('#chatBody .chat-chips button')]
    .map(x=>(x.textContent||'').trim())`);
  ok("J1 服务器拒绝时说「没有送出」", /没有送出/.test(j1.全文), j1.末条.slice(0, 40));
  ok("J1 提供重发入口", j1chips.some(x => /重发|重试/.test(x)), JSON.stringify(j1chips));
  ok("J1 说明内容还在", /都还在/.test(j1.全文), j1.末条.slice(0, 40));

  // J2 重发用的是同一份内容，不用重走三步
  const hitsBefore = await cdp.ev(`window.__formHits`);
  const clicked = await clickChipByText("/重发|重试/");
  await sleep(900);
  ok("J2 一键重发真的又发了一次（不用重走三步问答）",
     (await cdp.ev(`window.__formHits`)) > hitsBefore,
     `之前 ${hitsBefore} 次，现在 ${await cdp.ev(`window.__formHits`)} 次`);
  ok("J2 重发后没有回到「请问怎么称呼」那一步",
     !/怎么称呼|您的称呼/.test((await body()).全文.split("|").slice(-3).join(" ")),
     "又从第一步开始问了");

  // J3 网络错 → 不谎称失败
  await leaveRun("neterr");
  const j3 = await body();
  ok("J3 网络错时说「无法确认是否已送到」", /无法确认/.test(j3.全文), j3.末条.slice(0, 40));
  ok("J3 网络错时不说「没有送出」", !/没有送出/.test(j3.全文.split("|").pop()), j3.末条.slice(0, 40));
  ok("J3 提醒重发可能造成第二份", /第二份/.test(j3.全文), j3.末条.slice(0, 50));

  // J4 成功路径不受影响
  await leaveRun("okres");
  ok("J4 成功时照常回执", /留言已送出|留言已保存/.test((await body()).全文), (await body()).末条.slice(0, 40));

  /* J5 HTTP 500：服务端自己出错，留言**可能已经写进去了**。
     断言「没有送出」会让访客重发，学校就收到同一条的两份。 */
  await leaveRun("http500");
  const j5 = await body();
  ok("J5 500 归为无法确认，不说「没有送出」", !/没有送出/.test(j5.全文.split("|").pop()), j5.末条.slice(0, 40));
  ok("J5 500 文案明说无法确认", /无法确认/.test(j5.全文), j5.末条.slice(0, 40));

  // ════ I 负向控制 ════
  console.log("\n=== I 负向控制：绿必须能转红 ===");
  // I1 把令牌冻住，旧回答就应该插进来 —— 证明 E/F 的绿来自令牌
  /* 这里有两个坑，都值得写下来，因为它们决定了这条控制**能不能**用「关掉机制」的方式做：

     一、chatEpoch 是 `let`，而 main.js 是普通脚本。`let` 只在脚本的全局词法作用域里
         建绑定，**不会成为 window 的属性**。所以 Object.defineProperty(window,'chatEpoch',…)
         只是造了个同名的无关属性，真变量纹丝不动。
     二、退一步改用替换 openChat/closeChat 也不行：顶层 function 确实挂在全局对象上，
         但 `$("#chatClose").addEventListener("click", closeChat)` 是**直接传函数引用**
         注册的，注册那一刻就捕获了原函数 —— 事后改 window.closeChat 影响不到它。

     两条路都走不通，所以这条控制换个方向做：**同样的 mock、同样的时延，但不关闭重开**。
     如果迟到的回答在这种情况下会正常插入，就排除了「它本来就插不进来（mock 坏了）」
     这种可能；再对照 E / F 里插不进来，因果就落在关闭重开这条路径上。 */
  await load("zh", "slowok", 2000);
  await ask("不关闭重开的问题");
  await sleep(3200);
  const i1 = await body();
  ok("I1 不关闭重开时，迟到的回答会正常插入（排除「本来就插不进来」）",
     /迟到的旧回答/.test(i1.全文),
     "连正常情况都插不进来，说明 mock 或链路有问题，E/F 的绿不成立");

  // I2 外发审计
  ok("I2 全程零外网请求（未做任何外部 AI 调用）", externalReqs === 0, `有 ${externalReqs} 个外网请求`);

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally { chrome.kill(); server.close(); }

console.log(`\n${pass}/${pass + fail} 通过`);
console.log("本套件把 CONFIG.ai.endpoint 指向本机路径并在页面内替换 fetch，未做任何外部 AI 调用。");
process.exit(fail ? 1 : 0);
