# SEC 验收测试

| 文件 | 层 | 运行方式 |
|---|---|---|
| `acceptance_tests.sql` | 数据库（RLS / 触发器 / 事务 / 权限） | `psql -f supabase/tests/acceptance_tests.sql`（postgres 身份），全部 `NOTICE: PASS` 即通过，结束自动回滚 |
| `sec3_http.mjs` | HTTP / REST / Edge Function | `node sec3_http.mjs`，需同目录 `staging.env`（含 `URL/ANON/SERVICE`），**该文件不得入库** |
| `sec3_mfa.mjs` | MFA / AAL2 / 端到端 | 同上；内含 RFC 6238 TOTP 自实现，无需外部验证器 |

`staging.env` 示例（放在运行目录，勿提交）：
```
URL=https://<ref>.supabase.co
ANON=<anon/publishable key>
SERVICE=<service_role key，仅本地测试用>
```
测试会创建 `sec3-*@amas-test.dev` 账号，结束后请执行：
```sql
delete from auth.users where email like 'sec3-%';
```
