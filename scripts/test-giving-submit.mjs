// giving.html 奉献/同工意愿提交的超时与诚实反馈。
//
// ── 判据的核心：不要承诺你证明不了的事 ────────────────────────────────
// 改前只有两态：拿到 2xx 就说「已收到」，其余一律「发送失败，请稍后再试」。
// 问题在于「其余」里混了三种完全不同的情况：
//   ① 服务器回了非 2xx —— 我们**拿到了回应**，确实没送达，说失败没问题。
//   ② 网络层出错（TypeError）—— 没拿到回应。请求**可能已经送到了**。
//   ③ 超时 —— 同上，而且改前根本没有超时，会一直挂着。
// 对 ② ③ 说「发送失败，请稍后再试」既证明不了，照做还会让学校收到两份一样的内容。
// 所以现在是三态：fail（能证明的失败）/ unsure / timeout（都只说「无法确认」）。
//
// ── 安全 ──────────────────────────────────────────────────────────────
// 三重阻断，绝不允许任何请求真的到达 formsubmit.co：
//   ① 浏览器级 host-resolver 把 formsubmit.co 解析到 0.0.0.0
//   ② CDP Fetch 拦截并计数
//   ③ 页面内替换 window.fetch，发往 formsubmit 的请求一律本地模拟
// 本页是「留下联系方式」的意愿表单，不涉及任何实际支付；本套件也不进行任何真实提交。
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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-giving-"));
const port = 9398;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP formsubmit.co 0.0.0.0, MAP *.formsubmit.co 0.0.0.0",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

