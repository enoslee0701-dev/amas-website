// 触控目标量具（三份回归脚本共用同一份，避免判据分叉）。
//
// 这段源码会被注入页面执行，所以是字符串而不是模块函数。
// 注意：它本身是模板字符串，里面**不能再出现反引号** —— 嵌套反引号会把它截断。
//
// ── 为什么不用 getBoundingClientRect 判「够不够 44」 ──────────────────
// 那个量具量的是元素自己的边框盒，既看不见 padding/伪元素把命中区往外撑，
// 也看不见别的元素压在上面把命中区抢走，会同时产生假绿和假红。
// 这里一律用 document.elementFromPoint / elementsFromPoint 实测浏览器的命中测试结果。
//
// ── 判据分两步，这两步必须分开 ────────────────────────────────────────
// 「控件上放得下一整块完全属于自己的 44x44」对矩形没问题，**对圆形是错的**：
// 直径 44 的圆里最大内接正方形只有 31px。而且全局那条
//   :focus-visible{...;border-radius:4px}
// 会给任何被键盘聚焦的元素加圆角 —— 于是本来就合格的 44x44 汉堡键一被 Tab 聚焦
// 就「放不下 44x44」。盒子够大、没人遮挡、却判不合格：红的是判据不是页面。
//
// WCAG 2.5.5 / 2.5.8 量的是目标外接盒，加上「有没有被别的目标压掉」。照此分两步：
//   1) 外接盒 >= size；
//   2) 它自己形状内的点有没有被别的元素压在上面。一个点都没被压 -> 目标完好；
//      有被压 -> 这时才要求剩下的可达区域里仍放得下一整块 size x size。
// 区分「圆角之外」和「被别人抢走」靠 elementsFromPoint（复数）拿整条命中栈：
// 元素不在栈里 = 这点在它自己的圆角外，不算被抢；在栈里但不在栈顶 = 真被压住。
//
// ── 两个踩过的坑，都写进代码里防止复发 ────────────────────────────────
// 一、全程浮点，不做取整。边框盒的边几乎总是小数，而「正好 44 高」的元素一旦对候选
//     起点 ceil、终点 floor，整数候选区间就是空的，于是每一个都判成放不下。
// 二、采样坐标要夹进视口。贴视口边缘的元素在 x = 视口宽-0.5 上 elementFromPoint
//     返回 null（Chrome 把小数坐标 round 到设备像素后落到视口外，实测 1279.5 -> null、
//     1279 -> 命中）。曾经改成「最后一个采样点整体内缩 1.5px」，断言转绿的同时负向
//     控制也转绿了 —— 那等于把 44 的判据偷偷放宽成 42.5。所以精度保持 0.5，只夹坐标。
export const TOUCH_PROBE = `
// 站点设了 html{scroll-behavior:smooth}。不关掉它，scrollIntoView 之后立刻读 rect
// 读到的是滚动途中的坐标，elementFromPoint 会打在别的元素上，量出来像是控件不存在。
document.documentElement.style.scrollBehavior = 'auto';

window.__owns = (el, x, y) => {
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  if (x < 0 || y < 0 || x >= vw || y >= vh) return false;
  const t = document.elementFromPoint(x, y);
  return !!t && (t === el || el.contains(t));
};

// 可达区域里是否放得下一整块 size x size（用于「已经被压住」之后的追问）
window.__sq = (el, size) => {
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const clamp = (x, hi) => Math.min(x, hi - 1);
  if (r.width + 1e-6 < size || r.height + 1e-6 < size) return false;
  const offs = []; for (let d = 0.5; d < size; d += 4) offs.push(d);
  if (offs[offs.length - 1] < size - 0.5) offs.push(size - 0.5);
  for (let ox = 0; ox <= r.width - size + 1e-6; ox += 1)
    for (let oy = 0; oy <= r.height - size + 1e-6; oy += 1) {
      let ok = true;
      for (let i = 0; i < offs.length && ok; i++)
        for (let j = 0; j < offs.length && ok; j++)
          if (!window.__owns(el, clamp(r.left + ox + offs[i], vw), clamp(r.top + oy + offs[j], vh))) ok = false;
      if (ok) return true;
    }
  return false;
};

// 目标是否合格：外接盒够大 + 没被别的元素压掉（被压了才追问可达区域）
window.__target = (el, size) => {
  const r = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
  const clamp = (x, hi) => Math.min(x, hi - 1);
  const out = { w: Math.round(r.width), h: Math.round(r.height), covered: 0, by: [] };
  if (r.width + 1e-6 < size || r.height + 1e-6 < size) {
    out.ok = false; out.why = '外接盒不足 ' + size; return out;
  }
  const by = new Set();
  for (let x = r.left + 1; x < r.right; x += 3)
    for (let y = r.top + 1; y < r.bottom; y += 3) {
      const stack = document.elementsFromPoint(clamp(x, vw), clamp(y, vh));
      const idx = stack.findIndex((n) => n === el || el.contains(n));
      if (idx < 0) continue;                       // 圆角之外，不是被谁抢走
      if (idx > 0) {
        out.covered++;
        const t = stack[0];
        by.add(t.id ? '#' + t.id : t.tagName.toLowerCase() +
          (t.className && typeof t.className === 'string' ? '.' + t.className.trim().split(/\\s+/)[0] : ''));
      }
    }
  out.by = [...by].slice(0, 3);
  if (out.covered === 0) { out.ok = true; out.why = '外接盒够大且无人压住'; return out; }
  out.ok = window.__sq(el, size);
  // 这里只能用字符串拼接：整段本身就是模板字符串，嵌套反引号会把它截断
  out.why = '被压住 ' + out.covered + ' 点' +
            (out.ok ? '但仍放得下完整 ' : '且放不下完整 ') + size + 'x' + size;
  return out;
};
true;`;
