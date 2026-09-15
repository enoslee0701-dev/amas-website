/* 本机测试服务器一律**不伺服** supabase-config.local.js。

   为什么（INCIDENT-0916，见 BLOCKED.md）：
     assets/js/supabase-config.js 在回环地址上会同步加载 supabase-config.local.js（本地联调旁路）。
     开发机上这份文件往往是**真实填好的**配置；探针又都跑在 127.0.0.1 上，于是页面拿到真实 url / anonKey，
     一提交表单，main.js 的 logToDB、giving.html 的写库分支就会往**真实 Supabase** 写测试数据。
     2026-09-16 实测 test-chat-timeout / test-giving-submit 都发出了指向真实项目 /rest/v1/submissions 的请求。

   用法（在读磁盘之前调用）：
     let p = decodeURIComponent(req.url.split("?")[0]);
     if (refuseLocalConfig(p, res)) return;

   与 lib/chrome-launcher.mjs 的后端域名钉死（*.supabase.co → 0.0.0.0）是两道独立的防线。
   scripts/test-probe-network-guard.mjs 核对每个带测试服务器的脚本都接了这一行。 */
export const LOCAL_CONFIG_RE = /(^|\/)supabase-config\.local\.js$/i;

export function refuseLocalConfig(urlPath, res) {
  if (!LOCAL_CONFIG_RE.test(String(urlPath || ""))) return false;
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end("test servers never serve supabase-config.local.js");
  return true;
}
