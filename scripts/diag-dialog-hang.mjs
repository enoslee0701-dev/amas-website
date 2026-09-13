// 一次性诊断：Sf→Se 那个挂起到底卡在哪一层（eventb5c5 根因未结）。
//
// **不重跑原组合、不赌绿、不碰任何产品页**：用一个最小的独立夹具
// （一个带 beforeunload 的空白页）把三种可能分开：
//   (a) 原生对话框没被应答 → **渲染进程**级命令被挡；
//   (b) CDP 通道/未决调用本身坏了 → **连浏览器级**命令也不回；
//   (c) 进程清理生命周期 → 能跑完但退不出 / 杀不掉自己的 Chrome。
// 判据：对话框开着时分别打 Browser.getVersion（浏览器级）与
// Runtime.evaluate / Input.dispatchKeyEvent（渲染级），再应答后复测。
// 全程只杀**自己 spawn 的那一个** Chrome，绝不碰用户的浏览器。
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = `<!doctype html><meta charset="utf-8"><title>diag</title>
<body><input id="i"><script>
let dirty = false;
document.getElementById("i").addEventListener("input", () => { dirty = true; });
window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
</script></body>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-diag-"));
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0",
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

/* 看门狗：到点就收自己的摊子并退出。只杀自己 spawn 的那个 pid。 */
let done = false;
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS || 90000);
const watchdog = setTimeout(() => {
  if (done) return;
  console.log("\n  ⏱ 看门狗到点：本进程自行退出（只杀自己 spawn 的 Chrome）");
  cleanup(3);
}, WATCHDOG_MS);
function cleanup(code){
  done = true;
  clearTimeout(watchdog);
  try { chrome.kill("SIGKILL"); } catch (e) {}
  try { server.close(); } catch (e) {}
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  setTimeout(() => process.exit(code), 300);
}

async function ownPort(){
  const f = path.join(prof, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    try { const n = Number(fs.readFileSync(f, "utf8").split("\n")[0].trim());
      if (Number.isInteger(n) && n > 0) return n; } catch (e) {}
    if (chrome.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error("拿不到自己的调试端口");
}
class Cdp {
  constructor(ws){ this.ws = ws; this.id = 0; this.pending = new Map(); this.on = new Map(); }
  static async attach(port){
    let url;
    for (let i = 0; i < 60 && !url; i++) {
      try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
      if (!url) await sleep(200);
    }
    const s = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
    const c = new Cdp(s);
    s.onmessage = (e) => { const m = JSON.parse(e.data);
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result); }
      else if (m.method && c.on.has(m.method)) c.on.get(m.method)(m.params); };
    return c;
  }
  send(method, params = {}, ms = 8000){
    return new Promise((res, rej) => { const i = ++this.id;
      const t = setTimeout(() => { if (this.pending.delete(i)) rej(new Error("TIMEOUT")); }, ms);
      this.pending.set(i, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      try { this.ws.send(JSON.stringify({ id: i, method, params })); }
      catch (e) { clearTimeout(t); this.pending.delete(i); rej(e); } });
  }
}
const probe = async (cdp, label, fn) => {
  const t0 = Date.now();
  try { await fn(); return `${label}=OK(${Date.now() - t0}ms)`; }
  catch (e) { return `${label}=${String(e.message || e).slice(0, 12)}(${Date.now() - t0}ms)`; }
};

try {
  const port = await ownPort();
  const cdp = await Cdp.attach(port);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
  let dialogs = 0;
  cdp.on.set("Page.javascriptDialogOpening", () => { dialogs += 1; });

  await cdp.send("Page.navigate", { url: BASE });
  await sleep(1200);
  /* 让页面变脏：真实按键打一个字符。 */
  await cdp.send("Runtime.evaluate", { expression: `document.getElementById("i").focus()`, returnByValue: true });
  await cdp.send("Input.dispatchKeyEvent", { type:"keyDown", key:"a", windowsVirtualKeyCode:65, nativeVirtualKeyCode:65 });
  await cdp.send("Input.dispatchKeyEvent", { type:"char", text:"a", key:"a" });
  await cdp.send("Input.dispatchKeyEvent", { type:"keyUp", key:"a", windowsVirtualKeyCode:65, nativeVirtualKeyCode:65 });
  await sleep(200);

  console.log("=== 阶段 1：触发离开（预期弹 beforeunload），**不应答** ===");
  cdp.send("Page.navigate", { url: BASE + "/?second" }, 3000).catch(() => {});   // 故意不 await
  await sleep(1500);
  console.log("  对话框事件数 = " + dialogs);
  const r1 = [];
  r1.push(await probe(cdp, "Browser.getVersion", () => cdp.send("Browser.getVersion", {}, 1500)));
  r1.push(await probe(cdp, "Runtime.evaluate", () => cdp.send("Runtime.evaluate", { expression:"1", returnByValue:true }, 1500)));
  r1.push(await probe(cdp, "Input.dispatch", () => cdp.send("Input.dispatchKeyEvent", { type:"rawKeyDown", key:"Shift",
    windowsVirtualKeyCode:16, nativeVirtualKeyCode:16, code:"ShiftLeft" }, 1500)));
  console.log("  未应答时：" + r1.join("  "));

  console.log("\n=== 阶段 2：应答对话框，再复测同样三项 ===");
  const ans = await probe(cdp, "handleJavaScriptDialog", () => cdp.send("Page.handleJavaScriptDialog", { accept: true }, 3000));
  console.log("  " + ans);
  await sleep(800);
  const r2 = [];
  r2.push(await probe(cdp, "Browser.getVersion", () => cdp.send("Browser.getVersion", {}, 1500)));
  r2.push(await probe(cdp, "Runtime.evaluate", () => cdp.send("Runtime.evaluate", { expression:"1", returnByValue:true }, 1500)));
  r2.push(await probe(cdp, "Input.dispatch", () => cdp.send("Input.dispatchKeyEvent", { type:"rawKeyDown", key:"Shift",
    windowsVirtualKeyCode:16, nativeVirtualKeyCode:16, code:"ShiftLeft" }, 1500)));
  console.log("  应答之后：" + r2.join("  "));

  console.log("\n=== 阶段 3：清理生命周期 ===");
  const pid = chrome.pid;
  try { cdp.ws.close(); } catch (e) {}
  chrome.kill("SIGKILL");
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    await sleep(100);
    try { process.kill(pid, 0); } catch (e) { gone = true; }
  }
  console.log("  自己的 Chrome(pid " + pid + ") 已退出 = " + gone);
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  console.log("  临时 profile 已删除 = " + (!fs.existsSync(prof)));
  console.log("\n  判据：浏览器级 OK 而渲染级 TIMEOUT → (a) 对话框未应答挡住渲染进程；");
  console.log("        三者全 TIMEOUT → (b) CDP 通道/未决调用；应答后仍不恢复 → 同样归 (b)；");
  console.log("        跑得完却退不出/杀不掉 → (c) 清理生命周期。");
  cleanup(0);
} catch (e) {
  console.error("  诊断本身出错：" + (e && e.message));
  cleanup(1);
}
