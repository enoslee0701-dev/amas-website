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

## 一、SQL：`run.mjs` + `prelude.sql` + `checks.sql`

> **上一版（`run.sh`）被退回，退得对。** 它连的是**用户现有的 cluster**，只在里面新建一个库；
> 而 `prelude.sql` 要 `create role anon/authenticated/service_role` —— 那是 **cluster 级**变更，
> `drop database` 根本清不掉。「不接触既有数据/设置」那句承诺当时不成立。
> 它还只白名单了 `PGHOST` 却不传 `-h`，而 `PGHOSTADDR` 会盖过 `PGHOST`、`PGSERVICE` 能把目标指到任何地方；
> 清理失败也照样打印「已删除」。这些现在都改掉了，并且有离线反例盯着（见 §4）。

**目前只实现了一种模式**，它不碰任何既有 cluster，而且没有 fallback：

| 模式 | 状态 | 条件 | 它创建什么 |
|---|---|---|---|
| `cluster` | **已实现** | `initdb` + `pg_ctl` + `psql` 都在 | 用 `initdb` 在**自己的临时目录**里建一个 cluster，只监听自己的 unix socket（`listen_addresses=''`，不开 TCP）。角色、库、数据全在这个一次性 cluster 里，删目录即全清 |
| `container` | **未实现** | —— | —— |

`container` 那一支**执行部分没有写**。所以 `plan()` 一律把它判为不支持
（`containerSupported: false`），就算本机 Docker 守护进程在、镜像也在，也照样阻塞 ——
不给人误以为有这条路可走。

条件不满足 → **阻塞退出（NOT_RUN），不会退回去用现成的 cluster。**

```bash
node scripts/verify-g1/run.mjs --plan    # 只打印它打算怎么做，不执行任何东西
node scripts/verify-g1/run.mjs           # 真跑
```

连接目标是写死的：显式 `-h <自己的 socket 目录>`，并且把 libpq 会读的**全部**覆盖来源
（`PGHOSTADDR`、`PGSERVICE`、`PGSERVICEFILE`、`PGPASSFILE`、`PGOPTIONS` …）从子进程环境里删掉。

收尾的规矩只有一条：**没有确认它停了，就绝不删这个目录。**

- 不看「我以为我启没启起来」那个标志 —— 启动命令返回非零**不等于**进程没起来
  （`-w` 等待超时就是这样），那时候去删数据目录，删的是一个**活着的 postmaster**；
- 收尾一律去问 `pg_ctl status`（0=在跑 / 3=没在跑 / 4=目录不存在 / 其余=**不明**）；
- 在跑 → 先停，**停完再确认一次**；
- 停不掉、或状态不明 → **一次 `rm` 都不调**，保留目录，退出码 3，并给出准确路径与手动清理命令；
- 确认停了才删，删完**还要复查**目录是不是真的没了 —— `rm` 返回成功也不算数。

这套编排的副作用全部从 `io` 注入，被 `scripts/test-verify-g1-guards.mjs` 用**假适配器**打过
（断言的是「实际调了哪几步、有没有调 `rm`、顺序对不对」，不是返回文案）。

流程：自建 cluster → `prelude.sql`（补三个角色、`auth` schema、`auth.users`、读会话设置的
`auth.uid()`）→ 按序装 27 个迁移 → `checks.sql`。

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

## 四、防误连判据自己也有反例盯着

`scripts/test-verify-g1-guards.mjs`（纯离线，只 import `run.mjs` 的纯函数，不起数据库、不连任何东西）：

- `P2`：机器上**有 `psql`**（也就是能连用户现成的 cluster）时，**仍然判阻塞** —— 不拿它当 fallback；
- `Q1c/Q1d`：自建 cluster 时连接 host 就是它自己的 socket 目录，且不开 TCP；
- `R1/R2/R3`：`PGHOSTADDR`、`PGSERVICE`、`PGSERVICEFILE`、`PGPASSWORD`、`PGOPTIONS` … 一律删掉，
  而无关的 `PATH`/`HOME` 照常保留（不是把环境清空了事）；
- `S1/S1b/S1c/S2`：清理没成功时判失败、**不说「已删除」**、并点名残留路径；`S3` 是对照；
- `T1`–`T9`（**用假适配器打真实编排**）：停不掉时**一次 `rm` 都不调**；进程活着时先停再确认再删
  （断言调用顺序 `status,stop,status,rm,exists`）；状态不明不删；`stop` 说成功但状态仍是 running 也不删；
  `rm` 说成功但复查发现目录还在仍判失败；数据目录压根没建起来时不去停、直接删。

把旧 `run.sh` 的语义逐条移植回来跑同一套：19 条里 15 条转红，其中 `P2` 返回
`existing-cluster`、`S1` 返回 `{"ok":true,"message":"== 已删除 …"}`。

再把 `40b60a3` 的 `finally` 块语义原样搬回来跑扩充后的同一套：**39 条里 14 条转红**，其中

```
FAIL T1 停不掉时绝不删目录  ← rm,exists
FAIL T3 状态不明时不删      ← rm,exists
```

—— postmaster 还活着、停不掉，旧代码直奔 `rm`。那正是这一轮被退回的那条。

## 五、还需要真实环境才能验的（不在这里）

RLS 的实际生效、真实 JWT 的 `aal` 声明、Edge 部署后的行为、`audit_logs` 在真实项目里的可读范围 ——
属于 `web-acceptance-entry.md` 的 B3/B4，需要真实身份与环境。
