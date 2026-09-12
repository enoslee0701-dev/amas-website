/* 本地联调专用配置模板 —— 复制为 supabase-config.local.js 后填值。
 *
 * ┌─ 这个文件为什么存在 ─────────────────────────────────────────────┐
 * │ 门户要连后端必须有 URL 与 anon key，但直接写进                      │
 * │ assets/js/supabase-config.js 会被提交，而 master 推送即公开发布      │
 * │ （GitHub Pages 从 master 直发、无构建、无闸门）。                    │
 * │ 也就是说：填在那个文件里，等于把配置公开。                           │
 * │                                                                  │
 * │ 所以本地联调改用这个旁路文件：                                      │
 * │   supabase-config.local.js  已列入 .gitignore，不会被提交、不会发布   │
 * │   supabase-config.local.example.js  只有占位符，可以安全提交         │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * ★ 只放 anon（公开）key。**service_role key 永不进前端** ——
 *   它绕过 RLS，一旦出现在浏览器可读的文件里就等于把整个库交出去。
 *   scripts/check-portal-config.py 会把 service_role 判为 BLOCKED。
 * ★ 值从哪里取：Supabase 控制台 → Settings → API 的 Project URL 与
 *   anon public key。**不要从 App 仓的生产配置复制** —— 那是另一个环境，
 *   混用会让本地联调打到不该打的库上。
 * ★ 连哪个环境是**部署决策**，见 docs/operations/PORTAL-local-staging-setup.md。
 *
 * 用法：
 *   cp assets/js/supabase-config.local.example.js assets/js/supabase-config.local.js
 *   # 填入两个值后
 *   python scripts/check-portal-config.py --local
 */
window.SUPA = {
  url: "<在这里填 Project URL>",
  anonKey: "<在这里填 anon public key>",
};
