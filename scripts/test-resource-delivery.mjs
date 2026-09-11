// 资源中心真实交付回归：三条下载路径 × 四语言，真实点击 → 捕获落盘文件 → 验魔数；
// 外加两条失败分支（文件 404、资源未配置）必须给出明确状态而不是一声不吭。
//
// ── 这套测试证明什么 ──────────────────────────────────────────────────
// 它证明「点下载真的拿到与标签一致、能打开的文件」，以及「拿不到时用户知道下一步」。
// 文件内容本身是否正确（课程是否属实、收费是否准确）**不在本套件范围**，
// 那要院方核对文稿，不是前端能验的。本套件只验格式与交付，不对内容作任何断言。
//
// ── 两个已经踩过的坑，写在这里防止复发 ────────────────────────────────
// 一、站点设了 html{scroll-behavior:smooth}。不先关掉它，scrollIntoView 之后立刻读
//     rect 读到的是滚动前的坐标（实测 y=18367，差了一整屏），elementFromPoint 什么都
//     命中不到，于是每一条都报「点没命中」—— 看起来像下载全坏了，其实是探针没落位。
// 二、Chrome 的下载目录里会有 downloads.htm 与 .crdownload 中间文件，不过滤会把它们
//     当成下载结果，魔数判定全错。
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
  ".webp":"image/webp", ".ico":"image/x-icon", ".woff2":"font/woff2", ".pdf":"application/pdf",
  ".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

let BLOCK = null;   // 命中此子串的请求返回 404，用来制造失败分支
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p.endsWith("/")) p += "index.html";
  if (p.indexOf("..") > -1) { res.writeHead(400); res.end("no"); return; }
  if (BLOCK && p.indexOf(BLOCK) > -1) { res.writeHead(404, { "Content-Type":"text/plain" }); res.end("Not Found"); return; }
  const abs = path.join(ROOT, p);
  if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream", "Cache-Control":"no-store" });
  fs.createReadStream(abs).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-res-"));
