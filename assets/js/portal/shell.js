/* AMAS PORTAL-SHARED · 门户导航壳 + 身份条 + 会话监听
   规范：§15.3 门户导航 · §15.5 可访问性 · §5.6 会话管理
   注意：导航项的显隐仅是「展示」；真实权限由 RLS/RPC/Edge 决定（服务端权威）。 */
(function () {
  "use strict";
  const A = window.AmasAuth, U = window.AmasUI;
  if (!A || !U) { console.error("[AmasShell] 需要 auth.js 与 ui.js"); return; }

  const NAV = {
    /* 这里遵守下面 student 那条同样的原则：只放确实存在的页面。
       portal/applicant/history/ 与 portal/applicant/profile/ **目录并不存在**，
       挂在导航上就是三个字：点了 404。
       这类缺陷在本地根本看不出来 —— 门户导航只有在 Supabase 配置齐全且用户
       已登录之后才渲染，而这两个条件今天都不成立，所以它会在后端开通的
       第一天才爆出来。现由 scripts/check-internal-links.py 钉住。
       要恢复这两个入口：先建出对应页面（历史申请需要按申请人查历史记录的
       数据源，个人资料需要可读写的 profile 接口），再把这两行加回来。 */
    applicant: [
      { href: "portal/applicant/", icon: "🏠", label: "首页" },
      { href: "portal/applicant/application/", icon: "📝", label: "我的申请" },
      { href: "help/", icon: "💬", label: "帮助" },
    ],
    // 只放确实存在且有真实内容的页面。学习进度/成长档案尚无可读数据源
    // （见 docs/operations/PORTAL-learning-data-audit.md），因此不设这两个入口——
    // 宁可少一个入口，也不做点进去空无一物的假页面。
    student: [
      { href: "portal/student/", icon: "🏠", label: "首页" },
      { href: "portal/student/courses/", icon: "📚", label: "课程目录" },
      { href: "portal/student/profile/", icon: "👤", label: "我的资料" },
      { href: "help/", icon: "💬", label: "帮助" },
    ],
    teacher: [
      { href: "portal/teacher/", icon: "🏠", label: "工作台" },
      { href: "help/", icon: "💬", label: "帮助" },
    ],
    admin: [
      { href: "portal/admin/", icon: "🏠", label: "总览" },
      { href: "portal/admin/admissions/", icon: "📥", label: "招生审核" },
      { href: "portal/admin/students/", icon: "🎓", label: "学籍管理" },
      /* portal/admin/teachers/ 不存在 —— 管理员点进去是 404。
         站内真实存在的教师验证入口是 faculty/verify/（那是教师本人提交验证的页面，
         不是管理员审核台），两者不是一回事，所以这里**不做指向替换**，
         直接撤掉入口。管理端的教师审核台建好后再加回来。 */
      { href: "help/", icon: "💬", label: "帮助" },
    ],
  };

  const ROLE_LABEL = {
    applicant: "申请者", student: "学员", teacher: "教师", mentor: "导师",
    registrar: "教务", finance: "财务", content_admin: "内容管理",
    academic_admin: "学术管理", super_admin: "系统管理员",
  };

  /** 渲染门户外壳；返回 { ctx, main } */
  async function mount(opts) {
    const { space, title, allow, requireAal2 } = opts;
    const ctx = requireAal2 ? await A.requireRoleAal2(allow) : await A.requireRole(allow);
    if (!ctx) return null;

    const profile = await A.getProfile();
    const roles = ctx.roles || [];
    const primary = ["super_admin", "academic_admin", "registrar", "finance", "content_admin", "teacher", "mentor", "student", "applicant"].find((r) => roles.includes(r));
    const items = NAV[space] || [];
    const here = location.pathname.replace(/\/index\.html$/, "/");

    const nav = items.map((it) => {
      const href = A.ROOT + it.href;
      const on = here.endsWith("/" + it.href) || here === href;
      return `<a href="${href}" class="nv${on ? " on" : ""}"${on ? ' aria-current="page"' : ""}>
        <span class="nv-ic" aria-hidden="true">${it.icon}</span><span class="nv-tx">${U.esc(it.label)}</span></a>`;
    }).join("");

    const shell = document.createElement("div");
    shell.className = "portal-shell";
    shell.innerHTML = `
      <a class="skip" href="#main">跳到主要内容</a>
      <header class="ph">
        <a class="ph-brand" href="${A.ROOT}index.html">
          <img src="${A.ROOT}assets/img/school-seal.webp" alt="" width="34" height="34">
          <span><b>AMAS</b><small>${U.esc(title || "门户")}</small></span>
        </a>
        <div class="ph-right">
          <span class="ph-who">
            <b>${U.esc(profile?.display_name || profile?.email || "")}</b>
            ${primary ? `<span class="badge">${U.esc(ROLE_LABEL[primary] || primary)}</span>` : ""}
          </span>
          ${roles.length > 1 ? `<a class="link" href="${A.ROOT}portal/">切换空间</a>` : ""}
          <button class="link" id="shellOut">退出</button>
        </div>
      </header>
      <div class="pb">
        <nav class="pn" aria-label="门户导航">${nav}</nav>
        <main id="main" class="pm" tabindex="-1"></main>
      </div>`;
    document.body.prepend(shell);
    document.getElementById("shellOut").addEventListener("click", async () => {
      if (await U.confirmDialog({ title: "退出登录", text: "确认退出当前账号？", confirmLabel: "退出" })) A.signOut();
    });

    // 会话过期 / 登出监听：明确提示，不静默失败（§5.6）
    if (A.client) {
      A.client.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT" || event === "TOKEN_REFRESHED_FAILED") {
          U.toast("登录已过期，正在返回登录页…", "err");
          setTimeout(() => location.replace(A.ROOT + "login/?next=" + encodeURIComponent(location.pathname)), 1200);
        }
      });
    }

    // 离线提示
    window.addEventListener("offline", () => U.toast("网络已断开，操作可能无法保存", "err"));
    window.addEventListener("online", () => U.toast("网络已恢复"));

    return { ctx, profile, roles, main: shell.querySelector("#main") };
  }

  window.AmasShell = { mount, ROLE_LABEL };
})();
