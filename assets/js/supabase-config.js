/* Supabase 连接配置 —— 建好项目后把两个值填入即可启用数据库通道
   （Settings → API：Project URL 与 anon public key）。留空 = 仅邮件通道，网站正常工作。

   ⚠ 这个文件会被提交，而 master 推送即公开发布（GitHub Pages 从 master 直发、
     无构建、无闸门）。所以**本地联调不要填这里** —— 填了等于把配置公开。
     本地联调用下面那个旁路：assets/js/supabase-config.local.js（已 gitignore）。 */
window.SUPA = {
  url: "",
  anonKey: ""
};

/* ── 本地联调旁路 ────────────────────────────────────────────────────
   只在本机回环地址上尝试加载 supabase-config.local.js；命中就用它覆盖上面两个值。

   为什么限制在回环地址：
     这是**唯一**能保证「旁路不会在发布站点上生效」的判据。就算哪天
     supabase-config.local.js 被误提交，线上域名也不满足这个条件，不会去加载它
     —— 纵深防御，而不是只靠 .gitignore 一道。

   为什么用同步 XHR 而不是 <script> 或 fetch：
     后面 24 个页面里紧跟着就是 auth.js，它在**加载时**读 window.SUPA 决定
     CONFIG_STATE。异步加载会来不及 —— auth.js 已经按空配置判成 missing 了。
     同步 XHR 在这里是对的工具：只在本机、只读一个小文件、只在开发时执行。 */
(function () {
  var host = location.hostname;
  var isLocal = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "";
  if (!isLocal) return;                       // 发布站点上这一段什么都不做
  try {
    var base = document.currentScript && document.currentScript.src
      ? document.currentScript.src.replace(/[^/]*$/, "")
      : "";
    var xhr = new XMLHttpRequest();
    xhr.open("GET", base + "supabase-config.local.js", false);   // 同步，见上
    xhr.send(null);
    if (xhr.status >= 200 && xhr.status < 300 && xhr.responseText) {
      // 用 Function 而不是 eval：作用域干净，且只影响 window.SUPA
      new Function(xhr.responseText).call(window);
      window.SUPA_SOURCE = "local-override";   // 供自检脚本与页面辨认来源
    }
  } catch (e) {
    /* 没有这个文件是**正常情况**（大多数时候就是没配）。
       静默跳过，保持上面那份空配置，门户照常走降级态。 */
  }
})();
