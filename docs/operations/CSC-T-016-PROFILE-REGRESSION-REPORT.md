# 资料页最小本地回归报告（T-016）

读者：Luna / Enos。由 `node scripts/regress-profile-pages.mjs` 生成，别手改；要更新就重跑。

- 生成时间：2026-09-15T12:17:12.253Z
- 分支 / 提交：`csc/2026-09-14` / `865dd68`
- 工作区未提交改动：6 项（运行时的状态，含尚未提交的本脚本与报告本身）
- 结论：**全部通过**（8/8）
- 范围：只用本地 stub、临时目录和自带的 Chrome；外网请求由各脚本拦截，没有连接真实账号、服务或数据库。
- Chrome：/Applications/Google Chrome.app/Contents/MacOS/Google Chrome（未设环境变量，取 lib/chrome-launcher.mjs 的 chromeBinary()）

| 检查 | 为什么在这里 | 退出码 | 耗时 | 摘要 |
|---|---|---|---|---|
| `node scripts/test-applicant-profile-read-boundary.mjs` | T-009 申请人资料页读取边界（node:vm） | 0 | 0.0s | portal/applicant/profile/index.html ｜ 情形 7 个 ｜ 不符合预期 0 个 |
| `node scripts/test-account-status-vocab.mjs` | T-010 账号状态词表契约（临时目录 + 真实仓库） | 0 | 0.3s | 用例 13 个 ｜ 不符合预期 0 个 |
| `node scripts/test-profile-writes.mjs` | T-011 三个资料页写入与在途防重（自带 Chrome） | 0 | 184.1s | PASS 60  FAIL 0 |
| `node scripts/test-portal-pages.mjs` | 资料页读取与渲染（自带 Chrome） | 0 | 102.6s | 112/112 通过 |
| `ONLY=St,A,G node scripts/test-student-todo-loop.mjs` | 学员待办 → 资料页补电话闭环 · St 组（自带 Chrome，组隔离单独一趟） | 0 | 12.6s | PASS 24  FAIL 0 |
| `ONLY=Sf,A,G node scripts/test-student-todo-loop.mjs` | 学员待办 → 资料页补电话闭环 · Sf 组（自带 Chrome，组隔离单独一趟） | 0 | 12.0s | PASS 13  FAIL 0 |
| `ONLY=Se,A,G node scripts/test-student-todo-loop.mjs` | 学员待办 → 资料页补电话闭环 · Se 组（自带 Chrome，组隔离单独一趟） | 0 | 10.3s | PASS 11  FAIL 0 |
| `ONLY=Sp,A,G node scripts/test-student-todo-loop.mjs` | 学员待办 → 资料页补电话闭环 · Sp 组（自带 Chrome，组隔离单独一趟） | 0 | 10.6s | PASS 20  FAIL 0 |

## 失败项

（无）
