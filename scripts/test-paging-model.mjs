/* offset 分页的完整性 —— 纯模型，离线跑，不开浏览器、不连任何东西。
   ────────────────────────────────────────────────────────────────
   招生队列原来只按 submitted_at desc 排。可是：
     · 同一批导入/同一秒提交的申请，submitted_at 完全相同；
     · 草稿的 submitted_at 是 **null**，全都并列。
   排序键不唯一时，「第 300 到第 599 行是哪几行」在两次独立查询之间**没有保证** ——
   PostgreSQL 对并列行的先后不作承诺。于是翻到第二页时，边界附近可能重复、也可能**漏**。
   重复能被 id 去重盖住，**漏掉的那一行没有任何人会发现**。

   这里把「服务端按某个排序返回一页」和「客户端一页页取 + 按 id 去重」都建成模型，
   然后看在并列/空值/翻页期间增删这几种情形下，收集到的集合与真值差在哪。 */

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  ← " + detail : "")); }
};

/** 比较器：按给定的键列排序。null 一律排在最后（与 Api.select 的 nullsFirst:false 一致）。 */
const cmpBy = (keys) => (a, b) => {
  for (const k of keys) {
    const av = a[k.col], bv = b[k.col];
    if (av === bv) continue;
    if (av === null || av === undefined) return 1;      // null 最后
    if (bv === null || bv === undefined) return -1;
    const r = av < bv ? -1 : 1;
    return k.asc ? r : -r;
  }
  return 0;                                             // 全部键都相等 = 并列
};

/** 服务端：按 keys 排序后切 [from, to]。
    **并列的那些行**，先后由 tieOrder 决定 —— 模拟「数据库不作承诺」这件事：
    同一份数据、同样的查询，两次调用完全可以给出不同的并列顺序。 */
function serverPage(rows, keys, from, to, tieOrder) {
  const idx = new Map(rows.map((r, i) => [r.id, i]));
  const sorted = rows.slice().sort((a, b) => {
    const c = cmpBy(keys)(a, b);
    if (c !== 0) return c;
    const ta = tieOrder ? tieOrder.indexOf(a.id) : idx.get(a.id);
    const tb = tieOrder ? tieOrder.indexOf(b.id) : idx.get(b.id);
    return ta - tb;
  });
  return sorted.slice(from, to + 1);
}

/** 客户端：一页页取，按 id 去重后合并（就是招生页现在的做法）。 */
function collect(pageSize, pages, fetchPage) {
  const rows = [], seen = new Set();
  for (let p = 0; p < pages; p++) {
    for (const r of fetchPage(p * pageSize, p * pageSize + pageSize - 1, p)) {
      if (!seen.has(r.id)) { seen.add(r.id); rows.push(r); }
    }
  }
  return rows;
}

const mk = (n, at) => Array.from({ length: n }, (_, i) => ({ id: "a" + i, submitted_at: at }));
const ids = (rs) => rs.map(r => r.id).sort();
const missing = (all, got) => all.map(r => r.id).filter(id => !got.some(g => g.id === id));

console.log("\n=== A 排序键不唯一时，翻页会漏 ===");
/* 10 份申请，submitted_at **完全相同**（同一批导入）。页大小 5。
   第一页用一种并列顺序，第二页用另一种 —— 这正是数据库允许的。 */
const SAME = mk(10, "2026-09-01T00:00:00Z");
const tieA = ["a0","a1","a2","a3","a4","a5","a6","a7","a8","a9"];
const tieB = ["a5","a0","a1","a2","a3","a4","a6","a7","a8","a9"];
const onlyTime = [{ col: "submitted_at", asc: false }];

const gotA = collect(5, 2, (from, to, p) =>
  serverPage(SAME, onlyTime, from, to, p === 0 ? tieA : tieB));
ok("A1 只按 submitted_at 排：并列顺序一变，就有申请**整份漏掉**",
   missing(SAME, gotA).length > 0, "漏了 " + JSON.stringify(missing(SAME, gotA)));
ok("A1b 而且收集到的条数看着是「少了」，但没有任何线索指向漏了谁",
   gotA.length < SAME.length, gotA.length + "/" + SAME.length);
ok("A1c id 去重只挡住了重复，补不了漏",
   new Set(gotA.map(r => r.id)).size === gotA.length && missing(SAME, gotA).length > 0,
   JSON.stringify(ids(gotA)));

/* 加一个唯一且稳定的次级键（id）之后，排序就是全序 —— 两次查询必然一致。 */
const timeThenId = [{ col: "submitted_at", asc: false }, { col: "id", asc: false }];
const gotB = collect(5, 2, (from, to, p) =>
  serverPage(SAME, timeThenId, from, to, p === 0 ? tieA : tieB));
