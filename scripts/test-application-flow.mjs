#!/usr/bin/env node
// 访客申请流程回归：浏览 → 打开申请 → 四步向导 → 校验 → 提交结果 → 返回。
//
// ── 安全前提，务必先读 ────────────────────────────────────────────────
// index.html 的 CONFIG.formEndpoint 指向**真实**的 formsubmit.co 地址，
// 任何一次成功提交都会给学校真发一封邮件。所以本脚本每次加载页面后的第一件事，
// 就是把它清成空串，让提交走站点自己的本地演示分支（只写 localStorage）。
// A0 会断言这一步确实生效；它不过，后面的提交用例一律不跑。
// 上传表单（#uploadForm）是原生 POST 到同一个邮箱且 target=_blank，
// 没有可禁用的开关，因此本脚本**不碰它**。
//
// ── 这轮要盯的两个缺陷 ────────────────────────────────────────────────
// F1 换步之后焦点没进新步骤：点完「下一步」，焦点仍在按钮上，而新步骤的字段在 DOM 里
//    排在按钮**前面**。实测键盘访客要按两次 Tab（绕过焦点环回到关闭键）或两次
//    Shift+Tab 才摸得到本步第一个输入框；读屏访客完全收不到「换步了」的信号。
// F2 关闭再打开丢的是位置不是数据：关闭不清空表单（只有提交成功才 reset），
//    但重开一律回到第 1 步 —— 数据还在、位置没了，填到第 3 步的访客要对着已经填好的
//    字段再点三次「下一步」。位置和数据要么一起留，要么一起清。
//
// 用法: node scripts/test-application-flow.mjs
// Chrome 路径可用环境变量 CHROME 覆盖；找不到时以非零退出，不静默跳过。

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (cond, name, detail) => results.push([!!cond, name, detail]);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  return [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => fs.existsSync(p)) || null;
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p.endsWith("/")) p += "index.html";
    const abs = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
    if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(abs).toLowerCase()] || "application/octet-stream" });
    fs.createReadStream(abs).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async attach(port) {
    let url;
    for (let i = 0; i < 80 && !url; i++) {
      try {
        const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      if (!url) await sleep(250);
    }
    if (!url) throw new Error("could not attach to Chrome");
    const sock = await new Promise((res, rej) => {
      const s = new WebSocket(url); s.onopen = () => res(s); s.onerror = rej;
    });
    const c = new Cdp(sock);
    sock.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}, ms = 30000) {
    return new Promise((res, rej) => {
      const i = ++this.id;
      const timer = setTimeout(() => {
        if (this.pending.delete(i)) rej(new Error(`CDP timeout after ${ms}ms: ${method}`));
      }, ms);
      this.pending.set(i, { res: (v) => { clearTimeout(timer); res(v); },
                            rej: (e) => { clearTimeout(timer); rej(e); } });
      this.ws.send(JSON.stringify({ id: i, method, params }));
    });
  }
  async ev(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("eval threw: " + (r.exceptionDetails.exception?.description || ""));
    return r.result?.value;
  }
  async key(key, code, vk, mods = 0) {
    const b = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...b });
    if (key === "Enter") await this.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...b });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...b });
    await sleep(140);
  }
  tab(shift = false) { return this.key("Tab", "Tab", 9, shift ? 8 : 0); }
}

