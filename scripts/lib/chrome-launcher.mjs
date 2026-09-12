/* 共享的 Chrome 启动器：**本次实例真正拥有**自己的调试端口和 profile。
   ────────────────────────────────────────────────────────────────────
   为什么不能沿用旧写法：

     const port = 9415;                       // 写死
     const port = 9900 + (process.pid % 60);  // 由 pid 猜

   两种都只是「挑一个大概没人用的号」。挑完到连上去之间没有任何东西保证它
   仍然归自己 —— 另一个进程（别的套件、监督侧的独立复现、别的项目）可以在
   这中间占掉同一个号。第二轮就真的撞过一次：两个进程连到同一个浏览器目标，
   跑出一组看着像回归、实则是串台的假红（详情里出现的是**别的用例**的数据）。
   「先探测空闲再假定永远归自己」同样不行，那只是把窗口缩小，没有消除它。

   这里改成让操作系统分配：`--remote-debugging-port=0`，然后从**本进程自己
   启动的那个 Chrome** 的 `<user-data-dir>/DevToolsActivePort` 把实际端口读回来。
   这个文件是那个浏览器自己写的，读到什么就是什么，不是猜的。
   读不到就直接抛错退出 —— **绝不回退到猜端口，也绝不去连已经开着的浏览器**。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome 可执行文件：两个变量名都认（历史上 CHROME 与 CHROME_PATH 并存）。 */
export function chromeBinary() {
  return process.env.CHROME_PATH || process.env.CHROME ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

/**
 * 启动一个只属于本次调用的 headless Chrome。
 * @param {object} opts
 * @param {string} [opts.profilePrefix]  临时 profile 目录前缀，便于在 ps 里认出是谁的
 * @param {string[]} [opts.extraArgs]    该套件自己的额外参数（如 host-resolver-rules）
 * @param {number} [opts.timeoutMs]      等 DevToolsActivePort 出现的上限
 * @returns {Promise<{chrome:import("node:child_process").ChildProcess, port:number,
 *                    profileDir:string, dispose:()=>void}>}
 */
export async function launchOwnChrome(opts = {}) {
  const prefix = opts.profilePrefix || "amas-cdp-";
  const timeoutMs = opts.timeoutMs || 15000;
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",          // ← 由操作系统分配，不是我们挑的
    `--user-data-dir=${profileDir}`,      // ← 每次一个全新目录，不共用任何既有 profile
    "--no-first-run", "--no-default-browser-check",
    ...(opts.extraArgs || []),
    "--disable-gpu", "--hide-scrollbars", "about:blank",
  ];
  const chrome = spawn(chromeBinary(), args, { stdio: "ignore" });

  const portFile = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  let port = 0;
  while (Date.now() < deadline) {
    try {
      const first = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
      const n = Number(first);
      if (Number.isInteger(n) && n > 0) { port = n; break; }
    } catch (e) { /* 还没写出来 */ }
    if (chrome.exitCode !== null) break;
    await sleep(80);
  }

  const dispose = () => {
    try { chrome.kill(); } catch (e) {}
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}
  };

  if (!port) {
    dispose();
    throw new Error(
      "没能从本次启动的 Chrome 取得独占调试端口（" + portFile + " 未出现）。\n" +
      "  本启动器**不会**回退到猜一个端口，也**不会**连接任何已经开着的浏览器 —— 直接失败退出。\n" +
      "  Chrome 可执行文件：" + chromeBinary());
  }
  return { chrome, port, profileDir, dispose };
}
