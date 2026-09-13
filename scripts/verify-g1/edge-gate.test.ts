/* review-application 这个 Edge 入口的**真实**端到端验证：角色闸、aal2 闸、
   两条分支的互斥与形状校验，一直到「到底调了哪个 RPC、参数是什么」。

   它不连任何真实 Supabase：本文件起一个本地 stub HTTP 服务冒充
   /auth/v1/user、/rest/v1/user_roles、/rest/v1/rpc/*，
   再把 SUPABASE_URL 指过去，然后**导入真实的 index.ts**（Deno.serve 会起在 8000），
   用真实 HTTP 请求去打它。断言的是处理器自己的行为，不是复述它的代码。

   跑法与前置条件见 README.md。本会话**没有 deno，没有跑过**：NOT_RUN。

   deno test --allow-net --allow-env scripts/verify-g1/edge-gate.test.ts
*/
import { assertEquals } from "jsr:@std/assert@1";

const STUB_PORT = 8799;
const EDGE_PORT = 8000;          // Deno.serve 的默认端口
const calls: Array<{ path: string; body: unknown }> = [];
let roleRows: Array<{ role: string }> = [{ role: "registrar" }];
let userOk = true;

/** 冒充 Supabase 的三个端点 */
const stub = Deno.serve({ port: STUB_PORT }, async (req) => {
  const u = new URL(req.url);
  let body: unknown = null;
  if (req.method === "POST") { try { body = await req.json(); } catch { /* 允许没有 body */ } }
  calls.push({ path: u.pathname, body });

  if (u.pathname === "/auth/v1/user") {
    if (!userOk) return new Response(JSON.stringify({ msg: "bad jwt" }), { status: 401 });
    return Response.json({ id: "00000000-0000-4000-8000-000000000002", aud: "authenticated" });
  }
  if (u.pathname === "/rest/v1/user_roles") return Response.json(roleRows);
  if (u.pathname.startsWith("/rest/v1/rpc/")) return Response.json({ ok: true, echoed: body });
  return new Response("nope", { status: 404 });
});

Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${STUB_PORT}`);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "local-stub-not-a-credential");
await import("../../supabase/functions/review-application/index.ts");

const b64u = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (aal: string) => `x.${b64u({ aal, sub: "u" })}.y`;

const post = (body: unknown, aal: string | null = "aal2") =>
  fetch(`http://127.0.0.1:${EDGE_PORT}/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(aal ? { Authorization: `Bearer ${jwt(aal)}` } : {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const A = "11111111-2222-3333-4444-555555555555";
const R = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const codeOf = async (res: Response) => {
  const j = await res.json().catch(() => ({}));
  return `${res.status}:${(j as { error?: string }).error ?? ""}`;
};

Deno.test("G1-1 没有 Authorization → 401 unauthenticated", async () => {
  userOk = false;
  assertEquals(await codeOf(await post({ application_id: A, action: "accept" }, null)), "401:unauthenticated");
  userOk = true;
});

Deno.test("G1-2 只有 aal1 → 403 mfa_required（aal2 闸没被绕过）", async () => {
  assertEquals(await codeOf(await post({ application_id: A, action: "accept" }, "aal1")), "403:mfa_required");
});

Deno.test("G1-3 没有审核角色 → 403 forbidden", async () => {
  roleRows = [{ role: "student" }];
  assertEquals(await codeOf(await post({ application_id: A, action: "accept" })), "403:forbidden");
  roleRows = [{ role: "registrar" }];
});

Deno.test("G1-4 同时带 op 与 action（哪怕 action:null）→ 400", async () => {
  assertEquals(
    await codeOf(await post({ application_id: A, op: "assign", action: null, reviewer_id: R, expected_reviewer: null })),
    "400:bad_request",
  );
});

Deno.test("G1-5 body 是 null → 400，而不是 500", async () => {
  assertEquals(await codeOf(await post("null")), "400:bad_request");
});

Deno.test("G1-6 缺 expected_reviewer → 400 expected_required", async () => {
  assertEquals(await codeOf(await post({ application_id: A, op: "assign", reviewer_id: R })), "400:expected_required");
});

Deno.test("G1-7 合法指派 → 调的是 assign_application_reviewer，参数一一对应", async () => {
  calls.length = 0;
  const res = await post({ application_id: A, op: "assign", reviewer_id: R, expected_reviewer: null, note: null });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const rpc = calls.filter((c) => c.path.startsWith("/rest/v1/rpc/")).pop();
  assertEquals(rpc?.path, "/rest/v1/rpc/assign_application_reviewer");
  const b = rpc?.body as Record<string, unknown>;
  assertEquals(b.p_app, A);
  assertEquals(b.p_reviewer, R);
  assertEquals(b.p_expected, null);
});

Deno.test("G1-8 合法审核动作 → 调的是 review_application（没串到指派分支）", async () => {
  calls.length = 0;
  const res = await post({ application_id: A, action: "accept", message: null, requirements: null, internal_note: null });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const rpc = calls.filter((c) => c.path.startsWith("/rest/v1/rpc/")).pop();
  assertEquals(rpc?.path, "/rest/v1/rpc/review_application");
});

globalThis.addEventListener("unload", () => { stub.shutdown(); });
