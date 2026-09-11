/* AMAS 门户 · 认证与路由守卫（Phase 1）
   依赖：assets/js/supabase-config.js（window.SUPA）+ supabase-js v2 CDN
   规范约束：§5 登录注册 · §5.4 角色导航 · §15.4 真实状态（未启用时不得假装可用） */
(function () {
  "use strict";

  const SUPA = window.SUPA || { url: "", anonKey: "" };

  // 占位符判据与 scripts/check-portal-config.py 的 is_placeholder 保持一致：
  // "https://<project-ref>.supabase.co" 这类模板值是「还没填」，不是「填错了」。
  const PLACEHOLDER = /^(your|<|xxx+|todo|changeme|replace|placeholder|example)|[<>]|your[-_ ]?project|yourproject/i;
  const filled = (v) => { const s = String(v == null ? "" : v).trim(); return !!s && !PLACEHOLDER.test(s); };

  const HAS_CONFIG = filled(SUPA.url) && filled(SUPA.anonKey);
  const HAS_SDK = !!window.supabase;

  // 「门户不可用」有两个完全不同的原因，用户要做的事也完全不同：
  //   missing         —— 学校还没开通数据库环境，用户再刷新一百次也没用，只能等/联系同工。
  //   sdk-unavailable —— 配置是齐的，是 supabase-js 这个 CDN 脚本没拉下来（网络受限、
  //                      被墙、离线、拦截插件）。刷新或换网络就能好。
  // 以前两种都套同一句「正在部署中（等待数据库环境开通）」：对后一种来说那是假话，
  // 而且把唯一有效的自救动作（重试）藏起来了。AMAS 的学员在泰国/中国大陆，
  // jsdelivr 打不开是常态而非边缘情况。
  const CONFIG_STATE = HAS_CONFIG ? (HAS_SDK ? "ready" : "sdk-unavailable") : "missing";
  const CONFIGURED = CONFIG_STATE === "ready";

  /** 目录式路由的站点根（GitHub Pages 项目页需带仓库前缀） */
  function siteRoot() {
    const p = location.pathname;
    const marker = p.match(/^(.*?)\/(login|register|forgot-password|help|apply|faculty|auth|portal)\//);
    if (marker) return marker[1] + "/";
    return p.replace(/[^/]*$/, "");
  }

  const ROOT = siteRoot();
  const ROLE_HOME = {
    super_admin: "portal/admin/",
    academic_admin: "portal/admin/",
    registrar: "portal/admin/",
    content_admin: "portal/admin/",
    finance: "portal/admin/",
    teacher: "portal/teacher/",
    mentor: "portal/teacher/",
    student: "portal/student/",
    applicant: "portal/applicant/",
  };
  const ROLE_RANK = ["super_admin","academic_admin","registrar","content_admin","finance","teacher","mentor","student","applicant"];

  let client = null;
  if (CONFIGURED) client = window.supabase.createClient(SUPA.url, SUPA.anonKey);

  async function getSession() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session || null;
  }

  async function getRoles() {
    if (!client) return [];
    const { data, error } = await client.rpc("my_roles");
    if (error) return [];
    return (data || []).map((r) => r.role);
  }

  async function getProfile() {
    if (!client) return null;
    const { data, error } = await client.rpc("my_profile");
    if (error) return null;
    return data;
  }

  function homeForRoles(roles) {
    const distinct = ROLE_RANK.filter((r) => roles.includes(r));
    if (distinct.length === 0) return ROOT + "portal/applicant/";
    // 多“工作空间”角色 → 选择页；否则直达
    const spaces = new Set(distinct.map((r) => ROLE_HOME[r]));
    if (spaces.size > 1) return ROOT + "portal/";
    return ROOT + ROLE_HOME[distinct[0]];
  }

  /** 登录页调用：邮箱或学号 + 密码。学号走受保护 Edge Function（§5.3），不在前端解析别名 */
  async function signIn(identifier, password) {
    if (!CONFIGURED) return { error: "not_configured" };
    const id = String(identifier || "").trim();
    if (!id || !password) return { error: "invalid_input" };
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
    if (isEmail) {
      const { error } = await client.auth.signInWithPassword({ email: id.toLowerCase(), password });
      if (error) return { error: "bad_credentials" };
      return {};
    }
    // 学号/教职工号：调用服务端登录代理
    try {
      const res = await fetch(SUPA.url + "/functions/v1/login-by-identifier", {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPA.anonKey, Authorization: "Bearer " + SUPA.anonKey },
        body: JSON.stringify({ identifier: id, password }),
      });
      if (!res.ok) {
        if (res.status === 404) return { error: "alias_login_unavailable" };
        if (res.status === 429) return { error: "rate_limited" };
        return { error: "bad_credentials" };
      }
      const payload = await res.json();
      if (!payload || !payload.access_token) return { error: "bad_credentials" };
      const { error } = await client.auth.setSession({
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
      });
      if (error) return { error: "bad_credentials" };
      return {};
    } catch (e) {
      return { error: "network" };
    }
  }

  async function signUp(email, password, displayName) {
    if (!CONFIGURED) return { error: "not_configured" };
    const { error } = await client.auth.signUp({
      email: String(email || "").trim().toLowerCase(),
      password,
      options: {
        data: { display_name: displayName || "" },
        emailRedirectTo: location.origin + ROOT + "auth/callback/",
      },
    });
    if (error) {
      if (/registered/i.test(error.message)) return { error: "exists" };
      if (/password/i.test(error.message)) return { error: "weak_password" };
      return { error: "signup_failed" };
    }
    return {};
  }

  async function resetPassword(email) {
    if (!CONFIGURED) return { error: "not_configured" };
    // D-AUTH-R2：canonical recovery route 统一为 /auth/recovery。
    // 旧的 auth/callback/?type=recovery 仅在迁移期由兼容层识别，不再作为签发目标。
    // production 的精确 allow list 见 docs/operations/AUTH-production-auth-config.md。
    const { error } = await client.auth.resetPasswordForEmail(String(email || "").trim().toLowerCase(), {
      redirectTo: location.origin + ROOT + "auth/recovery/",
    });
    if (error) return { error: "reset_failed" };
    return {};
  }

  async function signOut() {
    if (client) await client.auth.signOut();
    location.href = ROOT + "login/";
  }

  /** 门户页守卫：未配置→引导页真实状态；未登录→/login；角色不符→自己的首页（§5.4 禁止越权切换） */
  async function requireRole(allowedRoles) {
    if (!CONFIGURED) {
      renderDisabled();
      return null;
    }
    const session = await getSession();
    if (!session) {
      location.replace(ROOT + "login/?next=" + encodeURIComponent(location.pathname));
      return null;
    }
    const roles = await getRoles();
    const ok = allowedRoles.some((r) => roles.includes(r));
    if (!ok) {
      location.replace(homeForRoles(roles));
      return null;
    }
    return { session, roles };
  }

  /** 门户不可用时的整页降级。state 省略时按当前实际情况判断。
      两种原因必须分开说，因为用户该做的事不一样（见 CONFIG_STATE 处的说明）。 */
  function renderDisabled(state) {
    const why = state || CONFIG_STATE;
    const offline = why === "sdk-unavailable";
    // 按钮/链接一律 44 高：降级页也是真人要点的页面，不因为它是错误页就降标准。
    const BTN = "display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;" +
      "min-height:44px;margin-top:14px;padding:10px 22px;border-radius:999px;font-size:14px;" +
      "text-decoration:none;border:0;cursor:pointer;font-family:inherit";
    const head = offline ? "门户暂时打不开" : "门户系统尚未启用";
    const body = offline
      ? "登录组件没能加载成功，通常是当前网络连不上外部资源（境内网络、离线或拦截插件都会这样）。<br>换个网络或稍后重新载入即可；如果一直不行，请通过官网联系招生同工。"
      : "账号与学习系统正在部署中（等待数据库环境开通），目前暂不可登录。<br>如需咨询，请通过官网联系招生同工。";
    // 只有「可重试」的那种才给重试按钮 —— 没开通时按一百次刷新也没用，给了反而是误导。
    const retry = offline
      ? '<button type="button" id="portalRetry" style="' + BTN + ';background:#102f55;color:#fff">重新载入</button> '
      : "";
    const homeStyle = BTN + (offline
      ? ";background:#fff;color:#102f55;border:1px solid #c3ccdb"
      : ";background:#102f55;color:#fff");

    document.body.innerHTML =
      '<div style="max-width:520px;margin:16vh auto;padding:34px;border:1px solid #d9dee8;border-radius:14px;background:#fff;font-family:\'Microsoft YaHei\',sans-serif;text-align:center;color:#202735">' +
      '<div style="font-size:34px" aria-hidden="true">' + (offline ? "📡" : "🔧") + "</div>" +
      '<h1 id="portalDisabledTitle" tabindex="-1" style="font-size:19px;color:#102f55;margin:10px 0;outline:none">' + head + "</h1>" +
      "<p style='font-size:13.5px;line-height:1.9;color:#5e6879'>" + body + "</p>" +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center">' + retry +
      '<a href="' + ROOT + 'index.html" style="' + homeStyle + '">返回官网</a></div></div>';
    document.body.style.background = "#f4f6f9";

    // 标题栏原本还写着「学员中心 | AMAS」——书签、历史记录、读屏软件都会照读，
    // 等于对着一个打不开的页面宣称它是学员中心。
    document.title = head + " | AMAS";

    const btn = document.getElementById("portalRetry");
    if (btn) btn.addEventListener("click", () => location.reload());
    // body 是被整段换掉的，焦点会掉回 body。把它交给标题，
    // 键盘用户下一次 Tab 才从这里往下走，读屏也才会念出真实状态。
    const h = document.getElementById("portalDisabledTitle");
    if (h) { try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); } }
  }

  /** 当前/可达的认证保障级别（MFA）。返回 {current:'aal1'|'aal2', next:'aal1'|'aal2'} */
  async function getAal() {
    if (!client) return { current: "aal1", next: "aal1" };
    const { data, error } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return { current: "aal1", next: "aal1" };
    return { current: data.currentLevel, next: data.nextLevel };
  }

  /** 敏感角色（教师/管理员）页面守卫：requireRole 之上强制 aal2（甲方审查 #8 前端层）。
      未注册 MFA 或未完成挑战时跳 /portal/mfa/，完成后回跳。数据面仍由 Edge/DB 双重校验。 */
  async function requireRoleAal2(allowedRoles) {
    const ctx = await requireRole(allowedRoles);
    if (!ctx) return null;
    const aal = await getAal();
    if (aal.current !== "aal2") {
      location.replace(ROOT + "portal/mfa/?next=" + encodeURIComponent(location.pathname));
      return null;
    }
    return ctx;
  }

  /** 调用受保护 Edge Function（自动携带用户 JWT） */
  async function callFn(name, payload) {
    const session = await getSession();
    if (!session) return { status: 401, data: { error: "unauthenticated" } };
    const res = await fetch(SUPA.url + "/functions/v1/" + name, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPA.anonKey,
        Authorization: "Bearer " + session.access_token,
      },
      body: JSON.stringify(payload || {}),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* noop */ }
    return { status: res.status, data };
  }

  window.AmasAuth = {
    CONFIGURED, CONFIG_STATE, ROOT, client,
    getSession, getRoles, getProfile, homeForRoles,
    signIn, signUp, resetPassword, signOut, requireRole, renderDisabled,
    getAal, requireRoleAal2, callFn,
  };
})();
