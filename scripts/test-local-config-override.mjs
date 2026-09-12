// 本地联调旁路配置的安全性与有效性。
//
// ── 要防的是什么 ──────────────────────────────────────────────────────
// 门户要连后端必须有 URL 与 anon key，但 master 推送即公开发布
// （GitHub Pages 从 master 直发、无构建、无闸门）——
// 填进 assets/js/supabase-config.js 等于把配置公开。
//
// 所以本地联调走旁路文件 supabase-config.local.js（已 gitignore）。
// 这套测试证明三件事：
//   ① 本机回环上，旁路确实生效（否则联调用不了）；
//   ② **非回环主机上旁路完全不加载**（否则纵深防御就是空话）；
//   ③ 没有旁路文件时，站点照常走空配置的降级态（不能因为加了旁路就坏掉）。
//
// 本套件不连任何真实后端：填的是构造的 project ref 与字面占位串，
// 且 *.supabase.co 被钉到 0.0.0.0。**无真实凭据、零外网请求。**
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".webp":"image/webp",
  ".svg":"image/svg+xml", ".ico":"image/x-icon", ".woff2":"font/woff2" };

/* 本地旁路文件由测试自己造，跑完删掉 —— 不依赖仓库里存在这个文件，
   也不会把它留在工作树里。内容是构造值，不是凭据。 */
const LOCAL_CFG = path.join(ROOT, "assets", "js", "supabase-config.local.js");
const LOCAL_BODY =
  'window.SUPA = { url: "https://abcdefghijklmnopqrst.supabase.co",' +
  ' anonKey: "local-test-not-a-credential" };\n';
let hadLocalBefore = fs.existsSync(LOCAL_CFG);
let savedLocal = hadLocalBefore ? fs.readFileSync(LOCAL_CFG) : null;

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
// 绑到所有接口：需要既能用 127.0.0.1 访问，也能用一个**非回环**主机名访问
await new Promise((r) => server.listen(0, "0.0.0.0", r));
const PORT = server.address().port;

const prof = fs.mkdtempSync(path.join(os.tmpdir(), "amas-lcfg-"));
const port = 9408;
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
/* 关键：把一个假域名解析到 127.0.0.1，用它来模拟「发布站点」——
   页面拿到的 location.hostname 是那个域名，不是 127.0.0.1，
   于是旁路的回环判据应当不成立。同时把真 supabase 域名钉死，确保零外发。 */
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`, "--no-first-run", "--no-default-browser-check",
  "--host-resolver-rules=MAP amas-published.test 127.0.0.1, MAP *.supabase.co 0.0.0.0",
  "--disable-gpu", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

let externalHits = 0;

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
}

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail ? "  ← " + detail : "")); }
};

try {
  const cdp = await Cdp.attach(port);
  await cdp.send("Runtime.enable"); await cdp.send("Page.enable"); await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  cdp.on("Fetch.requestPaused", async (ev) => {
    try {
      const u = ev.request.url;
      if (u.indexOf("supabase.co") > -1 || u.indexOf("supabase.in") > -1) externalHits++;
      await cdp.send("Fetch.continueRequest", { requestId: ev.requestId });
    } catch (e) {}
  });

  const probe = async (origin) => {
    await cdp.send("Page.navigate", { url: `${origin}/portal/student/` });
    await sleep(2000);
    return cdp.ev(`({
      host: location.hostname,
      url: (window.SUPA && window.SUPA.url) || "",
      key: (window.SUPA && window.SUPA.anonKey) ? "(有值)" : "(空)",
      source: window.SUPA_SOURCE || "(无)",
      state: (window.AmasAuth && window.AmasAuth.CONFIG_STATE) || "(未加载)"
    })`);
  };

  // ════ A 没有旁路文件时：站点照常走空配置 ════
  console.log("\n=== A 没有旁路文件（仓库默认状态）===");
  if (fs.existsSync(LOCAL_CFG)) fs.unlinkSync(LOCAL_CFG);
  const a = await probe(`http://127.0.0.1:${PORT}`);
  ok("A1 没有旁路文件时 url 仍为空", a.url === "", JSON.stringify(a));
  ok("A2 门户判为 missing（照常降级）", a.state === "missing", JSON.stringify(a));
  ok("A3 不标记来源", a.source === "(无)");

  // ════ B 回环地址上：旁路生效 ════
  console.log("\n=== B 本机回环（127.0.0.1）：旁路应生效 ===");
  fs.writeFileSync(LOCAL_CFG, LOCAL_BODY);
  const b = await probe(`http://127.0.0.1:${PORT}`);
  ok("B1 旁路的 url 覆盖了空配置", /abcdefghijklmnopqrst\.supabase\.co/.test(b.url), JSON.stringify(b));
  ok("B2 anonKey 也被覆盖", b.key === "(有值)");
  ok("B3 标记来源为 local-override", b.source === "local-override", b.source);
  ok("B4 门户不再是 missing", b.state !== "missing", JSON.stringify(b));

  // ════ C 非回环主机：旁路必须完全不加载 ════
  // 这是整套里最要紧的一条 —— 它证明「就算旁路文件被误提交，线上也不会生效」。
  console.log("\n=== C 模拟发布站点（非回环主机名）：旁路必须不生效 ===");
  const c = await probe(`http://amas-published.test:${PORT}`);
  ok("C1 主机名确实不是回环", c.host === "amas-published.test", c.host);
  ok("C2 即使旁路文件存在，url 仍为空", c.url === "", JSON.stringify(c));
  ok("C3 anonKey 仍为空", c.key === "(空)", JSON.stringify(c));
  ok("C4 没有标记 local-override", c.source === "(无)", c.source);
  ok("C5 门户仍判 missing（与发布态一致）", c.state === "missing", JSON.stringify(c));

  // ════ D 负向控制 ════
  console.log("\n=== D 负向控制：绿必须能转红 ===");
  ok("D1 B 与 C 的结果确实不同（证明判据在起作用，不是两边都空）",
     b.url !== c.url && b.source !== c.source,
     `回环 ${b.source}/${b.url.slice(0, 20)} vs 非回环 ${c.source}/${c.url}`);
  fs.unlinkSync(LOCAL_CFG);
  const d = await probe(`http://127.0.0.1:${PORT}`);
  ok("D2 删掉旁路文件后回环也回到空配置（证明 B 的绿来自那个文件）",
     d.url === "" && d.source === "(无)", JSON.stringify(d));

  // ════ E 外发审计 ════
  console.log("\n=== E 外发审计 ===");
  ok("E1 全程零真实 supabase 请求", externalHits === 0, `externalHits=${externalHits}`);

  cdp.ws.close();
} catch (e) {
  fail++; console.log("  FAIL  套件异常: " + e.message);
} finally {
  chrome.kill(); server.close();
  // 还原工作树：测试造的文件删掉；原本就有的还回去
  try { if (fs.existsSync(LOCAL_CFG)) fs.unlinkSync(LOCAL_CFG); } catch {}
  try { if (hadLocalBefore && savedLocal) fs.writeFileSync(LOCAL_CFG, savedLocal); } catch {}
}

console.log(`\n${pass}/${pass + fail} 通过`);
console.log("本套件用构造的 project ref 与字面占位串，无真实凭据、零外网请求；" +
            "跑完已还原工作树，未留下任何配置文件。");
process.exit(fail ? 1 : 0);
