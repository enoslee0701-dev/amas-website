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

  /** 角色读取的**真实结果**：`{ roles, failed }`。

      旧的 `getRoles()` 出错时也返回 `[]`，于是「读不到角色」和「确实没有角色」
      在调用方眼里完全一样。这一个字符不差的等价，配上
      `homeForRoles([])` → `portal/applicant/` 而该页又要求 applicant 角色，
      就是门户页之间的**无限重定向**：replace 到同一地址、守卫再不通过、再 replace。

      而且触发面比「新用户还没角色」宽得多 —— `my_roles` 抖一下、
      RLS 改一次、RPC 短暂不可用，都会走到同一条死路。

      这和注册/登录反复修的是同一条纪律：**不确定不能当成确定**。 */
  async function fetchRoles() {
    if (!client) return { roles: [], failed: true };
    let res;
    try { res = await client.rpc("my_roles"); }
    catch (e) { return { roles: [], failed: true }; }
    if (!res || res.error) return { roles: [], failed: true };
    return { roles: (res.data || []).map((r) => r.role), failed: false };
  }

  /** 兼容旧签名：只要数组。**新代码别用** —— 它没法表达「读不到」。 */
  async function getRoles() {
    const r = await fetchRoles();
    return r.roles;
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

  /** 回跳参数（?next=）只接受**本站内**的路径，否则一律返回 null。

      登录页与 MFA 页原先的判据都是 `next.startsWith("/")`。
      但 `//evil.example` 也以 "/" 开头 —— 那是协议相对 URL，
      浏览器会当成 `https://evil.example` 跳出去。
      于是一条域名看起来完全是学院的链接
      （`…/login/?next=//evil.example`），能把刚登录完的用户送到别人站上；
      MFA 页更糟，那是刚过完两步验证的已登录用户。

      判据交给 URL 解析器比一次 origin，而不是手写前缀判断：
      反斜杠、百分号编码、大小写、多余的斜杠这些花样都由解析器统一处理，
      不靠我逐个去猜。 */
  function safePath(raw) {
    if (!raw) return null;
    let u;
    try { u = new URL(String(raw), location.origin); } catch (e) { return null; }
    if (u.origin !== location.origin) return null;

    /* ── 只查一次 origin 是不够的 ────────────────────────────────────────
       上一版到这里就 return 了 `u.pathname + u.search + u.hash`。
       但**真正交给 location 的是这个重新拼出来的串，不是 u**，
       而它再解析一次可能落到完全不同的地方：

         "/.//evil.example"       → 首轮同源，pathname 是 "//evil.example"
         "/%2e//evil.example"     → 同上（编码过的点段）
         "/a/../..//evil.example" → 同上（多级回退越过根）
         "https://<本站>//evil.example" → 同源绝对 URL，pathname 仍是 "//evil.example"

       这些串首轮 origin 全是本站，可是 "//evil.example" 交给 location
       就是协议相对 URL —— 人直接到了站外。
       校验输入、却把另一个串交出去，等于没校验。

       所以判据改成**不动点**：把真正要交出去的那个串再解析一次，
       必须仍然同源，而且必须落到跟第一次完全相同的地方（href 相等）。
       对不上就说明这个串换个上下文会变意思，一律拒绝。
       仍然全部交给 URL 解析器判，不手写前缀模式去猜。 */
    const out = u.pathname + u.search + u.hash;
    let again;
    try { again = new URL(out, location.origin); } catch (e) { return null; }
    if (again.origin !== location.origin) return null;
    if (again.href !== u.href) return null;
    return out;
  }

  /** 登录失败的分类。判据与注册共用 classifyAuthError（同一份 SDK 错误契约），
      但结论不同：**登录失败没有副作用** —— 没建账号、没发信、没写任何东西，
      所以「结果不明」不必锁住按钮，用户可以直接再试。
      要紧的只有一件：**不能把「连不上」说成「密码不对」**。
      而明确被拒时一律统一文案，不区分账号是否存在（§5.3）。 */
  function signInErrorCode(e) {
    const c = classifyAuthError(e);
    if (c.kind === "unknown") {
      if (c.reason === "network" || c.reason === "exception") return "network";
      if (c.reason === "server") return "server";
      return "unknown";
    }
    // 明确拒绝。429 不涉及账号是否存在，可以如实说；其余一律统一文案。
    if (e && e.status === 429) return "rate_limited";
    return "bad_credentials";
  }

  /** 登录页调用：邮箱或学号 + 密码。学号走受保护 Edge Function（§5.3），不在前端解析别名 */
  async function signIn(identifier, password) {
    if (!CONFIGURED) return { error: "not_configured" };
    const id = String(identifier || "").trim();
    if (!id || !password) return { error: "invalid_input" };
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id);
    if (isEmail) {
      /* 以前这里是 `if (error) return { error: "bad_credentials" }` ——
         断网、网关 5xx、响应解析不出来，全都被说成「账号或密码不正确」。
         那是在用户什么都没做错的时候指责用户，还会让人反复改密码。 */
      let r;
      try {
        r = await client.auth.signInWithPassword({ email: id.toLowerCase(), password });
      } catch (e) {
        // SDK 只重新抛出它自己都不认的错误，这种更谈不上是凭据问题
        return { error: signInErrorCode(e) };
      }
      if (r && r.error) return { error: signInErrorCode(r.error) };
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
        // 5xx 和 408 同样不是凭据问题，不能说成密码不对
        if (res.status >= 500 || res.status === 408) return { error: "server" };
        return { error: "bad_credentials" };
      }
      let payload = null;
      try { payload = await res.json(); }
      catch (e) { return { error: "unknown" }; }   // 网关返回 HTML 之类：结果不明，不是凭据错
      if (!payload || !payload.access_token) return { error: "unknown" };
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

  /* ── Auth 错误分类：明确拒绝 vs 结果不明 ──────────────────────────────
     判据不是猜的，取自 supabase-js 2.116.0 产物里的错误类定义与 fetch 包装：

       · fetch 本身抛错（断网、DNS、被拦截、CORS） → AuthRetryableFetchError(msg, 0)
       · 响应状态 ∈ [500,501,502,503,504,520…530]  → AuthRetryableFetchError(msg, status)
       · 响应体解析不出来且非上述状态              → AuthUnknownError
       · 其余（4xx）按响应体里的 code 建 AuthApiError / AuthWeakPasswordError
       · signUp 的 catch 只在 `__isAuthError` 时把错误当返回值，**其余一律重新抛出**

     只有最后一类 4xx 才是「服务器看懂了请求并明确拒绝」——账号确实没建。
     前面几类都意味着**请求可能已经到达服务器并完成注册，只是回执丢了**。
     把它们一律当成失败并让用户直接再点一次，等于诱导重复注册；
     这与审核台「未知结果先核实、不直接重发」是同一条纪律。 */
  function classifyAuthError(e) {
    if (!e || typeof e !== "object") return { kind: "unknown", reason: "exception" };
    const status = typeof e.status === "number" ? e.status : null;
    // 可重试类：status 0 = 请求没走通或回执丢了；非 0 = 服务端 5xx
    if (e.name === "AuthRetryableFetchError") {
      return { kind: "unknown", reason: (status === 0 || status === null) ? "network" : "server" };
    }
    if (e.name === "AuthUnknownError") return { kind: "unknown", reason: "unreadable" };
    // 408 虽然是 4xx，语义却是超时 —— 不能据此断定服务器什么都没做
    if (status === 408) return { kind: "unknown", reason: "server" };
    if (status !== null && status >= 500) return { kind: "unknown", reason: "server" };
    // 不是 AuthError 的抛出物：SDK 自己都不认，我们更不能替它下结论
    if (!e.__isAuthError) return { kind: "unknown", reason: "exception" };
    if (status !== null && status >= 400 && status < 500) return { kind: "rejected" };
    // 是 AuthError 却没有可判读的 status：保守归为不明
    return { kind: "unknown", reason: "unreadable" };
  }

  /** 已判定为「明确拒绝」之后，再细分给用户看的原因。
      weak_password 这个 code 由 AuthWeakPasswordError 直接写死，可靠；
      其余沿用消息匹配，匹不上就落到 rejected（明确被拒，但说不出具体原因）。 */
  function rejectReason(e) {
    const msg = String((e && e.message) || "");
    if (e && e.code === "weak_password") return "weak_password";
    if (/registered/i.test(msg)) return "exists";
    if (/password/i.test(msg)) return "weak_password";
    return "rejected";
  }

  /** 注册。
      以前这里只解构 `{ error }`，把「没报错」一律当成「验证邮件已发出」——
      这是错的。supabase-js v2（当前 CDN 上 `@2` 解析到 2.116.0）的 `signUp`
      返回 `{ data: { user, session }, error }`，**成功分支有两种完全不同的结果**：

        · `data.session` 非空 —— 账号已建立**并且已经登录**。
          服务端没有要求邮箱验证（本项目 staging 就是 `mailer_autoconfirm = true`），
          因此**根本没有发任何验证邮件**。此时跟用户说「请查收验证邮件」是纯粹的谎话。
        · `data.session` 为空、`data.user` 非空 —— 服务端受理了，需先完成邮箱验证才能登录。
          注意这一支**不能断言「新账号已创建」**：开启邮箱验证时，GoTrue 对
          「邮箱已被注册」会故意返回一个不带 identity 的 user 且不报错（防账号枚举），
          与真正的新注册在客户端无法区分——也不应该区分。

      另外 `data.session` 只意味着「登录了」，不意味着拿到门户角色、更不意味着申请通过。
      角色由 `my_roles` 决定，页面守卫自己会判。这里不替它下结论。 */
  async function signUp(email, password, displayName) {
    if (!CONFIGURED) return { status: "error", error: "not_configured" };
    let res;
    try {
      res = await client.auth.signUp({
        email: String(email || "").trim().toLowerCase(),
        password,
        options: {
          data: { display_name: displayName || "" },
          emailRedirectTo: location.origin + ROOT + "auth/callback/",
        },
      });
    } catch (e) {
      // 异常绝不能穿过去（调用方会永远停在「提交中…」），
      // 但接住之后也**不能当成「注册失败」**：signUp 只会重新抛出它自己都不认的
      // 错误，这种情况下请求是否已经在服务器完成，客户端根本无从判断。
      const c = classifyAuthError(e);
      if (c.kind === "rejected") return { status: "error", error: rejectReason(e) };
      return { status: "unknown", reason: c.reason };
    }
    const data = res && res.data;
    const error = res && res.error;
    if (error) {
      const c = classifyAuthError(error);
      if (c.kind !== "rejected") return { status: "unknown", reason: c.reason };
      return { status: "error", error: rejectReason(error) };
    }
    if (data && data.session) return { status: "session" };
    if (data && data.user) return { status: "pending" };
    // 没报错，却既没有 session 也没有 user：结果不明。
    // 不能报成功，也不能报失败——更不能自动重发。
    return { status: "unknown", reason: "blank" };
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

  /* 主动退出会让 SDK 触发 SIGNED_OUT，而门户外壳正是靠这个事件判「会话失效」。
     两者不加区分的话，**自己点退出的人会被告知「登录已过期」**，
     而且外壳会带上 ?next=<刚退出的那一页>，下次登录又被悄悄拖回去。
     用这个标志把「我自己走的」和「被踢出去的」分开。 */
  let leavingOnPurpose = false;
  function isSigningOut() { return leavingOnPurpose; }

  async function signOut() {
    leavingOnPurpose = true;
    // 退出是**不带 next 的**：用户刚刚明确表示要离开那一页。
    try { if (client) await client.auth.signOut(); }
    catch (e) { /* 本地会话已清，网络回执失败不该把人卡在页面上 */ }
    location.replace(ROOT + "login/");
  }

  /* ── 会话失效监听（§5.6）────────────────────────────────────────────
     这段原先只长在 shell.js 的 Shell.mount 里，于是门户下**不走外壳的三页**
     （portal/index.html 选择工作空间、portal/mfa/ 两步验证、
       portal/admin/ 管理总览）在会话失效时是**完全静默**的：
     令牌刷新失败 → SDK 经 _removeSession 发出 SIGNED_OUT → 没有人听 →
     页面继续摆着身份与入口，用户点下去才一路 401，自己不知道已经被登出。
     所以实现挪到这里共用，外壳与那三页调同一份，不各写一遍。

     ① 只认 SIGNED_OUT。supabase-js v2 的事件表是 INITIAL_SESSION /
        SIGNED_IN / SIGNED_OUT / PASSWORD_RECOVERY / TOKEN_REFRESHED /
        USER_UPDATED（官方 JS 参考 auth-onauthstatechange，2026-09-12 核对）。
        **没有 `TOKEN_REFRESHED_FAILED` 这个事件** —— 曾经监听过它，那一支
        永远不会执行，留着只制造「刷新失败已处理」的假象。刷新失败最终就是
        经 _removeSession 发出 SIGNED_OUT，兜住它的一直是这一支。别再加回去。

     ② 回调保持**同步**，而且不在里面调任何 SDK 方法。官方对这个回调的说法是
        「safe to use without an async function as callback」；回调是在 auth
        的锁内被调用的，在里面 await SDK 会把自己锁死。导航也用 setTimeout
        推到回调之外再做。

     ③ **只订阅一次**。页面脚本、外壳、将来别的调用方可能各调一次，重复订阅
        会让同一次失效弹多次提示、发多次导航，互相竞争。

     ④ 主动退出与过期共用 SIGNED_OUT 这一个事件，必须分开：自己点退出的人
        不该被告知「登录已过期」（不实），也不该被带上 ?next=<刚离开的那一页>
        下次登录又被悄悄拖回去。

     ⑤ sessionEnded() 是给**晚返回的 async** 用的。那三页都是 await 之后才
        渲染或跳转；会话在 await 期间断掉，返回那一刻代码照样把人送进受保护
        区域 —— 等于拿一个已经死掉的会话做导航决策。调用方在 await 之后、
        渲染或跳转之前问一次，该让位就让位。 */
  let sessionWatch = null;
  let sessionOver = false;

  /** 会话是否已经结束（过期或主动退出）。晚返回的 async 渲染/导航据此让位。 */
  function sessionEnded() { return sessionOver; }

  /** 内置提示。不走外壳的三页没有 ui.js，不能依赖 AmasUI.toast；
      也不能像 renderBlocked 那样整段换掉 body —— 那会把用户正在填的
      验证码一起抹掉，而这一刻页面还要停 1.2 秒才跳走。 */
  function sessionNotice(text) {
    let el = document.getElementById("amasSessionNotice");
    if (!el) {
      el = document.createElement("div");
      el.id = "amasSessionNotice";
      el.setAttribute("role", "alert");
      el.style.cssText = "position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9999;" +
        "box-sizing:border-box;max-width:92vw;padding:12px 20px;border-radius:10px;" +
        "background:#b3261e;color:#fff;text-align:center;" +
        "font:500 14px/1.6 'Microsoft YaHei',sans-serif;box-shadow:0 6px 22px rgba(16,47,85,.24)";
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  /** 挂上会话失效监听。重复调用只订阅一次，返回同一个订阅句柄。
      opts.notify —— 自定义提示（外壳传 AmasUI.toast）；省略时用内置提示。 */
  function watchSession(opts) {
    if (!client) return null;
    if (sessionWatch) return sessionWatch;
    const o = opts || {};
    const notify = typeof o.notify === "function" ? o.notify : sessionNotice;
    const delay = typeof o.delay === "number" ? o.delay : 1200;

    const res = client.auth.onAuthStateChange(function (event) {
      if (event !== "SIGNED_OUT") return;
      sessionOver = true;
      if (leavingOnPurpose) return;            // 自己走的，signOut 负责去向
      try { notify("登录已过期，正在返回登录页…"); } catch (e) {}
      // next 连 query 与 hash 一起带上，否则回来时页内位置与筛选条件都没了。
      // 同源收口仍由登录页的 safePath 把关。
      const back = location.pathname + location.search + location.hash;
      setTimeout(function () {
        location.replace(ROOT + "login/?next=" + encodeURIComponent(back));
      }, delay);
    });
    sessionWatch = (res && res.data && res.data.subscription) || { unsubscribe: function () {} };
    return sessionWatch;
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
    const { roles, failed } = await fetchRoles();

    // 读不到角色 ≠ 没有角色。这时候什么都不能断定，更不能把人弹走。
    if (failed) { renderBlocked("roles-unavailable"); return null; }

    // 读到了，确实一个角色都没有：如实说，给出口，**不跳转**。
    if (roles.length === 0) { renderBlocked("no-roles"); return null; }

    const ok = allowedRoles.some((r) => roles.includes(r));
    if (!ok) {
      /* 有角色但不匹配：回自己的首页。
         但**跳向自己就是死循环**，所以先比一次目标和当前位置；
         相同就停下来如实说，不再 replace。
         这是最后一道闸 —— 即使将来 homeForRoles 又算出一个指向本页的地址，
         也只会停在一个说明页，不会把浏览器卡死。 */
      const target = homeForRoles(roles);
      const here = location.pathname.replace(/index\.html$/, "");
      const to = String(target).replace(/index\.html$/, "");
      if (to === here) { renderBlocked("forbidden"); return null; }
      location.replace(target);
      return null;
    }
    return { session, roles };
  }

  /** 权限相关的整页停靠。**它存在的意义是「停下来」** ——
      这三种情况以前都会变成一次 location.replace，而其中两种会跳回自己。

        roles-unavailable —— 读不到角色。不代表没有权限，所以话不能说死，
                             给的是「重试」。
        no-roles          —— 确实一个角色都没有。登录有效但学校还没开通身份，
                             用户自己刷新一百次也变不出权限，所以给的是联系方式。
        forbidden         —— 有角色但不含本页，而且「回自己首页」算出来就是本页。

      一律不提权、不放行、不猜测用户该有什么身份。 */
  function renderBlocked(kind) {
    const BTN = "display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;" +
      "min-height:44px;margin-top:14px;padding:10px 22px;border-radius:999px;font-size:14px;" +
      "text-decoration:none;border:0;cursor:pointer;font-family:inherit";
    const SOLID = BTN + ";background:#102f55;color:#fff";
    const GHOST = BTN + ";background:#fff;color:#102f55;border:1px solid #c3ccdb";

    const M = {
      "roles-unavailable": {
        icon: "🔌",
        head: "没能确认你的权限",
        body: "我们暂时读不到这个账号的门户权限，可能是网络不稳或服务端短暂不可用。" +
              "<br><b>这不表示你没有权限</b> —— 只是这一次没查到。请稍后重试。",
        retry: "重试",
      },
      "no-roles": {
        icon: "🕗",
        head: "这个账号还没有门户权限",
        body: "你的登录是有效的，但学校还没有为它开通任何门户身份。" +
              "<br>正式学员与教师身份须经学校审核开通（规范 §5.2）；如有疑问，请通过官网联系招生同工。",
        retry: "重新检查",
      },
      forbidden: {
        icon: "🚫",
        head: "你没有访问这个页面的权限",
        body: "当前账号的身份不包含这个页面。<br>如果你认为这是错的，请通过官网联系招生同工。",
        retry: "重新检查",
      },
    };
    const m = M[kind] || M["roles-unavailable"];

    document.body.innerHTML =
      '<div style="max-width:520px;margin:16vh auto;padding:34px;border:1px solid #d9dee8;border-radius:14px;background:#fff;font-family:\'Microsoft YaHei\',sans-serif;text-align:center;color:#202735">' +
      '<div style="font-size:34px" aria-hidden="true">' + m.icon + "</div>" +
      '<h1 id="portalBlockedTitle" tabindex="-1" style="font-size:19px;color:#102f55;margin:10px 0;outline:none">' + m.head + "</h1>" +
      "<p style='font-size:13.5px;line-height:1.9;color:#5e6879'>" + m.body + "</p>" +
      '<div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center">' +
      '<button type="button" id="blockRetry" style="' + SOLID + '">' + m.retry + "</button>" +
      '<button type="button" id="blockOut" style="' + GHOST + '">退出登录</button>' +
      '<a href="' + ROOT + 'index.html" style="' + GHOST + '">返回官网</a></div></div>';
    document.body.style.background = "#f4f6f9";
    // 标题栏还写着「学员中心」之类的话，等于对着一个进不去的页面宣称它是学员中心
    document.title = m.head + " | AMAS";

    document.getElementById("blockRetry").addEventListener("click", () => location.reload());
    document.getElementById("blockOut").addEventListener("click", () => signOut());
    // body 被整段换掉，焦点会掉回 body；交给标题，读屏才会念出真实状态
    const h = document.getElementById("portalBlockedTitle");
    if (h) { try { h.focus({ preventScroll: true }); } catch (e) { h.focus(); } }
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
    /* fetch 在网络层出错时是**抛异常**，不是返回失败响应。
       原来这里没有 try/catch，异常会一路穿过 Api.fn 和页面的 await——
       调用方 `await` 之后的代码（解锁按钮、显示提示）全都不会执行，
       结果就是按钮永远卡在禁用态、一句话都不说。六个调用方无一自己 try/catch，
       所以在这里兜住，统一返回结构化结果。

       status 用 0 表示「**根本没拿到 HTTP 响应**」——它和 5xx 不是一回事：
       5xx 是服务端回话了（说自己出错了），0 是连回话都没有，
       请求是否已经送达完全未知。调用方据此决定要不要劝重试。 */
    let res;
    try {
      res = await fetch(SUPA.url + "/functions/v1/" + name, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPA.anonKey,
          Authorization: "Bearer " + session.access_token,
        },
        body: JSON.stringify(payload || {}),
      });
    } catch (e) {
      return { status: 0, data: { error: "network" } };
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 响应不是 JSON（网关 HTML 页等） */ }
    return { status: res.status, data };
  }

  window.AmasAuth = {
    CONFIGURED, CONFIG_STATE, ROOT, client,
    getSession, getRoles, fetchRoles, getProfile, homeForRoles, isSigningOut,
    watchSession, sessionEnded,
    signIn, signUp, resetPassword, signOut, requireRole, renderDisabled, renderBlocked, safePath,
    getAal, requireRoleAal2, callFn,
  };
})();
