# CSC 阶段 checkpoint 检查报告（T-025 ~ T-032 + INC-0916-G）

读者：Luna / Enos。上一阶段报告见 `CSC-T-024-CHECKPOINT-REPORT.md`。

## 固定 SHA

- **被检查的提交**：`27cfcdcde2ad0775fac3afd31e2d566c0d2e81d0`（`27cfcdc`，T-031）
- 分支 `csc/2026-09-14`，自 `4f47292` 起共 30 个 `csc:` 提交；**未 push**
- 检查期间被跟踪文件只有 `CLAUDE.md` 有未提交改动（Enos 的，不归 Claude）；跑完状态一致
- 本报告所在的提交在上面这个 SHA 之后，只增加本报告、`PROJECT_STATE.md`、队列标记，以及 pre-commit 例行重打的缓存戳

## 一、门槛与链接一致性（验收要求的两项在最前）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `./scripts/verify.sh` | **0** | VERIFY OK |
| `python3 scripts/check-internal-links.py` | **0** | 153 个站内引用全部有对应文件 |

## 二、其余静态检查（不开浏览器，全部在 `27cfcdc` 上）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `node scripts/check-site-static.mjs` | 0 | 6 步，0 错误，0 空转 |
| `node scripts/check-probe-syntax.mjs` | 0 | 91 个 .mjs，0 语法错误 |
| `node scripts/test-probe-network-guard.mjs` | 0 | 19/19（探针不碰真实后端的两道防线） |
| `node scripts/check-account-status-vocab.mjs` | 0 | 三个集合完全一致 |
| `python3 scripts/check-cache-bust.py` | 0 | 5/5 |
| `node scripts/test-inline-script-check.mjs` | 0 | 10/10 |
| `node scripts/test-api-error-mapping.mjs` | 0 | 20/20 |
| `node scripts/test-applicant-profile-read-boundary.mjs` | 0 | 7/7 |
| `node scripts/test-profile-read-boundary.mjs` | 0 | 14/14（学员 / 教师资料页） |
| `node scripts/test-applicant-history-read-boundary.mjs` | 0 | 11/11 |
| `node scripts/test-admissions-paging-boundary.mjs` | 0 | 9/9（分页首尾页与空页） |
| `node scripts/test-paging-model.mjs` | 0 | 12/12 |
| `node scripts/test-account-status-vocab.mjs` | 0 | 13/13 |
| `node scripts/test-stamp-only-diff.mjs` | 0 | 11/11 |
| `node scripts/test-check-site-static.mjs` | 0 | 11/11 |
| `node scripts/test-regress-profile-pages.mjs` | 0 | 5/5 |
| `python3 scripts/test-bump-untracked-guard.py` | 0 | 37/37（含路径空格与非 ASCII） |
| `python3 scripts/test-hook-gate.py` | 0 | 16/16 |
| `python3 scripts/test-cache-bust-contract.py` | 0 | 15/15 |
| `python3 scripts/test-portal-config-check.py` | 0 | 44/44 |
| `node scripts/check-stamp-only-diff.mjs 4f47292 HEAD --per-commit --expect <6 个文件>` | 0 | 30 个提交：除预期的 6 个文件外，带戳文件只改了缓存戳 |

## 三、浏览器探针（本地 stub、自带 Chrome、外网请求全部拦截）

| 命令 | 退出码 | 摘要 |
|---|---|---|
| `node scripts/regress-profile-pages.mjs`（8 趟） | 0 | profile-writes PASS 69 · portal-pages 112/112 · todo-loop 四组 24/13/11/20 |
| `node scripts/test-noconfig-degraded.mjs` | 0 | PASS 105 FAIL 0（21 页 × 三种「没配置」+ 三处公开页） |
| `node scripts/test-form-keyboard-resubmit.mjs` | 0 | PASS 15 FAIL 0（另有 6 条认证页 RED 发现，见下） |
| `node scripts/test-read-failures.mjs` | 0 | PASS 23 FAIL 0 |
| `node scripts/test-chat-timeout.mjs` | 0 | 39/39（防线生效后 I2「零外网请求」由 FAIL 转 PASS） |
| `node scripts/test-giving-submit.mjs` | 0 | 31/31 |

## 四、本阶段任务

| 任务 | 状态 | 结果 | 提交 |
|---|---|---|---|
| T-025 | [x] | 学员资料页空响应卡在骨架屏；学员 / 教师页不再把读不到画成空表单 | 433c78e |
| T-026 | [x] | 缓存戳夹具补路径空格 / 非 ASCII（已跟踪页正常打戳，用户文件不被改） | 86d9eba |
| T-027 | [x] | 招生队列分页首尾页与空页边界检查（含变异对照） | 710977f |
| T-028 | [x] **YELLOW** | 兼容性未满足依赖 D1~D8 与 NOT_RUN N1~N9 | 949c5b9 |
| T-029 | [x] | 三处公开页的配置判据识别占位符（admin 不再建客户端；logToDB 不再往占位地址发表单） | ff17378 |
| INC-0916-G | [x] | 探针不碰真实后端的两道防线 + 守卫检查 | 2051869 |
| T-030 | [x] | 表单键盘路径重复提交：联系表单补守卫；认证页只测不修 | 2c6e1ce |
| T-031 | [x] **YELLOW** | 真实后端联调前置条件 22 项 | 27cfcdc |
| T-032 | [x] | 本报告 | 本提交 |

## 五、需要 Enos / Luna 处理

1. **INCIDENT-0916（RED，未结）**：测试很可能已向**预发库** `amas-staging`（ref 与本机 local 配置一致）的 submissions 表写入测试行（留言「张三 / zhangsan@example.invalid」、奉献「测试访客 / local@example.invalid」，2026-09-16 05:0x 前后）。复发路径已封（INC-0916-G），但**核对与清理需要 Enos**，Claude 不连真实库。
2. **T-030-RED**：login / register / forgot-password 的提交处理函数没有在途守卫，`requestSubmit` 可发出两次请求（回车与点击不受影响）。认证页属 RED，未改，等决定。
3. **T-031 报告里的待决定项**：联调连哪个环境、账本写入者追查、20 行业务数据裁决、生产相关 BLOCKER（01/02/05/06/07）。
4. **T-028 的依赖**：目标浏览器矩阵（D1）、Safari 远程自动化（D2）等。
5. **队列**：T-003、T-014 仍为 `[!]`；T-025~T-032 已完成。**Luna 目前不可用**（Enos 说明 GPT 无额度），队列没有新任务。

## 六、其他事实（如实记录）

- **既有失败，非本阶段引入**（已用 HEAD 版本对照）：`test-touch-targets` 18/20 属已登记基线（Windows 黄金值 64x27 vs macOS 66x25）；`test-promo-tab` 19/20 失败 P-1280（1280 宽视口下入口 43px < 44），**未登记基线**，建议 Luna 补登记或立项。
- 复核期间我执行 `Safari --version` 曾把 Safari 应用启动约 2.5 分钟，已结束进程，未打开任何页面（T-028）。
- 机器上仍有 1~3 天前启动的 headless Chrome 进程，非本阶段产生，未处理。
