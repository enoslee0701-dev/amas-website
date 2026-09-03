/* AMAS PORTAL-SHARED · 共享状态组件与可访问性基线
   提供：loading / empty / unauthorized / error / offline / toast / confirm / formGuard / timeline
   规范：§15.4 每页必须有载入中、空状态、无权限、失败重试、离线、未保存提醒 */
(function () {
  "use strict";

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function box(icon, title, text, actions) {
    const acts = (actions || []).map((a) =>
      `<button class="btn ${a.ghost ? "ghost" : ""}" data-act="${esc(a.id)}" style="width:auto;padding:0 22px;margin:6px 4px 0">${esc(a.label)}</button>`
    ).join("");
    return `<div class="state-box" role="status" aria-live="polite">
      <div class="state-ic" aria-hidden="true">${icon}</div>
      <h3>${esc(title)}</h3>
      ${text ? `<p>${esc(text)}</p>` : ""}
      ${acts ? `<div class="state-acts">${acts}</div>` : ""}
    </div>`;
  }

  const skeleton = (rows = 3) =>
    `<div class="skeleton" aria-busy="true" aria-live="polite" aria-label="正在载入">` +
    Array.from({ length: rows }, () => `<div class="sk-line"></div>`).join("") + `</div>`;

  function render(el, html, handlers) {
    const node = typeof el === "string" ? document.querySelector(el) : el;
    if (!node) return;
    node.innerHTML = html;
    if (handlers) {
      node.querySelectorAll("[data-act]").forEach((b) => {
        const h = handlers[b.dataset.act];
        if (h) b.addEventListener("click", h);
      });
    }
  }

  const loading = (el, rows) => render(el, skeleton(rows));
  const empty = (el, opts) => render(el, box("📭", opts.title || "暂无内容", opts.text || "", opts.actions), opts.handlers);
  const unauthorized = (el, opts = {}) => render(el, box("🔒", opts.title || "无访问权限",
    opts.text || "你的账号没有查看该内容的权限。如认为有误，请联系教务同工。",
    opts.actions || [{ id: "back", label: "返回门户" }]),
    opts.handlers || { back: () => (location.href = (window.AmasAuth?.ROOT || "/") + "portal/") });
  const error = (el, opts) => render(el, box("⚠️", opts.title || "载入失败",
    opts.message || "请稍后重试。", [{ id: "retry", label: "重试" }, { id: "back", label: "返回", ghost: true }]),
    { retry: opts.onRetry || (() => location.reload()), back: opts.onBack || (() => history.back()) });
  const offline = (el) => render(el, box("📡", "网络连接已断开", "恢复网络后点击重试。", [{ id: "retry", label: "重试" }]), { retry: () => location.reload() });

  let toastTimer;
  function toast(message, type) {
    let t = document.getElementById("amas-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "amas-toast";
      t.className = "portal-toast";
      t.setAttribute("role", "status");
      t.setAttribute("aria-live", "polite");
      document.body.appendChild(t);
    }
    t.textContent = message;
    t.dataset.type = type || "info";
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
  }

  /** 无障碍确认框：键盘可用、焦点锁定、Esc 取消 */
  function confirmDialog({ title, text, confirmLabel = "确认", cancelLabel = "取消", danger = false }) {
    return new Promise((resolve) => {
      const prev = document.activeElement;
      const wrap = document.createElement("div");
      wrap.className = "portal-modal";
      wrap.innerHTML = `<div class="pm-backdrop" data-x></div>
        <div class="pm-card" role="dialog" aria-modal="true" aria-labelledby="pm-t">
          <h3 id="pm-t">${esc(title)}</h3>
          ${text ? `<p>${esc(text)}</p>` : ""}
          <div class="pm-acts">
            <button class="btn ghost" data-cancel style="width:auto;padding:0 20px">${esc(cancelLabel)}</button>
            <button class="btn${danger ? " danger" : ""}" data-ok style="width:auto;padding:0 20px">${esc(confirmLabel)}</button>
          </div>
        </div>`;
      document.body.appendChild(wrap);
      const okBtn = wrap.querySelector("[data-ok]");
      okBtn.focus();
      const close = (v) => { wrap.remove(); document.removeEventListener("keydown", onKey); prev?.focus?.(); resolve(v); };
      const onKey = (e) => {
        if (e.key === "Escape") close(false);
        if (e.key === "Tab") { // 简易焦点锁
          const f = wrap.querySelectorAll("button");
          const first = f[0], last = f[f.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      document.addEventListener("keydown", onKey);
      wrap.querySelector("[data-ok]").addEventListener("click", () => close(true));
      wrap.querySelector("[data-cancel]").addEventListener("click", () => close(false));
      wrap.querySelector("[data-x]").addEventListener("click", () => close(false));
    });
  }

  /** 未保存离开提醒 */
  function formGuard(isDirtyFn) {
    const handler = (e) => { if (isDirtyFn()) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }

  /** 状态时间线渲染（申请人视图不含内部备注） */
  function timeline(items) {
    if (!items || !items.length) return box("🕓", "暂无记录", "状态变更后会在此显示。");
    return `<ol class="tl">` + items.map((it) => `
      <li class="tl-item">
        <div class="tl-dot" aria-hidden="true"></div>
        <div class="tl-body">
          <div class="tl-head"><b>${esc(it.title)}</b><time>${esc(it.time)}</time></div>
          ${it.text ? `<p>${esc(it.text)}</p>` : ""}
          ${it.by ? `<span class="tl-by">${esc(it.by)}</span>` : ""}
        </div>
      </li>`).join("") + `</ol>`;
  }

  window.AmasUI = { render, loading, empty, unauthorized, error, offline, toast, confirmDialog, formGuard, timeline, esc, box, skeleton };
})();
