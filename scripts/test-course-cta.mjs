// 课程区收尾出口：看完课程能不能就地进入招生／申请。
//
// ── 缺口的实测依据（改前）────────────────────────────────────────────
// 375px 下 #courses 高 2220px、67 张课程卡，**区内一个申请或招生入口都没有**。
// 看完课程想报名：往上回滚 7466px 回首屏，或再往下滚 1698px（两个多屏）
// 才碰到招生区那个「正式申请」。
//
// 本套件不涉及任何提交，也不发起任何外网请求。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { TOUCH_PROBE } from "./lib/touch-probe.mjs";

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

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-ccta-"));
const port = 9405;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
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
        m.error ? rej(new Error(m.error.message)) : res(m.result); } };
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
    await sleep(200);
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
    await sleep(350);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");

  const load = async (w, lang) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: 780, deviceScaleFactor: 1, mobile: w < 700 });
    await cdp.send("Page.navigate", { url: `${BASE}/index.html` + (lang ? `?lang=${lang}` : "") });
    await sleep(2200);
    await cdp.ev(`document.documentElement.style.scrollBehavior='auto';
      (function(){const pc=document.getElementById('promoCard'); if(pc) pc.hidden=true;
       document.querySelectorAll('.promo-tab,.chat-fab').forEach(function(e){e.style.display='none';});})()`);
  };
  const measure = async (sel) => {
    await cdp.ev(TOUCH_PROBE);
    return cdp.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return {missing:true};
      el.scrollIntoView({block:'center'});
      return window.__target(el,44);})()`);
  };

  // ════ A 出口存在且就在课程区内 ════
  console.log("\n=== A 课程区内就地有出口 ===");
  await load(375);
  const geo = await cdp.ev(`(()=>{
    const sec=document.getElementById('courses');
    const cta=sec.querySelector('.course-cta');
    if(!cta) return {无出口:true};
    const sr=sec.getBoundingClientRect(), cr=cta.getBoundingClientRect();
    const secBottom=sr.bottom+window.scrollY, ctaTop=cr.top+window.scrollY;
    return { 在课程区内: sec.contains(cta),
             卡片数: sec.querySelectorAll('.course-card').length,
             区内申请入口数: sec.querySelectorAll('[data-open-application]').length,
             区内招生链接数: sec.querySelectorAll('a[href="#admissions"]').length,
             距区尾: Math.round(secBottom-ctaTop) };})()`);
  ok("课程区内有收尾出口", geo.无出口 !== true, "找不到 .course-cta");
  ok("出口在 #courses 之内（就地可用）", geo.在课程区内 === true);
  ok("67 张课程卡之后才出现（不抢在前面）", geo.卡片数 === 67, `卡片数 ${geo.卡片数}`);
  ok("区内申请入口从 0 变为 1", geo.区内申请入口数 === 1, `实际 ${geo.区内申请入口数}`);
  ok("区内有通往招生信息的链接", geo.区内招生链接数 === 1, `实际 ${geo.区内招生链接数}`);
  ok("出口紧贴课程区末尾（不足一屏）", geo.距区尾 < 780, `距区尾 ${geo.距区尾}px`);

  // ════ B 触控与键盘 ════
  console.log("\n=== B 触控与键盘（375px）===");
  const b1 = await measure(".course-cta a.btn");
  const b2 = await measure(".course-cta button[data-open-application]");
  ok("「查看招生信息」≥44x44 且无人压住", b1.ok === true, `${b1.w}x${b1.h} ${b1.why}`);
  ok("「申请入学」≥44x44 且无人压住", b2.ok === true, `${b2.w}x${b2.h} ${b2.why}`);
  await cdp.ev(`document.querySelector('.course-cta a.btn').focus()`);
  await cdp.key("Tab", "Tab", 9);
  ok("从招生链接 Tab 一次到申请按钮",
     (await cdp.ev(`document.activeElement.hasAttribute('data-open-application')`)) === true,
     "实际 " + (await cdp.ev(`document.activeElement.tagName+"/"+(document.activeElement.textContent||'').trim().slice(0,6)`)));

  // ════ C 真的能打开申请向导（键盘） ════
  console.log("\n=== C 回车真的打开申请向导 ===");
  await cdp.key("Enter", "Enter", 13);
  await sleep(500);
  ok("申请弹窗已打开",
     (await cdp.ev(`document.querySelector('#applicationModal').classList.contains('open')`)) === true);
  ok("焦点进入弹窗内",
     (await cdp.ev(`document.querySelector('#applicationModal').contains(document.activeElement)`)) === true,
     "焦点在 " + (await cdp.ev(`document.activeElement.tagName`)));
  await cdp.key("Escape", "Escape", 27);
  await sleep(300);

  // ════ D 招生链接真的跳到招生区 ════
  console.log("\n=== D 招生链接落点 ===");
  await load(375);
  await cdp.clickReal(".course-cta a.btn");
  await sleep(600);
  const land = await cdp.ev(`(()=>{
    const a=document.getElementById('admissions').getBoundingClientRect();
    return { hash: location.hash, 招生区在视口内: a.top < window.innerHeight && a.bottom > 0,
             招生区top: Math.round(a.top) };})()`);
  ok("地址变为 #admissions", land.hash === "#admissions", land.hash || "(空)");
  ok("招生区确实滚进了视口", land.招生区在视口内 === true, `top=${land.招生区top}`);

  // ════ E 桌面宽度同样可用 ════
  console.log("\n=== E 桌面 1280px ===");
  await load(1280);
  const e1 = await measure(".course-cta a.btn");
  const e2 = await measure(".course-cta button[data-open-application]");
  ok("桌面下两个控件都 ≥44x44", e1.ok === true && e2.ok === true,
     `${e1.w}x${e1.h} / ${e2.w}x${e2.h}`);
  ok("桌面下出口仍在课程区内",
     (await cdp.ev(`document.getElementById('courses').contains(document.querySelector('.course-cta'))`)) === true);

  // ════ F 四语言 ════
  console.log("\n=== F 四语言文案 ===");
  for (const lang of ["zh", "en", "ko", "th"]) {
    await load(375, lang);
    const f = await cdp.ev(`(()=>{const c=document.querySelector('.course-cta');
      return { 说明:(c.querySelector('p').textContent||'').trim(),
               招生:(c.querySelector('a.btn').textContent||'').trim(),
               申请:(c.querySelector('button').textContent||'').trim() };})()`);
    ok(`${lang} 三处文案都非空且已翻译`,
       f.说明.length > 0 && f.招生.length > 0 && f.申请.length > 0, JSON.stringify(f));
    console.log(`     ${lang}: ${f.说明.slice(0, 34)} | ${f.招生} | ${f.申请}`);
  }

  // ════ G 不编造事实 ════
  // 文案只复述站内已有的事实（开课批次/修读年限/申请条件请咨询招生同工）。
  // 这一条钉住「不得出现承诺性字样」，防止日后有人往这里塞招生承诺。
  console.log("\n=== G 文案不含承诺性字样 ===");
  /* 必须显式带 ?lang=zh。站点把语言记在 localStorage 里，上一段 F 最后一轮
     停在泰文，这里不指定语言就会继续用泰文，而下面几条正则是中文的 ——
     判红的是语言泄漏，不是文案。 */
  await load(375, "zh");
  const note = await cdp.ev(`(document.querySelector('.course-cta p').textContent||'').trim()`);
  ok("不承诺录取／保证／学历认证",
     !/保证|必定|一定录取|包过|学历认证|国家承认|教育部/.test(note), note);
  ok("不出现具体费用数字", !/[0-9]+\\s*(元|美元|泰铢|USD|THB|RMB)/.test(note), note);
  ok("把条件指向招生同工（与 programs.note 一致）", /咨询|招生/.test(note), note);

  // ════ H 负向控制 ════
  console.log("\n=== H 负向控制：绿必须能转红 ===");
  await load(375);
  await cdp.ev(`(()=>{const c=document.querySelector('.course-cta'); if(c) c.remove(); return true;})()`);
  const h1 = await cdp.ev(`document.getElementById('courses').querySelectorAll('[data-open-application]').length`);
  ok("H1 移除出口后，课程区内的申请入口回到 0（证明 A 的绿来自这个出口）",
     h1 === 0, `实际 ${h1}`);
  await load(375);
  await cdp.ev(`(()=>{const b=document.querySelector('.course-cta button');
    b.style.minHeight='28px'; b.style.height='28px'; b.style.padding='0 6px'; return true;})()`);
  const h2 = await measure(".course-cta button[data-open-application]");
  ok("H2 把按钮压到 28px 时量具判红", h2.ok === false, `压小后仍判 ok：${h2.w}x${h2.h}`);

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally { chrome.kill(); server.close(); }

console.log(`\n${pass}/${pass + fail} 通过`);
console.log("本套件只读页面与点击导航，不提交任何表单，未发起外网请求。");
process.exit(fail ? 1 : 0);
