/* 「加到手机桌面」引导（Enos 2026-10-26：App 出来之前，先让大家把网站放到手机桌面，点图标就进系统）。
   - 给页面补上 manifest 与苹果图标（站点根目录的 manifest.webmanifest、assets/img/app/）
   - 手机上第一次打开时，底部出一张小卡：
       iPhone / iPad（Safari）：点「分享」→「添加到主屏幕」
       Android（Chrome 等）：浏览器给了安装事件就直接给「添加到桌面」按钮，否则说菜单里的「添加到主屏幕」
   - 已经从桌面打开（standalone）、电脑上、或点过「知道了」就不再出现（localStorage 记一下，读写失败也不影响页面）
   不做离线缓存（不注册 service worker）：门户的数据都要实时读，缓存旧页面只会添乱。 */
(function () {
  "use strict";
  const root = (function () {
    const s = document.currentScript && document.currentScript.getAttribute("src") || "";
    const i = s.indexOf("assets/js/pwa-guide.js");
    return i >= 0 ? s.slice(0, i) : "";
  })();
  const head = document.head;
  const add = (tag, attrs) => { if (head.querySelector(tag + '[rel="' + attrs.rel + '"]')) return; const el = document.createElement(tag); Object.assign(el, attrs); head.appendChild(el); };
  add("link", { rel: "manifest", href: root + "manifest.webmanifest" });
  add("link", { rel: "apple-touch-icon", href: root + "assets/img/app/icon-180.png" });
  if (!head.querySelector('meta[name="theme-color"]')) { const m = document.createElement("meta"); m.name = "theme-color"; m.content = "#102f55"; head.appendChild(m); }
  if (!head.querySelector('meta[name="apple-mobile-web-app-capable"]')) {
    const m = document.createElement("meta"); m.name = "apple-mobile-web-app-capable"; m.content = "yes"; head.appendChild(m);
    const t = document.createElement("meta"); t.name = "apple-mobile-web-app-title"; t.content = "AMAS"; head.appendChild(t);
  }

  const KEY = "amas-pwa-guide-done";
  const seen = () => { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } };
  const remember = () => { try { localStorage.setItem(KEY, "1"); } catch (e) {} };
  const standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const ua = navigator.userAgent || "";
  const ios = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const mobile = ios || /Android|Mobile/i.test(ua);
  let deferred = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; const b = document.getElementById("pwaInstall"); if (b) b.hidden = false; });

  function show() {
    if (standalone || !mobile || seen() || document.getElementById("pwaGuide")) return;
    const box = document.createElement("div");
    box.id = "pwaGuide";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "把 AMAS 加到手机桌面");
    box.style.cssText = "position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:80;background:#fff;border:1px solid #e3dfd3;" +
      "border-radius:16px;box-shadow:0 14px 40px rgba(16,32,56,.22);padding:14px 16px;display:flex;gap:12px;align-items:flex-start;font-size:14px;line-height:1.7;color:#202735;max-width:520px;margin:0 auto";
    const steps = ios
      ? '点屏幕下方（iPad 在右上角）的 <b>分享</b> 按钮 <span aria-hidden="true">⬆︎</span>，往下找 <b>「添加到主屏幕」</b>，再点「添加」。'
      : '点 <b>「添加到桌面」</b>；没有这个按钮的话，点浏览器右上角 <b>⋮ 菜单</b> → <b>「添加到主屏幕」</b>。';
    box.innerHTML = '<img src="' + root + 'assets/img/app/icon-192.png" alt="" width="44" height="44" style="border-radius:12px;flex:none">' +
      '<div style="flex:1;min-width:0"><b style="color:#102f55">把 AMAS 放到手机桌面</b><div>以后点桌面上的图标就能直接进入，不用再找网址。' + steps + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">' +
      '<button type="button" id="pwaInstall" hidden style="min-height:40px;padding:0 16px;border:0;border-radius:10px;background:#102f55;color:#fff;font:inherit;font-weight:700">添加到桌面</button>' +
      '<button type="button" id="pwaOk" style="min-height:40px;padding:0 16px;border:1px solid #cfd5df;border-radius:10px;background:#fff;font:inherit">知道了</button></div></div>';
    document.body.appendChild(box);
    const close = () => { remember(); box.remove(); };
    box.querySelector("#pwaOk").addEventListener("click", close);
    const ib = box.querySelector("#pwaInstall");
    if (deferred && !ios) ib.hidden = false;
    ib.addEventListener("click", async () => {
      if (!deferred) return;
      deferred.prompt();
      try { await deferred.userChoice; } catch (e) {}
      deferred = null; close();
    });
  }
  /* 等页面主体画完再出来，不和登录 / 加载抢第一眼 */
  if (document.readyState === "complete") setTimeout(show, 1500);
  else window.addEventListener("load", () => setTimeout(show, 1500));
  window.AmasPwaGuide = { show };
})();