const DL = fs.mkdtempSync(path.join(os.tmpdir(), "amas-dl-"));
const port = 9392;
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
    await this.send("Input.dispatchKeyEvent", { type:"rawKeyDown", ...b });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type:"char", text:"\r", ...b });
    await this.send("Input.dispatchKeyEvent", { type:"keyUp", ...b });
    await sleep(200);
  }
  async clickReal(sel) {
    const pt = await this.ev(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
      if(!el) return null;
      document.documentElement.style.scrollBehavior='auto';   // 见文件头「坑一」
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect(); const x=r.left+r.width/2, y=r.top+r.height/2;
      const hit=document.elementFromPoint(x,y);
      return {x,y,ok:!!hit&&(hit===el||el.contains(hit)||hit.contains(el))};})()`);
    if (!pt) throw new Error("找不到 " + sel);
    if (!pt.ok) throw new Error("点没命中 " + sel + "（被遮挡或没落位）");
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button:"left", clickCount:1 });
    await sleep(500);
  }
}

// 魔数判定：只看字节，不信扩展名
const sniff = (f) => {
  const b = fs.readFileSync(f);
  if (b.slice(0, 4).toString("latin1") === "%PDF") return "PDF";
  if (b[0] === 0x50 && b[1] === 0x4b) return "DOCX";
  const head = b.slice(0, 300).toString("utf8").toLowerCase();
  if (head.indexOf("<!doctype html") > -1 || head.indexOf("<html") > -1) return "HTML";
  return "TEXT";
};
const junk = (f) => f === "downloads.htm" || f.endsWith(".crdownload");   // 见文件头「坑二」
const clearDL = () => { for (const f of fs.readdirSync(DL)) { try { fs.unlinkSync(path.join(DL, f)); } catch {} } };
const settled = async (ms = 8000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sleep(250);
    const got = fs.readdirSync(DL).filter((f) => !junk(f));
    if (got.length) { await sleep(350); return fs.readdirSync(DL).filter((f) => !junk(f)); }
  }
  return [];
};

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

const LANGS = ["zh", "en", "ko", "th"];
const PATHS = [
  ["新生手册",   '[data-download="student-handbook"]', "PDF"],
  ["课程目录",   '[data-download="curriculum"]',       "PDF"],
  ["完整申请表", "#formDl",                            "DOCX"],
];

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable");
  await cdp.send("Browser.setDownloadBehavior", { behavior:"allow", downloadPath: DL, eventsEnabled:true });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width:375, height:780, deviceScaleFactor:1, mobile:true });

  const open = async (lang) => {
    await cdp.send("Page.navigate", { url: `${BASE}/index.html${lang ? "?lang=" + lang : ""}` });
    await sleep(1900);
    // 常驻浮层会挡住资源行，让「点没命中」看起来像下载坏了
    await cdp.ev(`(()=>{const pc=document.getElementById('promoCard'); if(pc) pc.hidden=true;
      document.querySelectorAll('.promo-tab,.chat-fab').forEach(function(e){e.style.display='none';});})()`);
  };

  // ════ A 正常交付：拿到的文件与标签一致且能打开 ════
  console.log("\n=== A 三条路径 × 四语言：真实点击后落盘文件的字节格式 ===");
  for (const lang of LANGS) {
    for (const [name, sel, want] of PATHS) {
      clearDL();
      await open(lang);
      await cdp.clickReal(sel);
      const files = await settled();
      const got = files.length ? sniff(path.join(DL, files[0])) : "无文件";
      const size = files.length ? fs.statSync(path.join(DL, files[0])).size : 0;
      ok(`${lang} ${name} 落盘且字节格式为 ${want}`, got === want && size > 2000,
         `实际 ${got} ${size}B 文件=${files[0] || "-"}`);
      // 标签写 PDF 就必须真的是 PDF —— 不允许拿文本/HTML 冒充
      if (files.length) {
        ok(`${lang} ${name} 不是伪装成文档的文本或 HTML`, got !== "TEXT" && got !== "HTML",
           `实际 ${got}`);
      }
    }
  }

  // ════ B 语言分发：换语言必须换到对应语种的文件 ════
  console.log("\n=== B 语言分发：四语言拿到的是四个不同文件 ===");
  const seen = {};
  for (const lang of LANGS) {
    clearDL(); await open(lang);
    await cdp.clickReal("#formDl");
    const f = await settled();
    seen[lang] = f[0] || "";
  }
  ok("四语言的申请表各不相同", new Set(Object.values(seen)).size === 4, JSON.stringify(seen));
  ok("en 拿到的是 -en 文件", (seen.en || "").indexOf("-en") > -1, seen.en);
  ok("th 拿到的是 -th 文件", (seen.th || "").indexOf("-th") > -1, seen.th);

  // ════ C 失败分支一：文件 404 ════
  console.log("\n=== C 文件 404：必须明确告知，不得静默 ===");
  for (const [name, sel, blockStr] of [
      ["新生手册", '[data-download="student-handbook"]', "student-handbook"],
      ["完整申请表", "#formDl", "application-form"]]) {
    clearDL();
    BLOCK = blockStr;
    await open("zh");
    await cdp.clickReal(sel);
    await sleep(1500);
    const files = fs.readdirSync(DL).filter((f) => !junk(f));
    const st = await cdp.ev(`(()=>{const b=document.querySelector('.resource-status');
      if(!b) return {有状态:false};
      return {有状态:true, 可见:b.offsetParent!==null, role:b.getAttribute('role'),
        文字:(b.textContent||'').trim().slice(0,40),
        有联系出口:!!b.querySelector('a[href="#contact"]'),
        有申请出口:!!b.querySelector('button[data-open-application]'),
        焦点在状态上:document.activeElement===b};})()`);
    ok(`${name} 404 时不落盘垃圾文件`, files.length === 0, JSON.stringify(files));
    ok(`${name} 404 时显示明确状态`, st.有状态 === true && st.可见 === true, "仍是静默失败");
    ok(`${name} 状态用 role=status（读屏会念）`, st.role === "status");
    ok(`${name} 状态给出联系出口`, st.有联系出口 === true);
    ok(`${name} 状态给出申请出口`, st.有申请出口 === true);
    ok(`${name} 焦点带到状态上（键盘访客也知道）`, st.焦点在状态上 === true);
    BLOCK = null;
  }

  // ════ D 失败分支二：资源未配置 ════
  console.log("\n=== D 资源未配置：如实说没有，不得发 .txt 冒充 PDF ===");
  clearDL();
  await open("zh");
  await cdp.ev(`CONFIG.resources = {}`);
  await cdp.clickReal('[data-download="student-handbook"]');
  await sleep(1200);
  const dFiles = fs.readdirSync(DL).filter((f) => !junk(f));
  ok("未配置时一个文件都不发", dFiles.length === 0, JSON.stringify(dFiles));
  ok("未配置时不再生成 .txt 占位文档",
     !dFiles.some((f) => f.endsWith(".txt")), JSON.stringify(dFiles));
  const dSt = await cdp.ev(`(()=>{const b=document.querySelector('.resource-status');
    return b ? {文字:(b.textContent||'').trim().slice(0,30), 可见:b.offsetParent!==null} : {无:true};})()`);
  ok("未配置时显示「尚未提供正式文件」", dSt.可见 === true, JSON.stringify(dSt));

  // ════ E 四语言状态文案 ════
  console.log("\n=== E 失败状态的四语言文案 ===");
  for (const lang of LANGS) {
    BLOCK = "student-handbook";
    await open(lang);
    await cdp.clickReal('[data-download="student-handbook"]');
    await sleep(1200);
    const txt = await cdp.ev(`(()=>{const b=document.querySelector('.resource-status');
      return b ? (b.textContent||'').trim() : '';})()`);
    ok(`${lang} 状态文案非空且已本地化`, txt.length > 10, `"${txt.slice(0, 40)}"`);
    if (lang !== "zh") {
      // 非中文语言下不应残留中文兜底文案
      ok(`${lang} 没有回落成中文`, !/暂时无法下载|尚未提供/.test(txt), `"${txt.slice(0, 40)}"`);
    }
    BLOCK = null;
  }

  // ════ F 键盘路径 ════
  console.log("\n=== F 键盘：回车触发下载；失败状态里的出口可 Tab 可回车 ===");
  clearDL();
  await open("zh");
  await cdp.ev(`(()=>{document.documentElement.style.scrollBehavior='auto';
    const b=document.querySelector('[data-download="curriculum"]');
    b.scrollIntoView({block:'center'}); b.focus();})()`);
  await sleep(300);
  ok("下载按钮可获得键盘焦点",
     (await cdp.ev(`document.activeElement.dataset.download === 'curriculum'`)) === true);
  await cdp.key("Enter", "Enter", 13);
  const kf = await settled();
  ok("回车真的下载到文件", kf.length === 1 && sniff(path.join(DL, kf[0])) === "PDF", JSON.stringify(kf));

  BLOCK = "student-handbook";
  await open("zh");
  await cdp.clickReal('[data-download="student-handbook"]');
  await sleep(1200);
  await cdp.key("Tab", "Tab", 9);
  const focus1 = await cdp.ev(`(()=>{const e=document.activeElement;
    return {tag:e.tagName, 在状态内:!!e.closest('.resource-status'), 文字:(e.textContent||'').trim()};})()`);
  ok("从状态处 Tab 一次进入出口控件", focus1.在状态内 === true,
     `落在 ${focus1.tag} "${focus1.文字}"`);
  BLOCK = null;

  // ════ G 负向控制 ════
  console.log("\n=== G 负向控制：绿必须能转红 ===");
  // G1 把交付函数换成原来的「直接 a.click()」写法，404 必须重新变成静默
  BLOCK = "student-handbook";
  await open("zh");
  await cdp.ev(`window.deliverResource = async function(url,row,name,trigger){
    const a=document.createElement('a'); a.href=url; a.download=''; a.click(); return true; };`);
  await cdp.clickReal('[data-download="student-handbook"]');
  await sleep(1200);
  const g1 = await cdp.ev(`!!document.querySelector('.resource-status')`);
  ok("G1 还原成直接 click 后，404 重新变回静默失败", g1 === false,
     "还原后仍有状态，说明断言没在测我改的那段");
  BLOCK = null;

  // G2 魔数判定本身要能识破伪装
  const fake = path.join(DL, "__fake.pdf");
  fs.writeFileSync(fake, "<!DOCTYPE html><html><body>not a pdf</body></html>");
  ok("G2 把 HTML 命名成 .pdf 时魔数判定识破", sniff(fake) === "HTML", sniff(fake));
  fs.unlinkSync(fake);

  // G3 探测器不会对不存在的文件说 ok
  await open("zh");
  const g3 = await cdp.ev(`resourceReachable('assets/files/__this-does-not-exist__.pdf')`);
  ok("G3 探测不存在的文件返回 false", g3 === false);

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally { chrome.kill(); server.close(); }

console.log(`\n${pass}/${pass + fail} 通过`);
console.log("范围说明：本套件只验交付（格式、语言分发、失败提示），" +
            "不对文件内容是否属实作任何断言 —— 那需要院方核对文稿。");
process.exit(fail ? 1 : 0);
