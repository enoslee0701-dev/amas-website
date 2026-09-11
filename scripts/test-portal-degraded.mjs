// 门户「缺配置 / 组件加载失败」两种降级态的回归。
//
// 为什么要有这一套：门户页此前把两件完全不同的事套同一句话——
//   ① 学校还没开通数据库环境（用户只能等）；
//   ② 配置齐全，但 supabase-js 这个 CDN 脚本没拉下来（刷新／换网络就能好）。
// 两种都显示「账号与学习系统正在部署中（等待数据库环境开通）」。对 ② 而言那是假话，
// 而且把唯一有效的自救动作藏了起来。AMAS 的学员在泰国／中国大陆，jsdelivr 打不开是常态。
//
// ── 这套测试**不**证明什么（很重要） ────────────────────────────────────
// 本文件用的是本机 fixture：url 指向一个构造出来的 project ref，anonKey 是字面占位串
// "local-test-not-a-credential"，supabase-js 则整个被拦掉。**没有任何真实凭据参与**，
// 也没有任何请求离开本机。所以：
//   全绿 ≠ Auth 就绪，≠ 数据库可连，≠ 登录可用。
// 它只覆盖「门户在拿不到后端时对用户说什么、给不给出路」这一层。
// 真实 Auth 验收必须等真实 Supabase 项目开通后另做，属于外部阻塞项。
//
// 键盘断言一律走 Input.dispatchKeyEvent 真实按键，不用 element.click() 代替用户焦点——
// 程序化 click 不会移动焦点，会让「焦点恢复」这类断言假绿。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { TOUCH_PROBE } from "./lib/touch-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream",
                       "Cache-Control": "no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-degraded-"));
const port = 9377;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

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
  async key(key, code, vk, mods = 0) {
    const b = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...b });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...b });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...b });
    await sleep(160);
  }
  tab(shift = false) { return this.key("Tab", "Tab", 9, shift ? 8 : 0); }
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
// fixture：构造的 project ref + 字面占位 key。不是凭据，也连不到任何地方。
const CFG_PRESENT = 'window.SUPA={url:"https://abcdefghijklmnopqrst.supabase.co",anonKey:"local-test-not-a-credential"};';
const CFG_EMPTY = 'window.SUPA={url:"",anonKey:""};';

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