const WHO = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return '(body)';
  const sec = el.closest('.app-step');
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (el.name ? '[name=' + el.name + ']' : '') +
    (sec ? ' @第' + sec.dataset.step + '步' : ' @步骤外');
})()`;

// 用「就在这一步里」而不是「等于某个具体元素」来判：将来字段顺序调整了，
// 断言仍该绿 —— 它要保证的是焦点进了新步骤，不是进了哪个具体输入框。
const IN_ACTIVE_STEP = `(() => {
  const el = document.activeElement;
  const sec = el && el.closest ? el.closest('.app-step') : null;
  return !!sec && sec.classList.contains('active');
})()`;

const FILL_STEP1 = `(() => {
  const set = (n, v) => { const f = document.querySelector('[name=' + n + ']'); f.value = v;
    f.dispatchEvent(new Event('input', {bubbles:true})); f.dispatchEvent(new Event('change', {bubbles:true})); };
  set('fullName','测试访客'); set('gender','male'); set('birth','1990-01');
  set('nationality','中国'); set('language','mandarin'); set('phone','13800000000');
  set('email','visitor@example.com'); set('location','清迈');
})()`;
const FILL_REST = `(() => {
  const set = (n, v) => { const f = document.querySelector('[name=' + n + ']'); f.value = v;
    f.dispatchEvent(new Event('input', {bubbles:true})); f.dispatchEvent(new Event('change', {bubbles:true})); };
  set('church','测试教会'); set('churchType','house');
  set('program','bth'); set('eduLevel','bachelor');
  set('motivation','这是一段用于本地验收的见证文本，不含任何真实个人资料。');
})()`;

const CHROME = findChrome();
if (!CHROME) {
  console.log("FAIL cannot locate Chrome; set CHROME=<path to chrome executable>");
  console.log("=== APPLICATION FLOW: ABORTED (no browser) ===");
  process.exit(2);
}

const server = await startServer();
const BASE = `http://127.0.0.1:${server.address().port}`;
const port = 9500 + (process.pid % 40);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "amas-appflow-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

