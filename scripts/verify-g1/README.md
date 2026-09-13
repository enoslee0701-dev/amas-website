# G1 的真实验证：怎么跑，以及本会话为什么没跑

这一目录里两支脚本都是**可执行的真东西**，不是字符串比对，也不是浏览器 stub 冒充 SQL。
但它们在**编写它们的那次会话里一次都没有跑过** —— 本机缺运行时，且不允许安装。以下如实记。

## 本会话实测的环境（2026-09-13）

| 需要的 | 实际 |
|---|---|
| `deno` | **没有** |
| `psql` / `postgres` / `initdb` / `pg_ctl` | **全都没有** |
| `supabase` CLI | **没有** |
| Docker | 二进制在 `/usr/local/bin/docker`，**守护进程没起**：`Cannot connect to the Docker daemon`。且不允许拉镜像 |
| 已装好的 JS 版 Postgres（`pg-mem` / `pglite`） | **没有**。全局 node 包只有 `corepack`、`npm` |

结论：**执行被阻塞**，两支脚本一律 `NOT_RUN`。

## 一、SQL：`run.sh` + `prelude.sql` + `checks.sql`

前置条件：本机 PostgreSQL 14+，`psql` 在 PATH，一个能 `CREATE DATABASE` 的本机超级用户。

```bash
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres bash scripts/verify-g1/run.sh
KEEP=1 PGHOST=127.0.0.1 PGUSER=postgres bash scripts/verify-g1/run.sh   # 跑完保留库以便排查
```

**它碰不到任何既有数据**：库名由脚本自己生成（`amas_g1_verify_<时间戳>_<pid>`），
不接受外部指定；`PGHOST` 不是本机就直接拒绝跑；跑完默认 `drop database`。

流程：新建一次性库 → `prelude.sql`（补 `anon/authenticated/service_role` 三个角色、
`auth` schema、`auth.users`、以及读会话设置的 `auth.uid()`）→ 按序装 27 个迁移 → `checks.sql`。

`checks.sql` 断言的是：

| 段 | 验什么 |
|---|---|
| A | 只有 `submitted`/`under_review`/`needs_information` 能改指派；`draft` 与三个终态返回 `not_assignable` 且带回真实状态 |
| B | `expected` 对不上 → `reassigned` + 带回当前值，且**数据不动**；带对了才成功 |
| C | 已撤销 / 已过期的角色 → `not_a_reviewer`，且不写入 |
| D | 成功**只**写一条审计（`assign`/`reassign`/`unassign` 三种 event_type 各自正确）；被拒**一条都不写**；`application_status_history` 与申请人 `my_application_timeline` **一行都不多** |
| E | 申请人当 actor → `actor lacks admin role`；执行权限 `authenticated`/`anon` 都没有、只有 `service_role` 有 |

不覆盖 aal2 —— 那道闸在 Edge 里，不在数据库里。

## 二、Edge 入口：`edge-gate.test.ts`

前置条件：`deno` 1.40+；**首次运行需要一次网络**，因为
`supabase/functions/review-application/index.ts` 里是 `import { createClient } from "npm:@supabase/supabase-js@2"`，
测试本身还要 `jsr:@std/assert`。离线机器上先在有网处 `deno cache` 或 `deno vendor` 一次。

```bash
deno cache scripts/verify-g1/edge-gate.test.ts          # 一次，需要网络
deno test --allow-net --allow-env scripts/verify-g1/edge-gate.test.ts
```

它起一个本地 stub 冒充 `/auth/v1/user`、`/rest/v1/user_roles`、`/rest/v1/rpc/*`，
把 `SUPABASE_URL` 指过去，然后**导入真实的 `index.ts`**（`Deno.serve` 起在 8000），
用真实 HTTP 打它，断言：401 未认证 / 403 `mfa_required`（aal1）/ 403 `forbidden`（无审核角色）/
400（`op` 与 `action` 同时出现，哪怕 `action:null`）/ 400（body 是 `null`，不是 500）/
400 `expected_required` / 合法指派调的是 `assign_application_reviewer` 且参数一一对应 /
合法审核动作调的是 `review_application`（没串分支）。

⚠ 端口：`Deno.serve` 默认 8000，stub 用 8799。两个端口被占时先改掉再跑。

## 三、还需要真实环境才能验的（不在这里）

RLS 的实际生效、真实 JWT 的 `aal` 声明、Edge 部署后的行为、`audit_logs` 在真实项目里的可读范围 ——
属于 `web-acceptance-entry.md` 的 B3/B4，需要真实身份与环境。