let reachedFormsubmit = 0;

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
  cdp.on("Fetch.requestPaused", async (ev) => {
    try {
      if (ev.request.url.indexOf("formsubmit.co") > -1) {
        reachedFormsubmit++;
        await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" });
        return;
      }
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });

  /* mode 决定页面内被替换掉的 fetch 如何模拟：
       hang    永不 settle（配合 AbortController 才会结束）→ 超时
       neterr  立刻抛 TypeError                            → 网络层出错
       http500 返回 res.ok === false                        → 服务器明确拒绝
       okres   返回 2xx                                      → 成功 */
  const load = async (lang, mode) => {
    await cdp.send("Page.navigate", { url: `${BASE}/giving.html` + (lang ? `?lang=${lang}` : "") });
    await sleep(1900);
    await cdp.ev(`document.documentElement.style.scrollBehavior='auto'`);
    await cdp.ev(`(()=>{
      const MODE = ${JSON.stringify(mode)};
      const orig = window.fetch;
      window.__hits = 0;
      window.fetch = function(u, opt){
        if(String(u).indexOf("formsubmit.co") < 0) return orig.apply(this, arguments);
        window.__hits++;
        if(MODE === "neterr")  return Promise.reject(new TypeError("Failed to fetch"));
        if(MODE === "http500") return Promise.resolve({ ok:false, status:500, json:()=>Promise.resolve({}) });
        if(MODE === "http422") return Promise.resolve({ ok:false, status:422, json:()=>Promise.resolve({}) });
        if(MODE === "okres")   return Promise.resolve({ ok:true, status:200, json:()=>Promise.resolve({}) });
        // hang：永不 settle，只有 abort 能结束它
        return new Promise((res, rej)=>{
          if(opt && opt.signal) opt.signal.addEventListener("abort", ()=>{
            const e=new Error("aborted"); e.name="AbortError"; rej(e);
          });
        });
      };
      return true;})()`);
  };
  const fillForm = async () => cdp.ev(`(()=>{
    const f=document.getElementById('gvForm');
    f.querySelector('[name=name]').value='测试访客';
    f.querySelector('[name=contact]').value='local@example.invalid';
    const msg=f.querySelector('[name=message]'); if(msg) msg.value='本地测试，请勿处理';
    return true;})()`);
  const st = async () => cdp.ev(`(()=>{const s=document.getElementById('gvStatus');
    return { state:s.dataset.state||"", 文案:(s.textContent||'').trim() };})()`);
  const btn = async () => cdp.ev(`(()=>{const b=document.querySelector('#gvForm button[type=submit]');
    return { disabled:b.disabled, busy:b.getAttribute('aria-busy') };})()`);
  const vals = async () => cdp.ev(`(()=>{const f=document.getElementById('gvForm');
    return { name:f.querySelector('[name=name]').value, contact:f.querySelector('[name=contact]').value };})()`);

  // ════ A 超时上限存在 ════
  console.log("\n=== A 超时上限 ===");
  await load("zh", "hang");
  const T = await cdp.ev(`typeof GIVING_TIMEOUT === "number" ? GIVING_TIMEOUT : null`);
  ok("存在超时上限常量且在合理区间", typeof T === "number" && T > 0 && T <= 30000, `GIVING_TIMEOUT=${T}`);

  // ════ B 超时 ════
  console.log("\n=== B 服务器挂住（超时）===");
  await fillForm();
  await cdp.clickReal("#gvForm button[type=submit]");
  await sleep(700);
  const bBusy = await btn();
  ok("在途期间按钮锁定", bBusy.disabled === true && bBusy.busy === "true", JSON.stringify(bBusy));
  await sleep((T || 15000) + 2000);
  const sB = await st(); const vB = await vals(); const bB2 = await btn();
  ok("超时后不再永远挂着，给出了结论", sB.文案.length > 0, "状态是空的");
  ok("超时用 warn 而非 error（无法确认 ≠ 确定失败）", sB.state === "warn", `state=${sB.state}`);
  ok("超时文案明说无法确认是否送达", /无法确认/.test(sB.文案), sB.文案.slice(0, 50));
  ok("超时文案提醒先核实再重发，避免重复", /重复|核实/.test(sB.文案), sB.文案.slice(0, 60));
  ok("超时后按钮解锁，可以重试", bB2.disabled === false, JSON.stringify(bB2));
  ok("超时后填写内容原样保留", vB.name === "测试访客" && vB.contact === "local@example.invalid", JSON.stringify(vB));

  // ════ C 网络层出错 ════
  console.log("\n=== C 网络层出错（同样可能已送达）===");
  await load("zh", "neterr");
  await fillForm();
  await cdp.clickReal("#gvForm button[type=submit]");
  await sleep(900);
  const sC = await st(); const vC = await vals();
  ok("网络错也归为无法确认，不是 error", sC.state === "warn", `state=${sC.state}`);
  ok("网络错文案明说无法确认", /无法确认/.test(sC.文案), sC.文案.slice(0, 50));
  ok("网络错文案不承诺「发送失败」", !/发送失败/.test(sC.文案), sC.文案.slice(0, 50));
  ok("网络错后内容保留", vC.name === "测试访客", JSON.stringify(vC));

  /* D 判据已收窄：**5xx 不算「能证明的失败」**。服务端自己出错时，内容完全可能
     已经写进去/排进队列之后才失败；断言没送达会诱导访客重投，造成重复。
     只有 4xx 业务拒绝（参数不合法、被限流、被禁止…）才是请求没被接受。 */
  console.log("");
  console.log("=== D1 HTTP 500：服务端自己出错 → 无法确认 ===");
  await load("zh", "http500");
  await fillForm();
  await cdp.clickReal("#gvForm button[type=submit]");
  await sleep(900);
  const s500 = await st(); const v500 = await vals();
  ok("500 归为无法确认而非确定失败", s500.state === "warn", `state=${s500.state}`);
  ok("500 文案不断言没送达", !/没有送达/.test(s500.文案), s500.文案.slice(0, 40));
  ok("500 后内容保留", v500.name === "测试访客", JSON.stringify(v500));

  console.log("");
  console.log("=== D2 HTTP 422：业务拒绝 → 这才能证明没送达 ===");
  await load("zh", "http422");
  await fillForm();
  await cdp.clickReal("#gvForm button[type=submit]");
  await sleep(900);
  const sD = await st(); const vD = await vals();
  ok("422 用 error", sD.state === "error", `state=${sD.state}`);
  ok("422 文案说明确实没有送达", /没有送达|没送达|拒绝/.test(sD.文案), sD.文案.slice(0, 50));
  ok("422 时才劝重试", /再试|重试/.test(sD.文案), sD.文案.slice(0, 50));
  ok("422 后内容保留", vD.name === "测试访客", JSON.stringify(vD));
  ok("500 与 422 判出不同状态（不是一锅端）", s500.state !== sD.state,
     `500=${s500.state} 422=${sD.state}`);

  // ════ E 成功 ════
  console.log("\n=== E 服务器确认收到 ===");
  await load("zh", "okres");
  await fillForm();
  await cdp.clickReal("#gvForm button[type=submit]");
  await sleep(900);
  const sE = await st(); const vE = await vals();
  ok("成功态标 ok", sE.state === "ok", `state=${sE.state}`);
  ok("只有拿到 2xx 才说已收到", /已收到|收到/.test(sE.文案), sE.文案.slice(0, 40));
  ok("成功后表单清空（避免重复提交同一份）", vE.name === "" && vE.contact === "", JSON.stringify(vE));

  // ════ F 重复点击 ════
  console.log("\n=== F 在途期间重复点击 ===");
  await load("zh", "hang");
  await fillForm();
  await cdp.clickReal("#gvForm button[type=submit]");
  await sleep(200);
  try { await cdp.clickReal("#gvForm button[type=submit]"); } catch (e) { /* 被禁用是预期 */ }
  await cdp.ev(`document.querySelector('#gvForm button[type=submit]').focus()`);
  await cdp.key("Enter", "Enter", 13);
  await cdp.key("Enter", "Enter", 13);
  await sleep(600);
  ok("在途期间连点连按只产生 1 次请求", (await cdp.ev(`window.__hits`)) === 1,
     `实际 ${await cdp.ev(`window.__hits`)} 次`);

  // ════ G 四语言 ════
  console.log("\n=== G 四语言超时文案 ===");
  for (const lang of ["zh", "en", "ko", "th"]) {
    await load(lang, "neterr");     // 用 neterr 走同一条「无法确认」分支，不必等满超时
    await fillForm();
    await cdp.clickReal("#gvForm button[type=submit]");
    await sleep(800);
    const s = await st();
    ok(`${lang} 无法确认态文案非空且为 warn`, s.state === "warn" && s.文案.length > 0, JSON.stringify(s));
    if (s.文案) console.log(`     ${lang}: ${s.文案.slice(0, 42)}`);
  }

  // ════ H 负向控制 ════
  console.log("\n=== H 负向控制：绿必须能转红 ===");
  // H1 三种失败必须**真的**被区分开，而不是恰好都叫 warn
  ok("H1 422 与网络错判出不同状态（证明三态不是一锅端）",
     sD.state === "error" && sC.state === "warn", `422=${sD.state} neterr=${sC.state}`);
  // H2 超时与网络错文案不同（两者都无法确认，但成因不同，应各自说清）
  ok("H2 超时与网络错给的是不同文案", sB.文案 !== sC.文案,
     "两者文案完全一样，说明超时分支其实没走到");
  // H3 外发审计
  ok("H3 零请求真正到达 formsubmit.co", reachedFormsubmit === 0,
     `有 ${reachedFormsubmit} 次请求被 CDP 拦下 —— 说明页面内替换没生效`);

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally { chrome.kill(); server.close(); }

console.log(`\n${pass}/${pass + fail} 通过`);
console.log("本套件全程本地模拟，三重阻断保证未向 formsubmit 发送任何内容，" +
            "也不涉及任何真实支付（本页是留联系方式的意愿表单）。");
process.exit(fail ? 1 : 0);