const PORTAL_PAGES = ["portal/", "portal/student/", "portal/applicant/",
                      "portal/teacher/", "portal/admin/", "portal/mfa/", "auth/callback/"];

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  // 缓存必须关：上一段注入的假 SDK 会被磁盘缓存命中，让下一段悄悄测成了上一段。
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

  // mode: "missing" = 配置留空（仓库出厂态）；"offline" = 配置齐全但 CDN 拒连
  let mode = "missing";
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("cdn.jsdelivr.net") > -1) {
        if (mode === "offline") { await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "ConnectionRefused" }); return; }
        await cdp.send("Fetch.continueRequest", { requestId: ev.requestId }); return;
      }
      if (u.indexOf("supabase-config.js") > -1) {
        await cdp.send("Fetch.fulfillRequest", { requestId: ev.requestId, responseCode: 200,
          responseHeaders: [{ name: "Content-Type", value: "application/javascript" },
                            { name: "Cache-Control", value: "no-store" }],
          body: b64(mode === "offline" ? CFG_PRESENT : CFG_EMPTY) }); return;
      }
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) { /* 请求可能已终结 */ }
  });

  const go = async (p) => { await cdp.send("Page.navigate", { url: `${BASE}/${p}` }); await sleep(2300); };
  const measure = async (sel) => {
    await cdp.ev(TOUCH_PROBE);
    return cdp.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return {missing:true};
      el.scrollIntoView({block:'nearest'});
      return window.__target(el,44);})()`);
  };

  // ════ 一、缺配置（仓库出厂态）════
  console.log("\n=== A 缺配置：门户应说「尚未启用」，且不给无用的重试 ===");
  mode = "missing";
  for (const p of PORTAL_PAGES) {
    await go(p);
    const s = await cdp.ev(`(()=>({state:window.AmasAuth&&window.AmasAuth.CONFIG_STATE,
      head:(document.querySelector('h1')||{}).textContent||'',
      title:document.title, retry:!!document.getElementById('portalRetry'),
      focus:document.activeElement?document.activeElement.id||document.activeElement.tagName:'',
      home:!!document.querySelector('a[href$="index.html"]')}))()`);
    ok(`${p} 判为 missing`, s.state === "missing", `实际 ${s.state}`);
    ok(`${p} 显示「门户系统尚未启用」`, s.head === "门户系统尚未启用", `实际「${s.head}」`);
    ok(`${p} 标题栏与正文一致`, s.title === "门户系统尚未启用 | AMAS", `实际「${s.title}」`);
    ok(`${p} 不给无用的重试按钮`, s.retry === false);
    ok(`${p} 焦点交给标题`, s.focus === "portalDisabledTitle", `实际落在 ${s.focus}`);
  }

  console.log("\n--- A2 降级页的键盘路径与触控目标（portal/student/）---");
  await go("portal/student/");
  const homeBox = await measure('a[href$="index.html"]');
  ok("返回官网 ≥44x44 且无人压住", homeBox.ok === true, `${homeBox.w}x${homeBox.h} ${homeBox.why}`);
  await cdp.tab();
  ok("从标题 Tab 一次即到返回官网",
     (await cdp.ev(`document.activeElement.tagName==='A'`)) === true,
     "实际 " + (await cdp.ev(`document.activeElement.tagName`)));
  await cdp.key("Enter", "Enter", 13);
  await sleep(1200);
  ok("回车真的回到官网首页",
     (await cdp.ev("location.pathname")).endsWith("/index.html"),
     await cdp.ev("location.pathname"));

  // ════ 二、配置齐全但组件加载失败 ════
  console.log("\n=== C 组件加载失败：必须说实话，并给出可用的重试 ===");
  mode = "offline";
  for (const p of PORTAL_PAGES) {
    await go(p);
    const s = await cdp.ev(`(()=>({state:window.AmasAuth&&window.AmasAuth.CONFIG_STATE,
      head:(document.querySelector('h1')||{}).textContent||'',
      title:document.title, retry:!!document.getElementById('portalRetry'),
      focus:document.activeElement?document.activeElement.id||document.activeElement.tagName:'',
      说了部署中:/正在部署中/.test(document.body.textContent||'')}))()`);
    ok(`${p} 判为 sdk-unavailable`, s.state === "sdk-unavailable", `实际 ${s.state}`);
    ok(`${p} 改说「门户暂时打不开」`, s.head === "门户暂时打不开", `实际「${s.head}」`);
    ok(`${p} 不再谎称「正在部署中」`, s.说了部署中 === false);
    ok(`${p} 标题栏同步`, s.title === "门户暂时打不开 | AMAS", `实际「${s.title}」`);
    ok(`${p} 给出重试出口`, s.retry === true);
    ok(`${p} 焦点交给标题`, s.focus === "portalDisabledTitle", `实际落在 ${s.focus}`);
  }

  console.log("\n--- C2 重试按钮：尺寸、键盘可达、回车真的重载 ---");
  await go("portal/student/");
  const retryBox = await measure("#portalRetry");
  ok("重新载入 ≥44x44 且无人压住", retryBox.ok === true, `${retryBox.w}x${retryBox.h} ${retryBox.why}`);
  const homeBox2 = await measure('a[href$="index.html"]');
  ok("返回官网 ≥44x44（与重试并排也没被挤小）", homeBox2.ok === true, `${homeBox2.w}x${homeBox2.h} ${homeBox2.why}`);
  await cdp.ev(`document.getElementById('portalDisabledTitle').focus()`);
  await cdp.tab();
  ok("Tab 一次落到重新载入",
     (await cdp.ev(`document.activeElement.id`)) === "portalRetry",
     "实际 " + (await cdp.ev(`document.activeElement.id||document.activeElement.tagName`)));
  // 打一个标记；重载会把它抹掉，以此证明真的重载了而不是什么都没发生
  await cdp.ev(`window.__beforeReload = 1`);
  await cdp.key("Enter", "Enter", 13);
  await sleep(2200);
  ok("回车真的触发了重新载入",
     (await cdp.ev(`typeof window.__beforeReload === 'undefined'`)) === true);
  ok("重载后仍停在原页面（没被甩走）",
     (await cdp.ev("location.pathname")).indexOf("/portal/student/") > -1,
     await cdp.ev("location.pathname"));

  console.log("\n--- C3 登录相关页：走 offlineNotice 而不是「尚未启用」---");
  for (const [p, btn] of [["login/", "btnLogin"], ["register/", "btnReg"],
                          ["forgot-password/", "btnGo"], ["faculty/verify/", "btnCode"]]) {
    await go(p);
    const s = await cdp.ev(`(()=>({state:window.AmasAuth&&window.AmasAuth.CONFIG_STATE,
      离线提示可见:!document.getElementById('offlineNotice').hidden,
      未启用提示可见:!document.getElementById('disabledNotice').hidden,
      主按钮已禁用:document.getElementById(${JSON.stringify(btn)}).disabled,
      有重试:!!document.getElementById('btnReload')}))()`);
    ok(`${p} 判为 sdk-unavailable`, s.state === "sdk-unavailable", `实际 ${s.state}`);
    ok(`${p} 显示离线提示`, s.离线提示可见 === true);
    ok(`${p} 不显示「尚未启用」`, s.未启用提示可见 === false);
    ok(`${p} 主按钮禁用（不假装能用）`, s.主按钮已禁用 === true);
    const rb = await measure("#btnReload");
    ok(`${p} 重新载入 ≥44x44`, rb.ok === true, `${rb.w}x${rb.h} ${rb.why}`);
  }

  // ════ 三、负向控制 ════
  // 每条断言都要能红。这里把改动逐条还原，确认上面的绿是页面给的而不是判据给的。
  console.log("\n=== 负向控制：把修复逐条还原，绿必须转红 ===");
  await go("portal/student/");

  // N1 还原「两态合一」：强制按 missing 渲染，文案应退回那句假话
  await cdp.ev(`window.AmasAuth.renderDisabled('missing')`);
  const n1 = await cdp.ev(`(()=>({head:(document.querySelector('h1')||{}).textContent,
    retry:!!document.getElementById('portalRetry'),
    说了部署中:/正在部署中/.test(document.body.textContent||'')}))()`);
  ok("N1 强制 missing 后确实退回「尚未启用 + 正在部署中 + 无重试」",
     n1.head === "门户系统尚未启用" && n1.说了部署中 === true && n1.retry === false,
     JSON.stringify(n1));

  // N2 还原标题同步：手动把 title 改回页面原名，断言必须判红
  await go("portal/student/");
  await cdp.ev(`document.title = "学员中心 | AMAS"`);
  ok("N2 标题被改回原名时断言判红",
     (await cdp.ev(`document.title === "门户暂时打不开 | AMAS"`)) === false);

  // N3 还原 44px：把重试按钮压到 30px，量具必须判红
  await go("portal/student/");
  await cdp.ev(`(()=>{const b=document.getElementById('portalRetry');
    b.style.minHeight='30px';b.style.height='30px';b.style.padding='0 8px';})()`);
  const n3 = await measure("#portalRetry");
  ok("N3 按钮压到 30px 时量具判红", n3.ok === false, `压小后仍判 ok，量具失灵：${n3.w}x${n3.h}`);

  // N4 还原焦点交接：把焦点丢回 body，断言必须判红
  await go("portal/student/");
  await cdp.ev(`document.getElementById('portalDisabledTitle').blur(); document.body.focus();`);
  ok("N4 焦点丢回 body 时断言判红",
     (await cdp.ev(`document.activeElement.id === 'portalDisabledTitle'`)) === false);

  // N5 量具本身还在工作：一个不存在的选择器必须报 missing，而不是悄悄判绿
  const n5 = await measure("#这个元素不存在");
  ok("N5 选择器打空时量具报 missing 而非假绿", n5.missing === true, JSON.stringify(n5));

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally { chrome.kill(); server.close(); }

console.log(`\n${pass}/${pass + fail} 通过`);
console.log("提醒：本套件全程使用本机 fixture（无真实凭据、无外部请求）。" +
            "全绿只说明「拿不到后端时门户对用户说了实话并给了出路」，不代表 Auth／数据库已就绪。");
process.exit(fail ? 1 : 0);
