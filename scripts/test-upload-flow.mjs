// 「上传已填写的申请表」的失败 / 重试 / 重复点击闭环。
//
// ── 这张表单改前的样子 ─────────────────────────────────────────────────
// 原生 POST 到 formsubmit，action + target="_blank"，**一行 JS 都没有**。四个后果：
//   一、accept=".doc,.docx,.pdf" 只是文件选择器的过滤条件，不是校验。切到「所有文件」
//       就能挑 .zip / .exe 传出去。
//   二、没有体积上限。几十 MB 照发，成没成访客无从得知。
//   三、target="_blank" 让原页面从头到尾不变。新标签页一旦被拦（手机很常见），
//       访客什么反馈都没有 —— 和资源中心那个静默失败同一类。
//   四、没有防重复。连点两次给学校发两封邮件。
//
// ── 安全约束（本套件的硬要求）─────────────────────────────────────────
// **绝不允许任何请求真的到达 formsubmit.co。** 本文件用 CDP Fetch 把 formsubmit.co
// 的请求全部 failRequest 掉，并在最后**断言计数为 0 次放行**。
// 表单里那些 _autoresponse / _subject 隐藏字段都不会被送出，没有任何人会收到邮件。
//
// 全程真实键盘与鼠标事件，不用 element.click() 代替用户焦点。
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

// 测试文件就地生成，不依赖外部素材
const FX = fs.mkdtempSync(path.join(os.tmpdir(), "amas-upfix-"));
const mk = (name, head, padBytes) => {
  const f = path.join(FX, name);
  fs.writeFileSync(f, Buffer.concat([Buffer.from(head, "latin1"), Buffer.alloc(padBytes || 0)]));
  return f;
};
const F_OK_PDF   = mk("ok-small.pdf", "%PDF-1.4\n", 2048);
const F_BAD_TYPE = mk("wrong-type.zip", "PK\x03\x04", 64);
const F_TOO_BIG  = mk("too-big.pdf", "%PDF-1.4\n", 11 * 1024 * 1024);

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-upload-"));
const port = 9394;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
// 三重阻断，缺一不可：
//  ① 浏览器级：formsubmit.co 解析到 0.0.0.0，任何 target（含 window.open 出来的弹窗）
//     发起的请求都不可能真的送达。CDP 的 Fetch 拦截只覆盖已附着的 target，挡不住弹窗，
//     所以这一条才是真正的保证。
//  ② CDP Fetch：本页发起的 formsubmit 请求直接 failRequest。
//  ③ 页面内哨兵：在表单上挂最后一个 submit 监听器，一律 preventDefault。
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP formsubmit.co 0.0.0.0, MAP *.formsubmit.co 0.0.0.0",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

