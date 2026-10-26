/* AMAS PORTAL-SHARED · 门户导航壳 + 身份条 + 会话监听
   规范：§15.3 门户导航 · §15.5 可访问性 · §5.6 会话管理
   注意：导航项的显隐仅是「展示」；真实权限由 RLS/RPC/Edge 决定（服务端权威）。 */
(function () {
  "use strict";
  const A = window.AmasAuth, U = window.AmasUI;
  if (!A || !U) { console.error("[AmasShell] 需要 auth.js 与 ui.js"); return; }

  const NAV = {
    /* 这里遵守下面 student 那条同样的原则：只放确实存在的页面。
       由 scripts/check-internal-links.py 钉住 —— 这类缺陷在本地看不出来，
       门户导航只有在 Supabase 配置齐全且用户已登录之后才渲染，
       会在后端开通的第一天才爆出来。

       portal/applicant/profile/ 已建成（读 my_profile、写 update_my_contact，
       两个 RPC 都是仓库里已有的契约），入口已恢复。

       portal/applicant/history/ 的**契约也已存在**，只是页面还没写：
         applications 表的 app_self_select 策略允许申请人 select 自己的全部申请，
         而 my_application() 刻意排除了 rejected / withdrawn 且 limit 1，
         所以「历史」这批数据在表里是有的，取法与 portal/admin/admissions/
         列申请的写法相同（Api.select("applications", …)）。
       页面建好后把这一行加回来：
         { href: "portal/applicant/history/", icon: "folder", label: "历史申请" }, */
    applicant: [
      { href: "portal/applicant/", icon: "home", label: "首页" },
      { href: "portal/applicant/application/", icon: "file", label: "我的申请" },
      { href: "portal/applicant/history/", icon: "folder", label: "历史申请" },
      { href: "portal/applicant/profile/", icon: "user", label: "个人资料" },
      { href: "help/", icon: "help", label: "帮助" },
    ],
    // 只放确实存在且有真实内容的页面。学习进度/成长档案尚无可读数据源
    // （见 docs/operations/PORTAL-learning-data-audit.md），因此不设这两个入口——
    // 宁可少一个入口，也不做点进去空无一物的假页面。
    student: [
      { href: "portal/student/", icon: "home", label: "首页" },
      { href: "portal/student/classes/", icon: "calendar", label: "我的课程" },
      { href: "portal/student/records/", icon: "chart", label: "成绩与进度" },
      { href: "portal/student/courses/", icon: "book", label: "课程目录" },
      { href: "portal/student/profile/", icon: "user", label: "我的资料" },
      { href: "help/", icon: "help", label: "帮助" },
    ],
    teacher: [
      { href: "portal/teacher/", icon: "home", label: "工作台" },
      { href: "portal/teacher/classes/", icon: "book", label: "我的课程" },
      { href: "portal/teacher/mentees/", icon: "users", label: "我带的学员" },
      { href: "portal/teacher/profile/", icon: "user", label: "我的资料" },
      { href: "help/", icon: "help", label: "帮助" },
    ],
    admin: [
      { href: "portal/admin/", icon: "home", label: "总览" },
      { href: "portal/admin/inbox/", icon: "inbox", label: "报名收件箱" },
      { href: "portal/admin/board/", icon: "message", label: "公告与课堂" },
      { href: "portal/admin/finance/", icon: "bars", label: "费用管理" },
      { href: "portal/admin/admissions/", icon: "usercheck", label: "招生审核" },
      { href: "portal/admin/students/", icon: "cap", label: "学籍管理" },
      { href: "portal/admin/offerings/", icon: "book", label: "开课与编班" },
      { href: "portal/admin/grades/", icon: "file", label: "成绩审核" },
      { href: "portal/admin/roles/", icon: "key", label: "角色管理" },
      { href: "portal/admin/teachers/", icon: "badge", label: "教师验证" },
      { href: "help/", icon: "help", label: "帮助" },
    ],
  };

  /* 线条图标（24 视框、描边 1.8），导航与各页共用：AmasShell.icon("inbox") */
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    usercheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
    cap: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    bookopen: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
    chart: '<path d="M6 20V14"/><path d="M12 20V9"/><path d="M18 20V4"/>',
    key: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 11.5-5.4"/><path d="M18 15v6"/><path d="M15 18h6"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    badge: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 17a3.5 3.5 0 0 1 7 0"/><path d="M15 10h3M15 14h3"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h6"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    swap: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    message: '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-4-.9L3 21l1.9-5A8.4 8.4 0 1 1 21 11.5z"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
    headset: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    bars: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
    print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  };
  const icon = (name, size) => '<svg class="ico" viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) +
    '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || ICONS.file) + '</svg>';
  /* 顶栏副标题：管理空间统一叫「神学院后台管理系统」（Enos 2026-10-26 的界面稿） */
  const SUBTITLE = { admin: "神学院后台管理系统" };

  const ROLE_LABEL = {
    applicant: "申请者", student: "学员", teacher: "教师", mentor: "导师",
    registrar: "教务", finance: "财务", content_admin: "内容管理",
    academic_admin: "学术管理", super_admin: "系统管理员",
  };

  /** 渲染门户外壳；返回 { ctx, main } */
  /* 顶栏上的名字与身份：上一页读到过就先拿来画（只是显示，不做任何权限判断），
     新页读到真实资料后再覆盖。缓存只在本标签页（sessionStorage），退出登录即作废。 */
  const WHO_KEY = "amas.shell-who";   // "amas." 前缀：退出登录时 auth.js 一并清掉
  const readWho = () => { try { return JSON.parse(sessionStorage.getItem(WHO_KEY) || "null"); } catch (e) { return null; } };
  const saveWho = (w) => { try { sessionStorage.setItem(WHO_KEY, JSON.stringify(w)); } catch (e) {} };
  const whoHtml = (w) => w ? `<b>${U.esc(w.name || "")}</b>${w.badge ? `<span class="badge">${U.esc(w.badge)}</span>` : ""}` : "";

  /** 渲染门户外壳；返回 { ctx, main }
      提速（2026-10-26）：外壳（顶栏 + 左侧菜单）**先画出来**，主区放骨架，同时去确认身份；
      身份确认不通过时（跳登录 / 停靠页）把外壳拿掉，行为与原来一致。 */
  async function mount(opts) {
    const { space, title, allow, requireAal2 } = opts;
    const items = NAV[space] || [];
    const here = location.pathname.replace(/\/index\.html$/, "/");
    const cached = readWho();

    const nav = items.map((it) => {
      const href = A.ROOT + it.href;
      const on = here.endsWith("/" + it.href) || here === href;
      return `<a href="${href}" class="nv${on ? " on" : ""}"${on ? ' aria-current="page"' : ""}>
        <span class="nv-ic">${icon(it.icon, 19)}</span><span class="nv-tx">${U.esc(it.label)}</span></a>`;
    }).join("");

    const shell = document.createElement("div");
    shell.className = "portal-shell";
    shell.innerHTML = `
      <a class="skip" href="#main">跳到主要内容</a>
      <header class="ph">
        <div class="ph-left">
          <button class="ph-menu" id="shellMenu" type="button" aria-label="打开或收起菜单" aria-controls="shellNav" aria-expanded="false">${icon("menu", 22)}</button>
          <a class="ph-brand" href="${A.ROOT}index.html">
            <img src="${A.ROOT}assets/img/school-seal.webp" alt="" width="38" height="38">
            <span><b>AMAS</b><small>${U.esc(SUBTITLE[space] || title || "门户")}</small></span>
          </a>
        </div>
        <div class="ph-right">
          <span class="ph-who">${whoHtml(cached)}</span>
          <a class="link ph-act" id="shellSwitch" href="${A.ROOT}portal/"${cached && cached.multi ? "" : " hidden"}>${icon("swap", 16)}<span>切换空间</span></a>
          <button class="link ph-act" id="shellOut">${icon("logout", 16)}<span>退出</span></button>
        </div>
      </header>
      <div class="pb">
        <nav class="pn" id="shellNav" aria-label="门户导航">
          <div class="pn-list">${nav}</div>
          <div class="pn-foot" aria-hidden="true"><span>EQUIPPING<br>SERVING<br>TRANSFORMING</span><small>AMAS · 清迈分院</small></div>
        </nav>
        <div class="pn-backdrop" id="shellBackdrop" hidden></div>
        <main id="main" class="pm" tabindex="-1" aria-busy="true">${U.skeleton(4)}</main>
        <div class="pm-deco" aria-hidden="true"><span>真理装备生命<br>服事教会群体<br>影响这个世界</span></div>
      </div>`;
    if (A.CONFIGURED) document.body.prepend(shell);

    /* 资料与身份确认同时发出，不再等身份确认完才去读资料 */
    const profP = A.CONFIGURED ? A.getProfile().catch(() => null) : Promise.resolve(null);
    const ctx = requireAal2 ? await A.requireRoleAal2(allow) : await A.requireRole(allow);
    if (!ctx) { if (shell.isConnected) shell.remove(); return null; }

    const profile = await profP;
    const roles = ctx.roles || [];
    const primary = ["super_admin", "academic_admin", "registrar", "finance", "content_admin", "teacher", "mentor", "student", "applicant"].find((r) => roles.includes(r));
    const who = { name: profile?.display_name || profile?.email || "", badge: primary ? (ROLE_LABEL[primary] || primary) : "", multi: roles.length > 1 };
    shell.querySelector(".ph-who").innerHTML = whoHtml(who);
    shell.querySelector("#shellSwitch").hidden = !who.multi;
    saveWho(who);
    const mainEl = shell.querySelector("#main");
    mainEl.innerHTML = ""; mainEl.removeAttribute("aria-busy");
    if (!shell.isConnected) document.body.prepend(shell);

    /* 「加到手机桌面」引导（assets/js/pwa-guide.js）：门户每页都挂，手机上第一次进来时提示一次 */
    if (!window.AmasPwaGuide) { const g = document.createElement("script"); g.src = A.ROOT + "assets/js/pwa-guide.js"; g.defer = true; document.head.appendChild(g); }

    /* 手指 / 鼠标一落到菜单项上就先把那一页取回来，点下去时页面已经在本机缓存里 */
    const fetched = new Set();
    const warm = (a) => {
      const href = a && a.href;
      if (!href || fetched.has(href) || a.classList.contains("on")) return;
      fetched.add(href);
      const l = document.createElement("link"); l.rel = "prefetch"; l.href = href; document.head.appendChild(l);
    };
    shell.querySelectorAll(".pn a.nv").forEach((a) => {
      ["pointerenter", "touchstart", "focus"].forEach((t) => a.addEventListener(t, () => warm(a), { passive: true, once: true }));
    });
    /* 菜单键：宽屏收起 / 展开侧栏（只留图标）；窄屏是抽屉，点遮罩或 Esc 关闭 */
    const menuBtn = document.getElementById("shellMenu"), backdrop = document.getElementById("shellBackdrop");
    const narrow = () => window.matchMedia("(max-width:860px)").matches;
    const setDrawer = (open) => {
      shell.classList.toggle("nav-open", open); backdrop.hidden = !open;
      menuBtn.setAttribute("aria-expanded", String(open));
      if (open) shell.querySelector(".pn .nv")?.focus();
    };
    try { if (!narrow() && localStorage.getItem("amas-nav-collapsed") === "1") shell.classList.add("nav-mini"); } catch (e) {}
    menuBtn.setAttribute("aria-expanded", String(!narrow() && !shell.classList.contains("nav-mini")));
    menuBtn.addEventListener("click", () => {
      if (narrow()) return setDrawer(!shell.classList.contains("nav-open"));
      const mini = shell.classList.toggle("nav-mini");
      menuBtn.setAttribute("aria-expanded", String(!mini));
      try { localStorage.setItem("amas-nav-collapsed", mini ? "1" : "0"); } catch (e) {}
    });
    backdrop.addEventListener("click", () => setDrawer(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && shell.classList.contains("nav-open")) { setDrawer(false); menuBtn.focus(); } });

    document.getElementById("shellOut").addEventListener("click", async () => {
      if (await U.confirmDialog({ title: "退出登录", text: "确认退出当前账号？", confirmLabel: "退出" })) A.signOut();
    });

    /* 会话失效监听：明确提示，不静默失败（§5.6）。
       实现已挪到 auth.js 的 watchSession() 共用。原因：门户下有三页
       （portal/index.html、portal/mfa/、portal/admin/）**不走 Shell.mount**，
       监听只长在这里的话，那三页上会话失效就是完全静默的。
       区分主动退出与过期、next 连 query 与 hash 一起带、只订阅一次、
       以及为什么不能再监听 `TOKEN_REFRESHED_FAILED`（那个事件在
       supabase-js v2 里根本不存在，别再加回去）—— 全部写在 auth.js 那一处。
       外壳有 ui.js，所以把提示接到统一的 toast 上。 */
    A.watchSession({ notify: (m) => U.toast(m, "err") });

    // 离线提示
    window.addEventListener("offline", () => U.toast("网络已断开，操作可能无法保存", "err"));
    window.addEventListener("online", () => U.toast("网络已恢复"));

    return { ctx, profile, roles, main: shell.querySelector("#main") };
  }

  window.AmasShell = { mount, ROLE_LABEL, icon };
})();