let netCut = false;
async function load(cdp) {
  await cdp.send("Page.navigate", { url: `${BASE}/index.html` });
  await sleep(2400);
  netCut = await cdp.ev(`(() => { try { CONFIG.formEndpoint = ""; return CONFIG.formEndpoint === ""; }
    catch (e) { return false; } })()`);
  return netCut;
}
// 用真实按键从入口进入弹窗：模态的焦点行为取决于「是谁、怎么打开的」，
// 直接调 openApplication() 会绕过这一点，量到的焦点不是真人会遇到的。
async function openByKeyboard(cdp) {
  await cdp.ev(`document.querySelector('#resourceList .resource-row:nth-child(4) button').focus()`);
  await cdp.tab(true); await cdp.tab(false);
  await cdp.key("Enter", "Enter", 13);
  await sleep(600);
}

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 375, height: 780, deviceScaleFactor: 1, mobile: true });

  // A0 安全闸
  const cut = await load(cdp);
  check(cut, "A0 安全闸：真实提交端点已在页面内清空，提交只写 localStorage",
    cut ? "CONFIG.formEndpoint = \"\"（原值指向 formsubmit.co 真实邮箱）"
        : "清空失败 —— 后面的提交用例不能跑，否则会给学校真发邮件");
  if (!cut) throw new Error("safety gate failed");

  // A1 入口 + 焦点进入弹窗
  await openByKeyboard(cdp);
  const opened = await cdp.ev(`(() => {
    const m = document.querySelector('#applicationModal');
    const card = document.querySelector('.application-card');
    return { hidden: m.getAttribute('aria-hidden'),
             focusInside: card.contains(document.activeElement),
             step: document.querySelector('.app-step.active').dataset.step };
  })()`);
  check(opened.hidden === "false" && opened.focusInside && opened.step === "1",
    "A1 键盘从资源中心「填写 →」打开申请弹窗，焦点进入面板，停在第 1 步",
    `aria-hidden=${opened.hidden} 焦点在面板内=${opened.focusInside} 当前步=${opened.step}`);

  // A2 必填留空时不许前进，并且焦点落到出问题的字段上
  await cdp.ev(`document.querySelector('#nextStep').click()`);
  await sleep(500);
  const blocked = await cdp.ev(`(() => ({
    step: document.querySelector('.app-step.active').dataset.step,
    focus: document.activeElement.name || '',
    invalid: !document.querySelector('[name=fullName]').checkValidity() }))()`);
  check(blocked.step === "1" && blocked.focus === "fullName" && blocked.invalid,
    "A2 第 1 步必填留空：不前进，焦点落到第一个未填字段",
    `当前步=${blocked.step} 焦点字段=${blocked.focus} 该字段未通过校验=${blocked.invalid}`);

  // A3 换步之后焦点必须进入新步骤（本轮修的 F1）
  await cdp.ev(FILL_STEP1);
  await cdp.ev(`document.querySelector('#nextStep').focus()`);
  await cdp.key("Enter", "Enter", 13);
  await sleep(500);
  const afterNext = await cdp.ev(`(() => ({
    step: document.querySelector('.app-step.active').dataset.step,
    inStep: ${IN_ACTIVE_STEP}, who: ${WHO} }))()`);
  check(afterNext.step === "2" && afterNext.inStep,
    "A3 键盘按「下一步」后，焦点进入新步骤（不再留在按钮上）",
    `当前步=${afterNext.step} 焦点在当前步内=${afterNext.inStep} 焦点=${afterNext.who}`);

  // A4 「上一步」同样把焦点带回去
  await cdp.ev(`document.querySelector('#prevStep').focus()`);
  await cdp.key("Enter", "Enter", 13);
  await sleep(500);
  const afterPrev = await cdp.ev(`(() => ({
    step: document.querySelector('.app-step.active').dataset.step,
    inStep: ${IN_ACTIVE_STEP}, who: ${WHO} }))()`);
  check(afterPrev.step === "1" && afterPrev.inStep,
    "A4 键盘按「上一步」后，焦点同样进入该步骤",
    `当前步=${afterPrev.step} 焦点在当前步内=${afterPrev.inStep} 焦点=${afterPrev.who}`);

  // A5 关闭再打开：位置和数据一起留（本轮修的 F2）
  await cdp.ev(`document.querySelector('#nextStep').click()`); await sleep(350);
  await cdp.ev(FILL_REST);
  await cdp.ev(`document.querySelector('#nextStep').click()`); await sleep(350);
  const beforeClose = await cdp.ev(`document.querySelector('.app-step.active').dataset.step`);
  await cdp.key("Escape", "Escape", 27);
  await sleep(500);
  const closed = await cdp.ev(`(() => ({
    hidden: document.querySelector('#applicationModal').getAttribute('aria-hidden'),
    focus: ${WHO} }))()`);
  await openByKeyboard(cdp);
  const reopened = await cdp.ev(`(() => ({
    step: document.querySelector('.app-step.active').dataset.step,
    name: document.querySelector('[name=fullName]').value }))()`);
  check(closed.hidden === "true" && reopened.step === beforeClose && reopened.name === "测试访客",
    "A5 Esc 关闭后重开：停回原来那一步，且填过的数据都还在",
    `关闭前=第${beforeClose}步 重开后=第${reopened.step}步 姓名="${reopened.name}" 关闭时 aria-hidden=${closed.hidden}`);

  // A6 Esc 之后焦点回到打开它的那个入口
  check(/填写|button/.test(closed.focus) && closed.focus !== "(body)",
    "A6 Esc 关闭后焦点回到打开弹窗的入口，不丢给 body",
    `关闭后焦点=${closed.focus}`);

  // A7 复核页：逐字段回显，选填项显示占位符而不是空白
  await cdp.ev(`document.querySelector('#nextStep').click()`); await sleep(400);
  const review = await cdp.ev(`(() => {
    const dts = [...document.querySelectorAll('#applicationReview dt')];
    const pair = (label) => { const dt = dts.find(d => d.textContent.includes(label));
      return dt ? dt.nextElementSibling.textContent : null; };
    return { n: dts.length, name: pair('中文姓名'), gender: pair('性别'),
             optional: pair('英文姓名'), step: document.querySelector('.app-step.active').dataset.step };
  })()`);
  check(review.step === "4" && review.n >= 20 && review.name === "测试访客" &&
        review.gender === "男" && review.optional === "—",
    "A7 复核页逐字段回显：枚举值译成中文，选填未填显示「—」",
    `条目=${review.n} 姓名=${review.name} 性别=${review.gender} 未填的英文姓名=${review.optional}`);

  // A8 未勾同意不许提交，焦点落到勾选框
  await cdp.ev(`document.querySelector('#submitApplication').click()`);
  await sleep(600);
  const noConsent = await cdp.ev(`(() => ({
    hidden: document.querySelector('#applicationModal').getAttribute('aria-hidden'),
    focus: document.activeElement.name || '',
    saved: JSON.parse(localStorage.getItem('amas-applications') || '[]').length }))()`);
  check(noConsent.hidden === "false" && noConsent.focus === "consent" && noConsent.saved === 0,
    "A8 未勾「我确认」不许提交：弹窗不关、焦点落到勾选框、没有落库",
    `aria-hidden=${noConsent.hidden} 焦点字段=${noConsent.focus} 已保存条数=${noConsent.saved}`);

  // A9 提交成功：状态可见 + 落本地 + 自动关闭 + 表单重置 + 回到第 1 步
  await cdp.ev(`document.querySelector('[name=consent]').checked = true`);
  await cdp.ev(`document.querySelector('#submitApplication').click()`);
  await sleep(1200);
  const submitted = await cdp.ev(`(() => {
    const st = document.querySelector('#applicationStatus');
    return { state: st.dataset.state || '', text: (st.textContent || '').trim().slice(0, 24),
             saved: JSON.parse(localStorage.getItem('amas-applications') || '[]').length };
  })()`);
  check(submitted.state === "ok" && submitted.text.length > 0 && submitted.saved === 1,
    "A9 提交成功：状态区给出可见结果，记录写入本地演示存储",
    `data-state=${submitted.state} 文案="${submitted.text}…" 已保存条数=${submitted.saved}`);

  await sleep(1800);
  const after = await cdp.ev(`(() => ({
    hidden: document.querySelector('#applicationModal').getAttribute('aria-hidden'),
    step: document.querySelector('.app-step.active').dataset.step,
    name: document.querySelector('[name=fullName]').value,
    focus: ${WHO} }))()`);
  check(after.hidden === "true" && after.step === "1" && after.name === "",
    "A10 提交后自动关闭、表单清空、回到第 1 步（提交成功才清，和 A5 的保留互不矛盾）",
    `aria-hidden=${after.hidden} 当前步=${after.step} 姓名="${after.name}" 关闭后焦点=${after.focus}`);

  // A12 提交失败：提示必须出现在看得见的地方。
  // 复现方式是把端点指向 127.0.0.1:1（本机必然拒绝连接），不碰任何真实服务；
  // 点击前先把「提交申请」滚到卡片可视区**底边**——这是真人最常见的做法：
  // 刚把按钮滚出来就点。修复前实测此时 38px 的提示整条落在卡片可视区之外。
  await load(cdp);
  await cdp.ev(`CONFIG.formEndpoint = "http://127.0.0.1:1/"`);
  await openByKeyboard(cdp);
  await cdp.ev(FILL_STEP1);
  await cdp.ev(`document.querySelector('#nextStep').click()`); await sleep(300);
  await cdp.ev(FILL_REST);
  await cdp.ev(`document.querySelector('#nextStep').click()`); await sleep(300);
  await cdp.ev(`document.querySelector('#nextStep').click()`); await sleep(400);
  await cdp.ev(`document.querySelector('[name=consent]').checked = true`);
  await cdp.ev(`document.querySelector('#submitApplication').scrollIntoView({ block: 'end' })`);
  await sleep(400);
  await cdp.ev(`document.querySelector('#submitApplication').click()`);
  await sleep(2600);
  const failView = await cdp.ev(`(() => {
    const card = document.querySelector('.application-card');
    const st = document.querySelector('#applicationStatus');
    const c = card.getBoundingClientRect(), s = st.getBoundingClientRect();
    return { state: st.dataset.state || '', text: (st.textContent || '').trim().slice(0, 20),
             inView: s.top >= c.top - 0.5 && s.bottom <= c.bottom + 0.5,
             clipped: Math.max(0, Math.round(s.bottom - c.bottom)),
             modalOpen: document.querySelector('#applicationModal').getAttribute('aria-hidden') === 'false',
             canRetry: !document.querySelector('#submitApplication').disabled };
  })()`);
  check(failView.state === "error" && failView.inView && failView.clipped === 0 &&
        failView.modalOpen && failView.canRetry,
    "A12 提交失败：错误提示被带进卡片可视区，弹窗不关、可以重试",
    `state=${failView.state} 文案="${failView.text}…" 在卡片可视区内=${failView.inView} ` +
    `被裁掉=${failView.clipped}px 弹窗仍开=${failView.modalOpen} 可重试=${failView.canRetry}`);

  // A13 结果提示不过期：改动表单后，上一次的结果就该消失
  const stale = await cdp.ev(`(() => {
    const st = document.querySelector('#applicationStatus');
    const before = st.dataset.state || '';
    const f = document.querySelector('[name=fullName]');
    f.value = f.value + '改'; f.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, after: st.dataset.state || '', text: (st.textContent || '').trim() };
  })()`);
  check(stale.before === "error" && stale.after === "" && stale.text === "",
    "A13 结果提示不过期：一改表单，上一次的提交结果立刻清掉",
    `改动前 state=${stale.before} 改动后 state="${stale.after}" 残留文字="${stale.text}"`);

  // A11 负向控制：把本轮两处改动还原，缺陷必须精确复现。
  // 还原方式是直接改回站点自己的行为（换步不移焦点 / 打开一律回第 1 步），
  // 而不是换一套断言 —— 不会变红的负向控制等于没有控制。
  await load(cdp);
  await cdp.ev(`(() => {
    const next = document.querySelector('#nextStep');
    const clone = next.cloneNode(true);          // 去掉本轮带 moveFocus 的监听
    next.parentNode.replaceChild(clone, next);
    clone.addEventListener('click', () => { if (stepValid(appStep)) showAppStep(Math.min(APP_STEPS, appStep + 1)); });
    window.__revertOpen = () => showAppStep(1);  // 还原「打开一律回第 1 步」
  })()`);
  await openByKeyboard(cdp);
  await cdp.ev(FILL_STEP1);
  await cdp.ev(`document.querySelector('#nextStep').focus()`);
  await cdp.key("Enter", "Enter", 13);
  await sleep(500);
  const revFocus = await cdp.ev(`(() => ({ step: document.querySelector('.app-step.active').dataset.step,
    inStep: ${IN_ACTIVE_STEP}, who: ${WHO} }))()`);
  await cdp.key("Escape", "Escape", 27); await sleep(400);
  await cdp.ev(`window.__revertOpen()`);
  await openByKeyboard(cdp);
  const revStep = await cdp.ev(`document.querySelector('.app-step.active').dataset.step`);
  check(revFocus.step === "2" && !revFocus.inStep && revStep === "1",
    "A11 负向控制：还原后两个缺陷精确复现（焦点留在按钮上、重开回到第 1 步）",
    `换步后焦点=${revFocus.who}（在当前步内=${revFocus.inStep}）；还原后重开落在第 ${revStep} 步`);

  // A14 负向控制之二：把 revealStatus 变成空操作，失败提示必须重新落到可视区之外。
  // 直接改站点自己的函数，而不是换一套宽松断言 —— 不会变红的负向控制等于没有控制。
  await load(cdp);
  await cdp.ev(`CONFIG.formEndpoint = "http://127.0.0.1:1/"; window.revealStatus = () => {};`);
  await cdp.ev(`openApplication()`);
  await sleep(400);
  await cdp.ev(FILL_STEP1); await cdp.ev(FILL_REST);
  await cdp.ev(`document.querySelector('[name=consent]').checked = true`);
  await cdp.ev(`showAppStep(4)`); await sleep(300);
  await cdp.ev(`document.querySelector('#submitApplication').scrollIntoView({ block: 'end' })`);
  await sleep(400);
  await cdp.ev(`document.querySelector('#submitApplication').click()`);
  await sleep(2600);
  const revView = await cdp.ev(`(() => {
    const card = document.querySelector('.application-card');
    const st = document.querySelector('#applicationStatus');
    const c = card.getBoundingClientRect(), s = st.getBoundingClientRect();
    return { state: st.dataset.state || '',
             inView: s.top >= c.top - 0.5 && s.bottom <= c.bottom + 0.5,
             clipped: Math.max(0, Math.round(s.bottom - c.bottom)) };
  })()`);
  check(revView.state === "error" && !revView.inView && revView.clipped > 0,
    "A14 负向控制：把提示滚动还原成空操作后，错误提示重新落到卡片可视区之外",
    `state=${revView.state} 在卡片可视区内=${revView.inView} 被裁掉=${revView.clipped}px`);

  cdp.ws.close();
} finally {
  chrome.kill();
  server.close();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
}

let passed = 0;
for (const [good, name, detail] of results) {
  console.log(`${good ? "PASS" : "FAIL"} ${name} | ${detail}`);
  if (good) passed++;
}
console.log("");
console.log(`=== APPLICATION FLOW: ${passed}/${results.length} PASSED ===`);
process.exit(passed === results.length ? 0 : 1);