let outboundBlocked = 0, outboundAllowed = 0;

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
    await sleep(500);
  }
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("DOM.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });

  // ── 外发阻断：formsubmit.co 一个字节都不许出去 ──
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async (ev) => {
    const u = ev.request.url;
    try {
      if (u.indexOf("formsubmit.co") > -1) {
        outboundBlocked++;
        await cdp.send("Fetch.failRequest", { requestId: ev.requestId, errorReason: "BlockedByClient" });
        return;
      }
      // 只盯提交通道。字体/CDN 这类静态资源不是本套件要防的东西，
      // 把它们算进「外发」会让安全断言变成噪声，真出事时反而看不见。
      if (/formspree|formsubmit|mailto|\/ajax\//i.test(u)) outboundAllowed++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) { /* 请求可能已终结 */ }
  });

  const errors = [];
  cdp.on("Runtime.exceptionThrown", (p) => {
    errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || "?");
  });

  const load = async (lang) => {
    errors.length = 0;
    await cdp.send("Page.navigate", { url: `${BASE}/index.html` + (lang ? `?lang=${lang}` : "") });
    await sleep(2100);
    // 站点设了 html{scroll-behavior:smooth}。不关掉它，scrollIntoView 之后立刻读 rect
    // 读到的是滚动途中的坐标，elementFromPoint 打在别处 —— 症状是「点没命中」，
    // 看起来像控件坏了，其实是探针在滚动动画中间量的。量具里早记过这个坑。
    await cdp.ev(`document.documentElement.style.scrollBehavior='auto'`);
    // 常驻浮层会挡住资源区，先让开；这是探针自己的清场，不是页面缺陷
    await cdp.ev(`(()=>{const pc=document.getElementById('promoCard'); if(pc) pc.hidden=true;
      document.querySelectorAll('.promo-tab,.chat-fab').forEach(function(e){e.style.display='none';});})()`);
    await cdp.clickReal("#uploadToggle");
    await sleep(400);
    // 提交哨兵：挂在站点自己的监听器之后，记录这次 submit 有没有被站点守卫拦下，
    // 然后无论如何都 preventDefault —— 保证本套件一次都不会真的提交。
    await cdp.ev(`(()=>{
      window.__submitLog = [];
      const f = document.getElementById('uploadForm');
      f.addEventListener('submit', function(e){
        window.__submitLog.push({ 被站点守卫拦下: e.defaultPrevented, target: f.target });
        e.preventDefault();
      });
      return true;})()`);
  };
  const submitLog = async () => cdp.ev(`window.__submitLog || []`);
  const fillText = async () => cdp.ev(`(()=>{const f=document.getElementById('uploadForm');
    const ins=f.querySelectorAll('input[type=text],input:not([type])');
    f.querySelector('input[name="姓名"]').value='测试访客';
    f.querySelector('input[name="联系方式"]').value='local@example.invalid';
    return true;})()`);
  const setFile = async (filePath) => {
    const doc = await cdp.send("DOM.getDocument");
    const node = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: '#uploadForm input[type="file"]' });
    await cdp.send("DOM.setFileInputFiles", { files: [filePath], nodeId: node.nodeId });
    await sleep(250);
  };
  const status = async () => cdp.ev(`(()=>{const b=document.querySelector('#uploadForm .upload-status');
    return b ? { 文案:(b.textContent||'').trim(), 成功态:b.classList.contains('is-ok'),
                 待确认:b.classList.contains('is-pending'),
                 role:b.getAttribute('role'), 聚焦:document.activeElement===b } : null;})()`);
  const inputs = async () => cdp.ev(`(()=>{const f=document.getElementById('uploadForm');
    return { 姓名:f.querySelector('input[name="姓名"]').value,
             联系:f.querySelector('input[name="联系方式"]').value,
             文件:(f.querySelector('input[type=file]').files[0]||{}).name || '' };})()`);

  // ════ A 初始化与 TDZ ════
  // UPLOAD_MAX_BYTES 是 const，若 applyLanguage() 在它初始化之前跑，
  // 连 typeof 都会抛 ReferenceError（TDZ 里的 const 不同于未声明变量）。
  // 不靠行号推断，直接看有没有报错、提示有没有真的填上。
  console.log("\n=== A 初始化：没有 TDZ 报错，规则提示已填入 ===");
  await load();
  ok("加载期间零 JS 异常", errors.length === 0, errors.join(" | "));
  const hint = await cdp.ev(`(document.getElementById('uploadHint')||{}).textContent || ''`);
  ok("上传规则提示非空", hint.trim().length > 0, "提示是空的（TDZ 或未接线）");
  ok("提示里带出了实际上限而非写死数字", /10(\.0)? ?MB/.test(hint), "实际: " + hint);
  console.log("     提示文案: " + hint);

  // ════ B 格式不合规 ════
  console.log("\n=== B 选了不支持的格式（.zip）===");
  await load(); await fillText(); await setFile(F_BAD_TYPE);
  await cdp.clickReal("#uploadForm button[type=submit]");
  const sB = await status(); const iB = await inputs();
  ok("给出格式错误提示", !!sB && /不支持/.test(sB.文案), sB ? sB.文案 : "无状态");
  ok("状态是 role=status", sB && sB.role === "status");
  ok("焦点交给状态（读屏能听到）", sB && sB.聚焦 === true);
  ok("姓名保留", iB.姓名 === "测试访客", iB.姓名);
  ok("联系方式保留", iB.联系 === "local@example.invalid", iB.联系);
  const lB = await submitLog();
  ok("站点守卫拦下了这次提交", lB.length === 1 && lB[0].被站点守卫拦下 === true, JSON.stringify(lB));
  ok("未产生任何外发", outboundBlocked === 0 && outboundAllowed === 0,
     `blocked=${outboundBlocked} allowed=${outboundAllowed}`);

  // ════ C 体积超限 ════
  console.log("\n=== C 文件超过上限（11MB）===");
  await load(); await fillText(); await setFile(F_TOO_BIG);
  await cdp.clickReal("#uploadForm button[type=submit]");
  const sC = await status(); const iC = await inputs();
  ok("给出体积超限提示", !!sC && /超过/.test(sC.文案), sC ? sC.文案 : "无状态");
  ok("提示里同时报出实际大小与上限", !!sC && /11\.0 MB/.test(sC.文案) && /10\.0 MB/.test(sC.文案), sC ? sC.文案 : "");
  ok("输入保留", iC.姓名 === "测试访客" && iC.联系 === "local@example.invalid");
  const lC = await submitLog();
  ok("站点守卫拦下了超限提交", lC.length === 1 && lC[0].被站点守卫拦下 === true, JSON.stringify(lC));
  ok("仍未产生任何外发", outboundBlocked === 0 && outboundAllowed === 0);

  // ════ D 弹窗被拦 ════
  console.log("\n=== D 确认页被浏览器拦截 ===");
  await load(); await fillText(); await setFile(F_OK_PDF);
  await cdp.ev(`window.open = function(){ return null; }`);   // 模拟拦截
  await cdp.clickReal("#uploadForm button[type=submit]");
  const sD = await status(); const iD = await inputs();
  ok("给出弹窗被拦提示", !!sD && /拦截/.test(sD.文案), sD ? sD.文案 : "无状态");
  ok("提示告诉用户下一步怎么办", !!sD && /允许/.test(sD.文案));
  ok("输入与所选文件都保留", iD.姓名 === "测试访客" && iD.文件 === "ok-small.pdf", JSON.stringify(iD));
  const lD = await submitLog();
  ok("弹窗被拦时守卫也拦下了提交", lD.length === 1 && lD[0].被站点守卫拦下 === true, JSON.stringify(lD));
  ok("被拦时不发出请求", outboundBlocked === 0 && outboundAllowed === 0);

  // ════ E 正常提交：成功须有响应证据 ════
  console.log("\n=== E 合规文件提交 ===");
  await load(); await fillText(); await setFile(F_OK_PDF);
  await cdp.clickReal("#uploadForm button[type=submit]");
  await sleep(600);
  const sE = await status();
  const btnE = await cdp.ev(`(()=>{const b=document.querySelector('#uploadForm button[type=submit]');
    return { disabled:b.disabled, busy:b.getAttribute('aria-busy') };})()`);
  ok("页面上给出了回执（不再一声不吭）", !!sE && sE.文案.length > 0, "无状态");
  // 关键：本页只是触发了原生 POST，响应落在另一个窗口里读不到。
  // 用绿色成功样式说「已提交」＝ 把交接当成投递成功。必须是中性待确认态。
  ok("回执**不是**成功样式", !!sE && sE.成功态 === false, "用了成功样式，等于谎称投递成功");
  ok("回执是中性待确认样式", !!sE && sE.待确认 === true);
  ok("回执明说本页无法确认是否送达", !!sE && /无法确认/.test(sE.文案), sE ? sE.文案 : "");
  ok("回执要求去确认页核实", !!sE && /确认页/.test(sE.文案), sE ? sE.文案 : "");
  ok("回执给出没看到确认页时的退路", !!sE && /重试|联系/.test(sE.文案), sE ? sE.文案 : "");
  ok("回执说明输入已保留", !!sE && /已保留/.test(sE.文案), sE ? sE.文案 : "");
  ok("提交期间按钮锁定", btnE.disabled === true, JSON.stringify(btnE));
  ok("提交期间标了 aria-busy", btnE.busy === "true");
  const lE = await submitLog();
  // 合规文件时守卫**不**拦截，放行给原生 POST —— 这正是「投递路径没被我改动」的证据。
  // （最终是本套件的哨兵把它拦住的，所以一次都没真的发出去。）
  ok("合规文件时守卫放行，交给原生 POST", lE.length === 1 && lE[0].被站点守卫拦下 === false, JSON.stringify(lE));
  ok("表单被投向具名窗口（据此才能发现弹窗被拦）", lE.length === 1 && lE[0].target === "amasUploadTarget", JSON.stringify(lE));
  ok("没有任何提交通道请求被放行", outboundAllowed === 0, `allowed=${outboundAllowed}`);

  // ════ F 重复点击 ════
  console.log("\n=== F 在途期间连点 ===");
  const beforeF = (await submitLog()).length;
  await cdp.ev(`(()=>{const b=document.querySelector('#uploadForm button[type=submit]');
    b.disabled=false; return true;})()`);           // 绕过禁用，模拟极端连点
  await cdp.clickReal("#uploadForm button[type=submit]");
  await cdp.clickReal("#uploadForm button[type=submit]");
  await sleep(700);
  const afterF = await submitLog();
  const 放行次数 = afterF.filter(x => x.被站点守卫拦下 === false).length;
  ok("在途期间的重复提交被守卫吞掉，放行次数没有增加",
     放行次数 === 1, `放行了 ${放行次数} 次（应始终为 1）`);

  // ════ G 改输入后旧结论撤销 ════
  console.log("\n=== G 改了输入，上一次的结论不该还挂着 ===");
  await load(); await fillText(); await setFile(F_BAD_TYPE);
  await cdp.clickReal("#uploadForm button[type=submit]");
  ok("先有一条失败状态", (await status()) !== null);
  await cdp.ev(`(()=>{const i=document.querySelector('#uploadForm input[name="姓名"]');
    i.focus(); i.value='改过的名字';
    i.dispatchEvent(new Event('input',{bubbles:true})); return true;})()`);
  await sleep(300);
  ok("改输入后旧状态自动撤销", (await status()) === null, "旧状态还挂着");

  // ════ H 键盘可用 ════
  console.log("\n=== H 纯键盘完成一次提交 ===");
  await load(); await fillText(); await setFile(F_BAD_TYPE);
  await cdp.ev(`document.querySelector('#uploadForm input[type=file]').focus()`);
  await cdp.key("Tab", "Tab", 9);
  const focused = await cdp.ev(`(()=>{const a=document.activeElement;
    return a.tagName.toLowerCase()+(a.type?('['+a.type+']'):'');})()`);
  ok("从文件选择 Tab 一次到达提交按钮", focused === "button[submit]", "实际 " + focused);
  await cdp.key("Enter", "Enter", 13);
  await sleep(500);
  ok("回车触发校验并给出提示", (await status()) !== null);

  // ════ I 四语言 ════
  console.log("\n=== I 四语言状态文案 ===");
  for (const lang of ["zh", "en", "ko", "th"]) {
    await load(lang); await fillText(); await setFile(F_BAD_TYPE);
    await cdp.clickReal("#uploadForm button[type=submit]");
    const s = await status();
    const h = await cdp.ev(`(document.getElementById('uploadHint')||{}).textContent||''`);
    ok(`${lang} 有格式错误提示`, !!s && s.文案.length > 0, "无状态");
    ok(`${lang} 规则提示非空`, h.trim().length > 0);
    if (s) console.log(`     ${lang}: ${s.文案.slice(0, 46)}`);
  }

  // ════ J 全程外发审计 ════
  console.log("\n=== J 外发审计 ===");
  ok("零请求真正到达 formsubmit.co（全部被拦）", outboundAllowed === 0,
     `有 ${outboundAllowed} 个提交请求放行了`);
  console.log(`     formsubmit 尝试 ${outboundBlocked} 次，全部 BlockedByClient；其他外网放行 ${outboundAllowed} 次`);

  // ════ K 负向控制 ════
  console.log("\n=== K 负向控制：绿必须能转红 ===");
  await load(); await fillText(); await setFile(F_OK_PDF);
  const kBefore = 0;
  await cdp.ev(`(()=>{const f=document.getElementById('uploadForm');
    const c=f.cloneNode(true); f.parentNode.replaceChild(c,f);   // 换掉表单=卸掉站点所有监听
    window.__kLog = [];
    c.addEventListener('submit', function(e){
      window.__kLog.push({ 被站点守卫拦下: e.defaultPrevented });
      e.preventDefault();                                         // 哨兵照旧兜底，绝不真提交
    });
    return true;})()`);
  await cdp.ev(`(()=>{const f=document.getElementById('uploadForm');
    f.querySelector('input[name="姓名"]').value='x';
    f.querySelector('input[name="联系方式"]').value='y'; return true;})()`);
  await setFile(F_TOO_BIG);
  await cdp.clickReal("#uploadForm button[type=submit]");
  await sleep(800);
  const lK = await cdp.ev(`window.__kLog || []`);
  ok("K1 卸掉守卫后，超大文件不再被拦（证明拦截确实来自守卫而非别处）",
     lK.length === 1 && lK[0].被站点守卫拦下 === false, JSON.stringify(lK));
  ok("K2 卸掉守卫后页面不再给任何提示（证明提示来自守卫）",
     (await status()) === null);

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally { chrome.kill(); server.close(); try { fs.rmSync(FX, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass}/${pass + fail} 通过`);
console.log(`外发审计：formsubmit 被拦 ${outboundBlocked} 次，其他外网放行 ${outboundAllowed} 次。` +
            `本套件不曾向 formsubmit 或任何真人发送内容。`);
process.exit(fail ? 1 : 0);
