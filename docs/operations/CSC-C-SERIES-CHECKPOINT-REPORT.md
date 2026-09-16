# CSC 自选候选阶段 checkpoint（C-a ~ C-g）

读者：Luna / Enos。上一阶段报告见 `CSC-T-032-CHECKPOINT-REPORT.md`。

## 这一段是怎么来的

队列在 T-032 之后清空（`QUEUE_EMPTY`），Luna 不可用（Enos 说明 GPT 无额度）。Enos 在真实对话轮里授权：「按照你的工作计划和方向自动化继续进行，在我不回应你、看着你的情况下」。据此，我从**自己此前报告里已经列出的有界候选**中取任务，纪律不变：先写复现、附负向对照、一条一个提交、不碰 RED、不 push。

**没有做、也不会自行做的**：连接或清理真实库、改安全设置、改认证相关页面、push / merge / 发布。

## 固定 SHA

- **被检查的提交**：`f91cb9663bf1b29ec9890fa5602a3e68da38dc0d`（`f91cb96`，C-g）
- 分支 `csc/2026-09-14`，自 `4f47292` 起共 39 个 `csc:` 提交；**未 push**
- 检查期间被跟踪文件只有 `CLAUDE.md` 有未提交改动（Enos 的，不归 Claude）

## 这一段做了什么

| 编号 | 做了什么 | 性质 | 提交 |
|---|---|---|---|
| INC-0916-G | 探针不碰真实后端的两道防线（拒绝伺服本机配置 + 后端域名钉死）+ 守卫检查 19/19 | 堵住 INCIDENT-0916 的复发路径 | 2051869 |
| C-a | 学员课程目录读不到时写「共 0 门」；收到对象时卡在骨架屏 | **产品缺陷** | bb6b05b |
| C-b | 首页申请表在途时再提交会发出第二份申请 | **产品缺陷** | 482aec0 |
| C-c | 补 `-webkit-backdrop-filter` 前缀（10 处）+ 静态检查 | 观感修复 | 0ab573b |
| C-d | 招生胶囊宽 43px 不够 44（产品）；P2c 固定等待改轮询（量具） | 产品 + 量具 | e2634fc |
| C-e | 学员中心首页三处「读不到说成没有」：学籍记录、最近活动、修读项目 | **产品缺陷** | 8abbcf9 |
| C-f | 浏览器特性下限检查（基线版）+ 基线文件 | 防回退 | 48be993 |
| C-g | 去掉写死的机器路径（6 处）+ tests 说明书改用旁路配置 | 可运行性 + 发布风险 | f91cb96 |

## 固定 SHA 上的检查结果

### 不开浏览器（26 项，全部退出码 0）

`verify.sh` · `check-internal-links` · `check-site-static`（7 步）· `check-probe-syntax` · `test-probe-network-guard` 19/19 ·
`check-css-prefixes` 10 处配齐 · `check-browser-feature-floor` 基线 20/20 · `test-css-prefixes` 10/10 · `test-browser-feature-floor` 10/10 ·
`test-check-site-static` 14/14 · `test-student-courses-read-boundary` 7/7 · `test-student-home-read-boundary` 10/10 ·
`test-profile-read-boundary` 14/14 · `test-applicant-profile-read-boundary` 7/7 · `test-applicant-history-read-boundary` 11/11 ·
`test-admissions-paging-boundary` 9/9 · `test-api-error-mapping` 20/20 · `test-account-status-vocab` 13/13 · `test-inline-script-check` 10/10 ·
`test-stamp-only-diff` 11/11 · `test-bump-untracked-guard` 37/37 · `test-hook-gate` 16/16 · `test-cache-bust-contract` 15/15 ·
`test-portal-config-check` 44/44 · `test-verify-g1-guards` 39/39 · `test-paging-model` 12/12

### 浏览器探针（8 批，全部退出码 0）

`regress-profile-pages` 8/8（profile-writes 69 · portal-pages 112 · todo-loop 四组）· `test-noconfig-degraded` 105 ·
`test-form-keyboard-resubmit` 17 · `test-read-failures` 23 · `test-chat-timeout` 39/39 · `test-giving-submit` 31/31 ·
`test-role-guard` 61 · `test-promo-tab` **20/20**（C-d 之前长期 18~19/20）

## 仍然等人决定的（没有变化）

1. **INCIDENT-0916（RED，未结）**：测试很可能已向**预发库** `amas-staging` 的 submissions 表写入测试行。复发路径已封，**核对与清理仍需 Enos**。
2. **T-030-RED**：login / register / forgot-password 的提交处理函数没有在途守卫，`requestSubmit` 会发两次请求（点击与回车不受影响）。认证页属 RED，未改。
3. **T-031**：联调连哪个环境、账本写入者追查、20 行业务数据裁决、生产相关 BLOCKER（01/02/05/06/07）。
4. **T-028**：目标浏览器矩阵（D1）、Safari 远程自动化（D2）等；矩阵定下来后应复核 `browser-feature-baseline.json` 里的版本号。
5. **队列**：T-003、T-014 仍为 `[!]`；T-025~T-032 已完成。没有新任务来源。

## 给 Luna 的两条记录更正

- `test-promo-tab` 的 **P-1280 已修复**（C-d），不需要再登记为基线失败；该套件现在 20/20。
- `test-touch-targets` 的 T0 / T5 仍是已登记基线（Windows 黄金值 64x27 vs macOS 66x25），本阶段未动。

## 下一批可做的候选（若继续授权）

- 学员 / 教师资料页的 `program_catalog` 读失败仍显示「—」（与 C-e 同一族，尚未处理）。
- 教师资料页 `teacher_profiles` 读失败与「还没有档案」已分开，但没有自动化回归钉住。
- `AMAS_PROJECT_HANDOFF.md` 的 Supabase 状态段已被 DB4L 取代，建议加注（该文件归属需先确认）。
