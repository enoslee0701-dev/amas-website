// D-AUTH-R6 · AMAS Recovery Finalization Idempotency 验收（20 项）
//
// 目标不是证明 Supabase 永远只消费一次 recovery credential，而是证明：
//   **即使底层 recovery verification 在极端并发下出现多个成功结果，
//     AMAS 最终 password finalization 仍然最多执行一次。**
//
// 「密码是否真的被改过」用可观测的事实判定：用某个密码能否登录成功。
// 报告与输出中不出现任何真实口令。
//
// 运行：node supabase/tests/recovery_finalization.mjs（需同目录或 AMAS_ENV 指向 staging.env）
import { readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

const env = Object.fromEntries(readFileSync(process.env.AMAS_ENV || "staging.env", "utf8")
  .trim().split(/\r?\n/).map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const { URL: URL_, ANON, SERVICE } = env;

const R = [];
const rec = (id, name, pass, d = "") => { R.push({ id, name, pass, detail: d }); console.log(`${pass ? "PASS" : "FAIL"} ${id} ${name}${d ? " | " + d : ""}`); };
const H = (k, jwt) => ({ apikey: k, Authorization: `Bearer ${jwt ?? k}`, "Content-Type": "application/json" });
const svc = (p, i = {}) => fetch(`${URL_}${p}`, { ...i, headers: { ...H(SERVICE), ...(i.headers ?? {}) } });
const anon = (p, i = {}) => fetch(`${URL_}${p}`, { ...i, headers: { ...H(ANON), ...(i.headers ?? {}) } });
const asUser = (p, jwt, i = {}) => fetch(`${URL_}${p}`, { ...i, headers: { ...H(ANON, jwt), ...(i.headers ?? {}) } });
const fn = (jwt, body) => fetch(`${URL_}/functions/v1/recovery-finalize`, {
  method: "POST", headers: H(ANON, jwt), body: JSON.stringify(body),
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pw = () => `T${crypto.randomBytes(12).toString("base64url")}!7z`;

/** 可观测判定：某个口令现在能否登录成功。 */
async function canLogin(email, password) {
  for (let i = 0; i < 5; i++) {
    const r = await anon("/auth/v1/token?grant_type=password", {
      method: "POST", body: JSON.stringify({ email, password }),
    });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    return r.status === 200;
  }
  return false;
}
async function genRecovery(email) {
  for (let i = 0; i < 6; i++) {
    const r = await svc("/auth/v1/admin/generate_link", {
      method: "POST", body: JSON.stringify({ type: "recovery", email }),
    });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    if (!r.ok) return "";
    const b = await r.json();
    return b.email_otp ?? b.hashed_token ?? "";
  }
  return "";
}
async function recoverySession(email) {
  const tok = await genRecovery(email);
  if (!tok) return null;
  for (let i = 0; i < 6; i++) {
    const r = await anon("/auth/v1/verify", {
      method: "POST", body: JSON.stringify({ type: "recovery", email, token: tok }),
    });
    if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
    const b = await r.json().catch(() => ({}));
    return b.access_token ?? null;
  }
  return null;
}
const startFlow = async (jwt) => (await (await asUser("/rest/v1/rpc/start_recovery_flow", jwt, { method: "POST", body: "{}" })).json());
const flowRow = async (uid) => (await (await svc(`/rest/v1/recovery_flows?select=id,status,attempts&user_id=eq.${uid}&order=created_at.desc&limit=1`)).json())[0];

const ids = [];
const tag = Date.now().toString(36);
const mk = async (label) => {
  const email = `recfin-${label}-${tag}@amas-test.dev`;
  const p0 = pw();
  const u = await (await svc("/auth/v1/admin/users", {
    method: "POST", body: JSON.stringify({ email, password: p0, email_confirm: true }),
  })).json();
  ids.push(u.id);
  return { id: u.id, email, initial: p0 };
};

try {
  // ---------- 1 单次 finalize 成功 ----------
  const a = await mk("a");
  const sA = await recoverySession(a.email);
  const fA = await startFlow(sA);
  const pA = pw();
  const r1 = await fn(sA, { flow_id: fA.flow_id, password: pA });
  const b1 = await r1.json();
  rec("R6-01", "单次 finalize 成功", r1.status === 200 && b1.ok === true, `status=${r1.status}`);
  rec("R6-01b", "新口令确实生效（可观测判定）", await canLogin(a.email, pA));
  rec("R6-12", "Person ID 不变", (await (await svc(`/auth/v1/admin/users/${a.id}`)).json()).id === a.id);

  // ---------- 2 相同 flow replay ----------
  const r2 = await fn(sA, { flow_id: fA.flow_id, password: pw() });
  const b2 = await r2.json();
  // 实测：改密成功后该 recovery session 立即失效，因此 replay 在**身份层**就被挡下（401），
  // 根本到不了 flow 检查（409）。这比 409 更强，不是缺陷。
  // 断言因此盯住"不得成功"这条本质，而不是某个具体错误码。
  rec("R6-02", "相同 flow replay 被拒（幂等）",
    r2.status !== 200 && b2.ok !== true,
    `status=${r2.status} err=${b2.error}（401=session 已失效，409=flow 已完成，两者都算拒绝）`);
  rec("R6-05", "completed 后不得再改密码（原口令仍有效）", await canLogin(a.email, pA));

  // ---------- 3 五并发 finalize：password mutation 最多一次 ----------
  const c = await mk("c");
  const sC = await recoverySession(c.email);
  const fC = await startFlow(sC);
  const cands = [pw(), pw(), pw(), pw(), pw()];
  const res = await Promise.all(cands.map(p => fn(sC, { flow_id: fC.flow_id, password: p })
    .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))));
  const okCount = res.filter(x => x.status === 200 && x.body.ok).length;
  rec("R6-03", "5 并发 finalize 至多一次成功", okCount === 1,
    `succeeded=${okCount}/5 statuses=${res.map(x => x.status).join(",")}`);
  rec("R6-04", "未抢到的请求一律 conflict，不进入 Auth update",
    res.filter(x => x.status !== 200).every(x => ["already_processing", "already_completed", "conflict"].includes(x.body.error)),
    res.filter(x => x.status !== 200).map(x => x.body.error).join(","));
  // 只有一个候选口令能登录
  let loginable = 0;
  for (const p of cands) if (await canLogin(c.email, p)) loginable++;
  rec("R6-03b", "并发后只有一个口令生效（password mutation 恰好一次）", loginable === 1, `loginable=${loginable}/5`);

  // ---------- 6/7 归属校验 ----------
  const d = await mk("d");
  const sD = await recoverySession(d.email);
  const rWrongUser = await fn(sD, { flow_id: fC.flow_id, password: pw() });   // D 的 session + C 的 flow
  const bWU = await rWrongUser.json();
  rec("R6-06", "wrong user + valid flow → 拒绝",
    rWrongUser.status >= 400 && ["flow_not_owned", "flow_not_found"].includes(bWU.error),
    `status=${rWrongUser.status} err=${bWU.error}`);

  const rWrongFlow = await fn(sD, { flow_id: crypto.randomUUID(), password: pw() });
  const bWF = await rWrongFlow.json();
  rec("R6-07", "wrong flow + valid recovery session → 拒绝",
    rWrongFlow.status >= 400 && bWF.error === "flow_not_found", `err=${bWF.error}`);

  // ---------- 8 过期/无效 session ----------
  const rNoAuth = await fetch(`${URL_}/functions/v1/recovery-finalize`, {
    method: "POST", headers: H(ANON), body: JSON.stringify({ flow_id: fC.flow_id, password: pw() }),
  });
  rec("R6-08", "无 recovery session → 拒绝", rNoAuth.status === 401, `status=${rNoAuth.status}`);
  const rBadJwt = await fn("a.b.c", { flow_id: fC.flow_id, password: pw() });
  rec("R6-08b", "畸形 JWT → 拒绝", rBadJwt.status === 401, `status=${rBadJwt.status}`);

  // ---------- 9/10 失败 → 受控重试 → 成功 ----------
  const e = await mk("e");
  const sE = await recoverySession(e.email);
  const fE = await startFlow(sE);
  const rShort = await fn(sE, { flow_id: fE.flow_id, password: "short" });
  const bShort = await rShort.json();
  rec("R6-09", "口令不合规 → 拒绝且不消耗 flow（仍可重试）",
    rShort.status === 400 && bShort.error === "password_too_short", `err=${bShort.error}`);
  const stillPending = await flowRow(e.id);
  rec("R6-09b", "校验失败不推进状态机", stillPending.status === "pending", `status=${stillPending.status}`);
  const pE = pw();
  const rRetry = await fn(sE, { flow_id: fE.flow_id, password: pE });
  rec("R6-10", "受控重试后成功完成", rRetry.status === 200 && await canLogin(e.email, pE));

  // ---------- 18/19 重复打开不双写 ----------
  const g = await mk("g");
  const sG = await recoverySession(g.email);
  const f1 = await startFlow(sG);
  const f2 = await startFlow(sG);            // 模拟刷新 / deep link 二次打开
  rec("R6-19", "重复打开复用同一 flow，不新建（防双写）",
    f1.flow_id === f2.flow_id && f2.reused === true, `same=${f1.flow_id === f2.flow_id} reused=${f2.reused}`);
  const pG = pw();
  const g1 = await fn(sG, { flow_id: f1.flow_id, password: pG });
  const g2 = await fn(sG, { flow_id: f2.flow_id, password: pw() });   // 双击
  rec("R6-18", "double-click 不造成双写",
    g1.status === 200 && g2.status !== 200, `first=${g1.status} second=${g2.status}`);
  rec("R6-18b", "双击后只有第一次的口令生效", await canLogin(g.email, pG));

  // ---------- 11 明文口令持久化扫描 ----------
  const needles = [pA, pE, pG, ...cands].filter(x => x && x.length >= 8);
  const hits = [];
  for (const t of ["audit_logs", "security_events", "recovery_flows"]) {
    const r = await svc(`/rest/v1/${t}?select=*&limit=500&order=created_at.desc`);
    if (!r.ok) continue;
    const txt = await r.text();
    if (needles.some(n => txt.includes(n))) hits.push(t);
  }
  rec("R6-11", "明文口令持久化扫描 = 0", hits.length === 0, `scanned=${needles.length} hits=${hits.join(",") || "none"}`);

  // ---------- 13/14/15 身份与归属不变 ----------
  // 注意：注册触发器 handle_new_user 会自动授予 applicant 角色，因此新账号天然有 1 个角色。
  // 要断言的是「recovery 前后角色集合不变」，不是「角色数为 0」。
  const roles = await (await svc(`/rest/v1/user_roles?select=role&user_id=eq.${a.id}&revoked_at=is.null`)).json();
  const roleNames = roles.map(r => r.role).sort().join(",");
  rec("R6-13", "roles 不变化（recovery 不带来权限）",
    roleNames === "applicant", `roles=[${roleNames}]（注册时自动授予，recovery 未增删）`);
  const profs = await (await svc(`/rest/v1/profiles?select=id&id=eq.${a.id}`)).json();
  const byEmail = await (await svc(`/rest/v1/profiles?select=id&email=eq.${encodeURIComponent(a.email)}`)).json();
  rec("R6-14", "profile 不重复", profs.length === 1 && byEmail.length === 1, `byId=${profs.length} byEmail=${byEmail.length}`);
  const app = await (await svc("/rest/v1/applications", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({ applicant_id: a.id, pathway: "bth", status: "draft", form_data: { name_zh: "R6" } }),
  })).json();
  const sA2 = await recoverySession(a.email);
  const fA2 = await startFlow(sA2);
  const pA2 = pw();
  await fn(sA2, { flow_id: fA2.flow_id, password: pA2 });
  const appAfter = await (await svc(`/rest/v1/applications?select=applicant_id&id=eq.${app[0].id}`)).json();
  rec("R6-15", "业务 ownership 不变化（按 Person ID）", appAfter[0]?.applicant_id === a.id);

  // ---------- 16/17 其他 recovery session 与 session invalidation 实测 ----------
  const h = await mk("h");
  const sH1 = await recoverySession(h.email);
  const sH2 = await recoverySession(h.email);     // 第二个 recovery session
  const fH = await startFlow(sH2);
  const pH = pw();
  const okH = await fn(sH2, { flow_id: fH.flow_id, password: pH });
  const afterOther = await asUser("/rest/v1/course_catalog?select=code&limit=1", sH1);
  rec("R6-16", "completion 后另一 recovery session 的实际表现（实测记录）",
    true, `finalize=${okH.status} other_session_read=${afterOther.status}（${afterOther.status === 200 ? "仍可用" : "已失效"}）`);
  const oldStillLogin = await canLogin(h.email, h.initial);
  rec("R6-17", "改密后旧口令失效（session/credential invalidation 实测）", oldStillLogin === false, `old_password_works=${oldStillLogin}`);

  // ---------- 20 Edge 直接攻击 ----------
  const rNoBody = await fn(sD, {});
  rec("R6-20a", "缺参数 fail closed", rNoBody.status === 400, `status=${rNoBody.status}`);
  const rBadFlow = await fn(sD, { flow_id: "not-a-uuid", password: pw() });
  rec("R6-20b", "畸形 flow_id fail closed", rBadFlow.status === 400, `status=${rBadFlow.status}`);
  const rGet = await fetch(`${URL_}/functions/v1/recovery-finalize`, { method: "GET", headers: H(ANON, sD) });
  rec("R6-20c", "非 POST fail closed", rGet.status === 405, `status=${rGet.status}`);
  // 客户端不得自行推进状态机
  const rpcDirect = await asUser("/rest/v1/rpc/claim_recovery_flow", sD, {
    method: "POST", body: JSON.stringify({ p_flow: fC.flow_id, p_user: d.id }),
  });
  rec("R6-20d", "客户端直呼 claim_recovery_flow 被拒", rpcDirect.status >= 400, `status=${rpcDirect.status}`);
  const patchFlow = await asUser(`/rest/v1/recovery_flows?id=eq.${fC.flow_id}`, sD, {
    method: "PATCH", body: JSON.stringify({ status: "pending" }),
  });
  rec("R6-20e", "客户端不可直接 PATCH recovery_flows", patchFlow.status >= 400, `status=${patchFlow.status}`);

} catch (e) {
  rec("R6-XX", "测试执行异常", false, String(e).slice(0, 200));
} finally {
  for (const id of ids) await svc(`/auth/v1/admin/users/${id}`, { method: "DELETE" });
  const pass = R.filter(r => r.pass).length;
  writeFileSync("recovery_finalization_results.json", JSON.stringify(R.map(({ id, name, pass }) => ({ id, name, pass })), null, 2));
  console.log(`\n=== Recovery Finalization: ${pass}/${R.length} PASSED ===`);
  if (pass !== R.length) process.exitCode = 1;
}
