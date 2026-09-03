# 验收测试

## SEC（安全与身份权限）

| 文件 | 层 | 运行方式 |
|---|---|---|
| `acceptance_tests.sql` | 数据库（RLS / 触发器 / 事务 / 权限） | `psql -f supabase/tests/acceptance_tests.sql`（postgres 身份），全部 `NOTICE: PASS` 即通过，结束自动回滚 |
| `sec3_http.mjs` | HTTP / REST / Edge Function | `node sec3_http.mjs`，需同目录 `staging.env` |
| `sec3_mfa.mjs` | MFA / AAL2 / 端到端 | 同上；内含 RFC 6238 TOTP 自实现，无需外部验证器 |

## PORTAL-1（申请者中心）

| 文件 | 层 | 断言数 | 运行方式 |
|---|---|---|---|
| `portal1_acceptance.sql` | 数据库（状态机 / 锁定 / RLS / 审计） | 23 | `psql -f supabase/tests/portal1_acceptance.sql`，结束自动回滚 |
| `portal1_http.mjs` | REST / RPC / Edge（真实 JWT，绕过前端） | 46 | `node supabase/tests/portal1_http.mjs` |
| `portal1_ui.mjs` | 浏览器（守卫 / console / 移动端 / 可访问性） | 28 | 先起本地站点，再 `node supabase/tests/portal1_ui.mjs` |
| `program_catalog_consistency.mjs` | D-2 项目清单一致性 | 6 | `node supabase/tests/program_catalog_consistency.mjs` |

`portal1_ui.mjs` 的额外前置：

```bash
python -m http.server 8090 --bind 127.0.0.1 &     # 探针访问 http://127.0.0.1:8090
```

并需**临时**把 `assets/js/supabase-config.js` 指向 staging（填入 URL 与 anon key），
**跑完必须还原为空配置**——仓库内不得留下任何密钥。
可用 `CHROME_PATH` 覆盖 Chrome 路径；Edge 的 headless 在近期版本上不可用，请用 Chrome。

## PORTAL-2（学籍核心）

| 文件 | 层 | 断言数 | 运行方式 |
|---|---|---|---|
| `portal2_acceptance.sql` | 数据库（生命周期 / HQ 门禁 / 学号 / 角色 / RLS） | 32 | `psql -f supabase/tests/portal2_acceptance.sql`，结束自动回滚 |
| `portal2_http.mjs` | REST / RPC / Edge（P2-9 十项攻击） | 52 | `node supabase/tests/portal2_http.mjs` |
| `portal2_ui.mjs` | 浏览器（守卫 / console / 移动端 / 真实空态） | 30 | 先起本地站点，再 `node supabase/tests/portal2_ui.mjs` |

`0013` 改动了 PORTAL-1 与 PORTAL-2 共用的 RPC 上下文守卫，**改这块务必回归 PORTAL-1 两套用例**。

## 环境文件

`staging.env` 放在运行目录，已在 `.gitignore` 中，**不得入库**。
所有脚本默认读运行目录下的 `staging.env`，可用 `AMAS_ENV=<path>` 覆盖。

```
URL=https://<ref>.supabase.co
ANON=<anon/publishable key>
SERVICE=<service_role key，仅本地测试用>
DBPW=<数据库密码>
PGHOST=aws-0-ap-southeast-1.pooler.supabase.com
```

> 连接串用 `aws-0-...pooler.supabase.com:5432`、用户名 `postgres.<ref>`。
> `aws-1-` 开头的主机名连不上。

## 测试数据清理

测试会创建 `sec3-*@amas-test.dev` / `p1-*@amas-test.dev` 账号，结束后执行：

```sql
delete from auth.users where email like '%@amas-test.dev';
```

删除用户会级联清掉其 profile、角色、申请与补件记录；审计日志的 actor 外键为
`ON DELETE SET NULL`（见 `0007_actor_fk_policy.sql`），审计条目本身保留。