ok("A2 加上唯一次级键（id）之后，一份不漏",
   missing(SAME, gotB).length === 0 && gotB.length === SAME.length,
   JSON.stringify(missing(SAME, gotB)));

console.log("\n=== B 草稿的 submitted_at 是 null，全都并列 ===");
const MIX = mk(4, "2026-09-01T00:00:00Z").concat(
  Array.from({ length: 6 }, (_, i) => ({ id: "d" + i, submitted_at: null })));
const tieC = MIX.map(r => r.id);
const tieD = ["d5"].concat(MIX.map(r => r.id).filter(x => x !== "d5"));
const gotC = collect(5, 2, (from, to, p) =>
  serverPage(MIX, onlyTime, from, to, p === 0 ? tieC : tieD));
ok("B1 一堆 null（草稿）之间同样没有次序，照样会漏",
   missing(MIX, gotC).length > 0, "漏了 " + JSON.stringify(missing(MIX, gotC)));
const gotD = collect(5, 2, (from, to, p) =>
  serverPage(MIX, timeThenId, from, to, p === 0 ? tieC : tieD));
ok("B2 有了 id 之后，null 组内部也有了确定次序，一份不漏",
   missing(MIX, gotD).length === 0, JSON.stringify(missing(MIX, gotD)));

console.log("\n=== C 翻页期间数据变了 —— 这是 offset 分页**本身**的限制 ===");
/* 即使排序已经是全序，offset 分页也只是「分几次去读」，不是一次快照。
   第一页读完之后有人撤回了一份，第二页的窗口就整体往前挪了一格 —— 一份没读到。 */
const LIVE = mk(10, null).map((r, i) => ({ id: "a" + i, submitted_at: "2026-09-" + String(10 - i).padStart(2, "0") }));
let live = LIVE.slice();
const gotE = collect(5, 2, (from, to, p) => {
  if (p === 1) live = live.filter(r => r.id !== "a0");     // 第一页之后被撤回
  return serverPage(live, timeThenId, from, to);
});
ok("C1 翻页期间有记录消失 → 即使排序全序，仍会漏一份",
   missing(LIVE, gotE).length > 0, "漏了 " + JSON.stringify(missing(LIVE, gotE)));

let live2 = LIVE.slice();
const gotF = collect(5, 2, (from, to, p) => {
  if (p === 1) live2 = [{ id: "new1", submitted_at: "2026-09-20" }].concat(live2);
  return serverPage(live2, timeThenId, from, to);
});
/* 这一条我起初写成「新增只会重复、不会漏」—— 模型当场把它打回来了，写错的是我。
   新增会把整个窗口往后推一格：已经取过的那几页里，最后一行被挤到窗口之外。
   所以**增和删都会漏**，只是漏的方式不同。 */
ok("C2 翻页期间有新提交 → 已取到的这几页里同样会漏（被挤出窗口）",
   missing(LIVE, gotF).length > 0, "漏了 " + JSON.stringify(missing(LIVE, gotF)));
ok("C2b 但这一页是满的，所以**不会**错误地宣称「已经是全部」——按钮还在，他能接着取",
   serverPage(live2, timeThenId, 5, 9).length === 5, "第二页取到 " +
   serverPage(live2, timeThenId, 5, 9).length + " 条");
ok("C3 所以「已经是全部」这句话不能无条件说 —— C1（翻页期间被撤回）就是反例：" +
   "页是短的、于是会宣称到底了，而实际上漏了一份",
   missing(LIVE, gotE).length > 0 &&
   serverPage(live, timeThenId, 5, 9).length < 5, JSON.stringify(missing(LIVE, gotE)));

console.log("\n=== D 对照：没有并列、期间也没变时，两种排序都不漏 ===");
const UNIQ = LIVE;
const gotG = collect(5, 2, (from, to) => serverPage(UNIQ, onlyTime, from, to));
const gotH = collect(5, 2, (from, to) => serverPage(UNIQ, timeThenId, from, to));
ok("D1 对照：时间各不相同时，只按时间排也不漏（不是一律判红）",
   missing(UNIQ, gotG).length === 0, JSON.stringify(missing(UNIQ, gotG)));
ok("D2 对照：加了 id 也照样不漏，且顺序稳定",
   missing(UNIQ, gotH).length === 0 && JSON.stringify(ids(gotG)) === JSON.stringify(ids(gotH)));

console.log(`\n  PASS ${pass}  FAIL ${fail}`);
console.log("本套件是纯模型：未开浏览器、未联网、未连任何数据库。");
console.log("NOT_RUN：真实 PostgreSQL 对并列行的实际行为 —— 这里只按「它不作承诺」来建模。");
process.exit(fail ? 1 : 0);
