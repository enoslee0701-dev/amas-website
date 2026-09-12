// 证明共享启动器给出的端口与 profile **确实归本次实例所有**，两个并行实例不串台。
//
// 旧写法的问题不是「端口挑得不好」，而是**挑完之后没有任何东西保证它仍归自己**：
//   const port = 9415;                       写死
//   const port = 9900 + (process.pid % 60);  按 pid 猜
// 「先探测空闲再假定永远归自己」也只是把窗口缩小。第二轮真的撞过一次。
//
// 这里最小地证三件事：
//   ① 两个**同时**启动的实例拿到的是不同端口、不同 profile；
//   ② 每个实例连上去之后，看到的是**自己那个**浏览器的页面（互相看不见对方的）；
//   ③ 端口是从自己 profile 的 DevToolsActivePort 读出来的，与该文件内容一致 ——
//      也就是说这个号是浏览器自己报的，不是我们猜的。
import fs from "node:fs";
import path from "node:path";
import { launchOwnChrome } from "./lib/chrome-launcher.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log("  PASS  " + n); }
  else { fail++; console.log("  FAIL  " + n + (d ? "  ← " + d : "")); } };

async function attachAndOpen(port, marker) {
  let url;
  for (let i = 0; i < 80 && !url; i++) {
    try { const j = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      url = j.find((x) => x.type === "page")?.webSocketDebuggerUrl; } catch {}
    if (!url) await sleep(150);
  }
  if (!url) throw new Error("连不上自己的调试端口 " + port);
  const ws = await new Promise((res, rej) => { const k = new WebSocket(url); k.onopen = () => res(k); k.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id;
    pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  // 每个实例在自己的页面上写一个只属于它的标记
  await send("Runtime.enable");
  await send("Runtime.evaluate", { expression: `window.__marker = ${JSON.stringify(marker)}; document.title = ${JSON.stringify(marker)};` });
  const read = async () => (await send("Runtime.evaluate",
    { expression: "window.__marker || null", returnByValue: true }))?.result?.result?.value ?? null;
  return { ws, read, send };
}

console.log("\n=== 两个并行实例 ===");
let a = null, b = null, ca = null, cb = null;
try {
  // 刻意**同时**起，把「两个进程几乎同时挑端口」这个最容易撞的时机构造出来
  [a, b] = await Promise.all([
    launchOwnChrome({ profilePrefix: "amas-lauA-" }),
    launchOwnChrome({ profilePrefix: "amas-lauB-" }),
  ]);
  ok("L1 两个实例拿到的端口不同", a.port !== b.port, `A=${a.port} B=${b.port}`);
  ok("L2 两个实例用的是不同 profile 目录", a.profileDir !== b.profileDir,
     `${path.basename(a.profileDir)} / ${path.basename(b.profileDir)}`);

  const fileA = Number(fs.readFileSync(path.join(a.profileDir, "DevToolsActivePort"), "utf8").split("\n")[0].trim());
  const fileB = Number(fs.readFileSync(path.join(b.profileDir, "DevToolsActivePort"), "utf8").split("\n")[0].trim());
  ok("L3 端口来自本实例自己的 DevToolsActivePort（浏览器自己报的，不是猜的）",
     fileA === a.port && fileB === b.port, `A 文件=${fileA} 实例=${a.port} / B 文件=${fileB} 实例=${b.port}`);

  ca = await attachAndOpen(a.port, "INSTANCE-A");
  cb = await attachAndOpen(b.port, "INSTANCE-B");
  const ra = await ca.read(), rb = await cb.read();
  ok("L4 A 连上去看到的是 A 自己的页面", ra === "INSTANCE-A", "读到 " + JSON.stringify(ra));
  ok("L5 B 连上去看到的是 B 自己的页面", rb === "INSTANCE-B", "读到 " + JSON.stringify(rb));
  ok("L6 两边互不串台（各自的标记没有互相覆盖）", ra !== rb, `${ra} vs ${rb}`);

  // 关掉 A，B 必须毫发无伤 —— 旧写法里两个进程共用一个浏览器时做不到
  a.dispose(); const disposedPort = a.port; a = null;
  await sleep(600);
  const rb2 = await cb.read();
  ok("L7 关掉 A 之后 B 照常工作（不是同一个浏览器）", rb2 === "INSTANCE-B", "读到 " + JSON.stringify(rb2));
  let aGone = false;
  try { await fetch(`http://127.0.0.1:${disposedPort}/json/list`); } catch (e) { aGone = true; }
  ok("L8 A 的端口随 A 一起消失（端口确实是它自己的）", aGone === true, "端口 " + disposedPort + " 仍可连=" + !aGone);
} catch (e) {
  fail++; console.log("  FAIL  启动器自检抛错 ← " + (e && e.message));
} finally {
  try { ca && ca.ws.close(); } catch (e) {}
  try { cb && cb.ws.close(); } catch (e) {}
  try { a && a.dispose(); } catch (e) {}
  try { b && b.dispose(); } catch (e) {}
}

console.log("\n──────────────────────────────");
console.log(`  PASS ${pass}  FAIL ${fail}`);
console.log("  只启动本次自己创建的两个 headless 实例；不连接任何既有浏览器。");
process.exit(fail ? 1 : 0);
