/* AMAS PORTAL-SHARED · 统一数据访问层
   原则（规范 §3.3 / §15.4）：
   - 页面不直接拼 REST；所有读写经此层，便于统一错误映射与审计回执
   - 错误一律转为 {code, message} 用户可读文案；绝不回传 SQL、表名、内部 ID、token
   - 前端不做授权判断，只做展示；真实权限由 RLS + RPC + Edge Function 强制 */
(function () {
  "use strict";

  const A = window.AmasAuth;
  if (!A) { console.error("[AmasApi] auth.js 必须先加载"); return; }

  /** 统一错误码 → 中文文案（不泄漏内部细节） */
  const MESSAGES = {
    not_configured: "系统尚未启用，请稍后再试。",
    unauthenticated: "登录状态已失效，请重新登录。",
    session_expired: "登录已过期，请重新登录。",
    forbidden: "你没有执行该操作的权限。",
    mfa_required: "该操作需要先完成两步验证。",
    not_found: "未找到相关记录。",
    conflict: "当前状态不允许该操作，请刷新后重试。",
    invalid_state: "当前状态不允许该操作，请刷新后重试。",
    validation_failed: "有必填项未完成或格式不正确。",
    duplicate: "已存在一条进行中的记录，无法重复创建。",
    rate_limited: "操作过于频繁，请稍后再试。",
    network: "网络连接异常，请检查网络后重试。",
    server_error: "服务暂时不可用，请稍后再试。",
    unknown: "操作未能完成，请稍后再试。",
  };
  const msg = (code) => MESSAGES[code] || MESSAGES.unknown;

  /** 把 supabase-js / HTTP 错误规范化 */
  function normalize(error, status) {
    if (!error) return null;
    const raw = String(error.message || error.error || error || "");
    let code = "unknown";
    if (status === 401 || /JWT|not authenticated|invalid token/i.test(raw)) code = "unauthenticated";
    else if (status === 403 || /permission denied|row-level security|insufficient/i.test(raw)) code = "forbidden";
    else if (status === 404) code = "not_found";
    else if (status === 409 || /duplicate key|unique constraint/i.test(raw)) code = "duplicate";
    else if (status === 429) code = "rate_limited";
    else if (/invalid .* transition|invalid_state/i.test(raw)) code = "invalid_state";
    else if (/validation|required|missing/i.test(raw)) code = "validation_failed";
    else if (status >= 500) code = "server_error";
    else if (/fetch|network/i.test(raw)) code = "network";
    // 仅在本地调试输出原始信息，线上不暴露
    if (location.hostname === "localhost") console.debug("[AmasApi]", status, raw);
    return { code, message: msg(code) };
  }

  const client = () => (A.CONFIGURED ? A.client : null);

  /** 表查询：返回 {data, error:{code,message}|null} */
  async function select(table, build) {
    const c = client();
    if (!c) return { data: null, error: { code: "not_configured", message: msg("not_configured") } };
    let q = c.from(table).select(build?.columns || "*");
    if (build?.eq) for (const [k, v] of Object.entries(build.eq)) q = q.eq(k, v);
    if (build?.in) for (const [k, v] of Object.entries(build.in)) q = q.in(k, v);
    if (build?.order) q = q.order(build.order.column, { ascending: !!build.order.asc, nullsFirst: false });
    if (build?.limit) q = q.limit(build.limit);
    if (build?.single) q = q.maybeSingle();
    const { data, error, status } = await q;
    return { data, error: normalize(error, status) };
  }

  async function update(table, match, patch) {
    const c = client();
    if (!c) return { data: null, error: { code: "not_configured", message: msg("not_configured") } };
    let q = c.from(table).update(patch);
    for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
    const { data, error, status } = await q.select();
    return { data, error: normalize(error, status) };
  }

  async function insert(table, row) {
    const c = client();
    if (!c) return { data: null, error: { code: "not_configured", message: msg("not_configured") } };
    const { data, error, status } = await c.from(table).insert(row).select().maybeSingle();
    return { data, error: normalize(error, status) };
  }

  /** 数据库 RPC */
  async function rpc(name, args) {
    const c = client();
    if (!c) return { data: null, error: { code: "not_configured", message: msg("not_configured") } };
    const { data, error, status } = await c.rpc(name, args || {});
    return { data, error: normalize(error, status) };
  }

  /** Edge Function（需要 aal2 的会先做前端预检，真正强制在服务端） */
  async function fn(name, body, opts) {
    if (!A.CONFIGURED) return { data: null, error: { code: "not_configured", message: msg("not_configured") } };
    if (opts && opts.requireAal2) {
      const aal = await A.getAal();
      if (aal.current !== "aal2") return { data: null, error: { code: "mfa_required", message: msg("mfa_required") } };
    }
    const r = await A.callFn(name, body);
    if (r.status === 200) return { data: r.data, error: null };
    const code = (r.data && r.data.error) || (r.status === 401 ? "unauthenticated" : "unknown");
    return { data: null, error: { code, message: msg(code) } };
  }

  window.AmasApi = { select, update, insert, rpc, fn, msg, normalize, MESSAGES };
})();
