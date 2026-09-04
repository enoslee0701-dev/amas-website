# AMAS 项目交接与状态基准

**文件性质**：跨会话交接文件。A 段是长期不变的约束，B 段是当前时点快照。

## 使用协议

```
Git / DB / Supabase / Deployment
        ↓ 提供「当前事实」
AMAS_PROJECT_HANDOFF.md
        ↓ 提供「决策与交接上下文」
GPT
        ↓ 总审查、拍板、下达任务
Claude
        ↓ 执行、测试、部署
更新本文件 B 段
        ↺
```

**冲突处理原则**：本文件提供历史与决策上下文；Git / Database / Supabase / 实际部署提供当前事实。
**两者冲突时以实际运行状态为准，必须报告差异，禁止静默覆盖历史记录。**

**防漂移原则**：本文件不复制专项文档的细节，只固化规则与状态，细节以被引用文档为准。
凡本文件与被引用文档冲突，以被引用文档为准，并在此处修正指向。

---
---

# A. 永久规则 / Source of Truth

> 本段内容变更需甲方拍板，不随阶段推进而调整。
> 完整原文见 `docs/operations/engineering-security-rules.md`（R-1 ～ R-10，每条都来自一次真实事故或明确决策）。

## A.1 项目架构

| 组成 | 仓库 / 位置 | 说明 |
|---|---|---|
| **官网 + 门户**（本仓库） | `enoslee0701-dev/amas-website` | 纯静态站，GitHub Pages 从 `master` 直发 |
| **App（移动端）** | `enoslee0701-dev/AMAS-Seminary` | React + Vite + Capacitor；本地目录 `Desktop/amas---asian-missionary-theological-seminary` |
| **后端 / 身份 / 权限** | Supabase | migrations + Edge Functions 在本仓库 `supabase/` 下 |

**分工**：网站负责发现与招生，App 负责持续装备与成长。

**Source of Truth 归属**（不得双向独立修改）：

- **身份与权限** → Supabase（D-2B-1 批准方案 A：App 迁移到 Supabase Auth，Supabase 成为 App / Portal 统一身份与权限 SoT）
- **快速测评 CP** → 本仓库 `discover.html`（Level 0，`quick-faith-v1`）；`AMAS-Seminary/public/discover.html` 仅为同源副本，改动一律先在本仓库完成再同步
- **业务规则** → 《新生入学手册 V2.0 中文完善版》（甲方审定）+ 官网现行文案
- **权限矩阵** → `docs/permissions/matrix.md`
- **认证体系** → `docs/auth/README.md`

## A.2 身份原则

1. **公开注册只产生 `applicant`**。`student` / `teacher` / `mentor` / 各管理角色**只能由受保护流程授予**。
2. **角色记录在 `user_roles` 表**，禁止用 JWT metadata 承载角色。
3. **学号→账号映射永不下发前端**。仅 `login-by-identifier` Edge Function（service key）可解析；`login_aliases` 无任何客户端策略。
4. **身份标识级操作必须双人控制**（R-3）。释放 / 重分配 / 撤销已出现过的学号、教职工号、登录别名：发起与确认拆成两个 RPC，发起人 ≠ 确认人，两人中必须有 `super_admin`，前置条件在确认时刻原子重验，全流程写审计。
5. **缺失作者 ≠ system author**（R-10）。身份主体消失后保留内容，用 `user_id = NULL` + `author_state = deleted_account` 的 tombstone 语义；**不建 fake system user**，前端显示「已注销用户」而非「匿名用户」，不得因迁移扩大可见范围。

## A.3 权限原则

1. **权限展示 ≠ 权限控制**（R-2）。按钮显隐、导航过滤、路由跳转**只是展示**。真正门禁必须同时存在于：① RLS 策略 ② RPC / SECURITY DEFINER 内的角色复核 ③ Edge Function 入口校验（角色 + `aal`）。
   **每个功能上线前必须验证：绕过 UI 直接打 REST / RPC / Edge 会被拒。**
2. **临时特权必须最小作用域且用后即焚**（R-1）。安全性不得依赖调用方事务边界、连接池行为或框架默认实现。凡新增 GUC / context flag / bypass marker，**验收必须包含「合法 RPC 之后、同事务内继续直写」的逃逸测试**。
3. **fail-closed 占位函数不得临时改成 true**（R-5）。`is_assigned_teacher` / `is_enrolled_student` / `is_assigned_mentor` 在正式关系表建立前恒返回 `false`，禁止为了「先让页面看到数据」而放开。
4. **外键维护动作不得被写保护触发器误伤**（R-4）。写保护只拦 UPDATE 并显式放行「仅置空 actor 外键」的更新；DELETE 交给外键级联；append-only 由权限保证而非触发器。新增写保护触发器时，验收必须包含「注销一个参与过该流程的账号」。
5. **新增正式业务记录必须回答「是否构成学号的不可逆记录」**（R-8，migration checklist 强制项）。必须在 `public.irreversible_record_sources` 登记；答 `pending_decision` 时闸门**一律 fail closed**。自动化守卫 `supabase/tests/portal2b_irreversible_guard.sql` 每次新增 migration 后必跑。
6. **密钥纪律**（R-6）。`service_role` / secret key 永不进前端、永不进 Git；前端只允许 `PUBLIC_SUPABASE_URL` + anon / publishable key；MFA secret、otpauth URI、邀请码明文不得进入审计、console log、network error log 或前端持久存储。

## A.4 课程与内容边界

> 依据：《新生入学手册 V2.0》+ 官网现行文案（**已审定，不得改动**）；工程侧对应 R-7「不制造假数据」。

1. **课程固定 67 门 / 7 类**。不得新增、改名，不得把候选课程算入正式课程。
2. **`credits = null` 显示为「不显示学分信息」**。不显示 0、不推算、不生成进度百分比。各课学分**待学院确认**。
3. **11 项实践训练不计毕业学分**，未完成不影响毕业。
4. **两条路径**：正式 B.Th 学籍路径 / 共同学习路径。共同学习**不自动建立 B.Th 学籍、不自动授予学位、记录不自动转换为学位学分或毕业资格**；日后申请正式 B.Th 须重新完成当时有效的申请与审核。
5. **学籍由 AMAS 总校审核建立**。
6. **毕业审核、授位、转学分、插班等流程「待学院确认」**，未获批准前不实现。
7. **无真实数据显示真实空态**：不填充占位内容，无 enrollment 时不创建空记录，不建立点进去空无一物的页面（宁可先不放导航入口）。

## A.5 Git 并发规则（R-9）

1. **不同工作流不得共享同一个 Git working tree**。高风险或跨域任务必须使用独立 branch + `git worktree`（独立目录、独立 `node_modules`）。
2. **baseline 必须在自己的 worktree 中重新取得**，不引用混合 commit 上的旧结果。
3. **合并窗口**按序执行：暂停其他工作流自动提交 → fetch/rebase 或 merge 最新主分支 → 处理冲突 → **全量回归**（本分支 + 被合并方 + 前后端）→ merge → 恢复并发工作流。
4. **已混合的历史：禁止** force push、amend 已共享提交、rebase 已共享主分支、整体 revert 混合提交。改为补 provenance / rollback manifest，逐文件说明归属与回滚步骤，并显式列出不得随之回滚的他方文件。

> 事故来源：2026-09-03 祷告室工作流与 Supabase Auth 迁移工作流共享工作区，`git add -A` 把未提交的 AUTH 文件并入 `376344d`。后果不是历史不好看，而是高风险改动失去独立回滚边界。

## A.6 Production 验收规则

1. **staging acceptance PASS ≠ Production Acceptance**。所有现有验收报告的结论**仅适用于 staging**。
2. **Production 环境必须重跑同一套全量脚本**（迁移已幂等，脚本可直接复用）。
3. **在 production 重跑全量验收前，不开放真实申请人 / 学生 / 教师使用**。
4. **验收发现的缺陷修复后必须完成全量回归**，不接受「只回归受影响用例」。
5. 上生产前必须清掉 B.3 列出的全部 blocker。

## A.7 禁止自行决定的事项

以下一律**先报告、等拍板**，不得自行选择方案后再告知：

- 修改 A 段任何一条规则，或为通过测试而放宽规则
- 新增 / 改名 / 删除 67 门正式课程中的任何一门；为 `credits` 填入任何非 null 值
- 实现标注「待学院确认」的流程（毕业审核、授位、转学分、插班等）
- 制定 Account Deletion / Content Retention 政策（R-10 只解决迁移中的归属问题，不得借此顺手制定）
- 把 fail-closed 占位函数改为返回 true
- 在 production 执行迁移、开放真实用户、或宣布 Production Acceptance
- force push / amend / rebase 任何已共享的提交
- 改变 Source of Truth 归属（A.1）
- 新增需要甲方提供内容的页面并用占位内容填充
- 在两个仓库之间双向独立修改同源文件（`discover.html`）

---
---

# B. 当前实时状态 / Current Checkpoint

## B.0 更新约定

1. **每轮任务开工时先刷新本段**，据 Git / Supabase / 实际部署重新核验，不沿用上轮字段。
2. **`Main HEAD` 记录「刷新本段时仓库的 HEAD」**，因此它必然落后一个提交——落后的那个正是「更新 B 段」这次提交本身。文档无法记录自己所在的哈希，这是约定而非缺漏，不必追平。
3. **刷新时若发现本文件与实际状态冲突**，以实际为准，在交付说明中报告差异，**并保留原记录的历史痕迹**（改 B 段，不改已归档的验收报告）。
4. A 段不随本段更新；改 A 段需甲方拍板。

---

> 所有字段以 Git / Supabase / 实际部署核验为准。

```
Date:               2026-09-04
Main HEAD:          3ddbd88  新增项目交接与状态基准 AMAS_PROJECT_HANDOFF.md
                    （按 B.0-2，本字段落后的一个提交为「更新 B 段」本身）
Active branch:      master（本地与 origin 唯一分支；不存在 auth 分支）
Working tree:       clean，与 origin/master 完全同步（0 / 0）
Environment:        Supabase staging amas-staging
                    ref sdrwyebizfdwldlfjyim · ap-southeast-1 · Postgres 17.6
                    Production Supabase：尚未建立
Frontend:           GitHub Pages 已上线 https://enoslee0701-dev.github.io/amas-website/
                    线上内容与 origin/master 逐字节一致（15 文件 SHA256 核验通过）
```

## B.1 已完成阶段

| 阶段 | 范围 | 结论 | 报告 |
|---|---|---|---|
| **SEC-1 / SEC-2** | 身份权限地基 + 教师验证闭环 | **104/104 PASS**（98 自动化 + 6 UI），修复 3 个真实缺陷 | `SEC-3-acceptance-report.md` |
| **PORTAL-SHARED / PORTAL-1** | 门户底座 + 申请者中心（申请→招生审核闭环） | **103/103 PASS**（DB 23 + HTTP 46 + UI 28 + D-2 一致性 6），修复 3 个真实缺陷 | `PORTAL-1-acceptance-report.md` |
| **PORTAL-2** | 学籍身份与学习门户核心（生命周期 / HQ 门禁 / 学号 / 角色转换） | **164/164 PASS**（DB 32 + 学号纠错 19 + HTTP 72 + UI 41），修复 2 个真实缺陷 | `PORTAL-2-acceptance-report.md` |
| **PORTAL-2B** | 学生体验与学习读模型（资料页 / 课程目录 / 待处理 / 能力门禁 / 不可逆记录登记） | **208/208 PASS**（DB 129 + HTTP 31 + UI 38 + 目录一致性 10），修复 1 个真实权限缺陷 | `PORTAL-2B-acceptance-report.md` |
| **D-AUTH-R2 / R6** | canonical `/auth/recovery` + Recovery Finalization 幂等 | **29/29 PASS** | commit `64ab70f` |
| **AUTH-R6.1** | Recovery Flow Liveness（幂等锁不会把合法用户永久锁死） | **13/13 PASS** | commit `e13503e` |
| **AUTH-M1** | App 身份系统只读审计与迁移映射（未做任何修改） | 审计完成，结论经甲方修正 | `AUTH-M1-identity-audit.md` |

**累计 staging 断言：621 PASS**（104 + 103 + 164 + 208 + 29 + 13）。**全部为 staging，无一项为 Production Acceptance。**

## B.2 代码资产现状

```
migrations       21 个（0001 → 0021_recovery_flow_liveness）
Edge Functions    7 个：login-by-identifier / create-teacher-invitation /
                  submit-teacher-verification / review-teacher-verification /
                  review-application / student-lifecycle / recovery-finalize
测试套件         18 个（supabase/tests/，三层：DB .sql / HTTP .mjs / UI .mjs）
门户页面         13 个（portal/ 下 applicant·student·teacher·admin 四空间 + mfa）
认证页面          5 个（login / register / forgot-password / auth/callback / auth/recovery）
```

## B.3 当前 BLOCKER

| # | Blocker | 性质 | 解除条件 |
|---|---|---|---|
| 1 | **Production Supabase 尚未建立** | 阻断上线 | 建项目 → 跑 0001–0021 → 部署 7 个 Edge Function → 重跑全量验收 |
| 2 | **`mailer_autoconfirm=true`** | 阻断上线 | 恢复 `false` 并配置正式 SMTP。⚠️ 该值在托管项目 Auth 设置中，**无法从仓库核验**；本地 `supabase/config.toml` 的 `enable_confirmations = false` 是 CLI 本地配置，与之不是同一处 |
| 3 | **四语言正式申请表未升版** | 阻断真实招生 | 真实招生开放前完成升版 |
| 4 | **67 门课程 `credits` 待学院确认** | 内容待定 | 学院给出学分后填入；在此之前保持 `null`，不显示不推算 |

## B.4 下一步

**待 GPT 拍板后执行。** 依 B.3 优先级，最优先项为 **Production Acceptance 准备**（Blocker 1 + 2）。

在获得明确批准前**不执行**：建 production 项目、在 production 跑迁移、开放真实用户。

## B.5 最近一次重要决策

| 日期 | 决策 | 记录 |
|---|---|---|
| 2026-09-03 | **D-2B-1 方案 A**：App 迁移到 Supabase Auth，Supabase 成为统一身份与权限 SoT | `AUTH-M1-identity-audit.md` |
| 2026-09-03 | **R-9**：不同工作流不得共享同一 Git working tree（源于真实事故） | `engineering-security-rules.md` |
| 2026-09-03 | **R-10**：缺失作者 ≠ system author，改用 tombstone 语义 | `engineering-security-rules.md` |
| 2026-09-03 | **AUTH-M1 结论修正**（甲方拍板）：撤回「近乎空数据迁移」表述 | `AUTH-M1-identity-audit.md` |
| 2026-09-03 | **R6.1 口径修正**：processing stale threshold 是运行策略，不是平台假设 | commit `f72aba2` |
| 2026-09-04 | **pre-commit hook 修复并纳入版本控制**：原 hook 只暂存 5/13 个被 `bump.py` 戳记的文件，导致每次提交后 8 个文件残留为未提交改动 | commits `ef89d6e` `76fa538` `de2f730` |
| 2026-09-04 | **建立本交接文件**，确立 GPT 拍板 / Claude 执行的闭环与「MD 提供上下文、Git 提供事实」的冲突处理原则 | commit `3ddbd88` |
| 2026-09-04 | **首页 12 成长角色改为走马灯**：新增 `scripts/gen-archetype-thumbs.py` 生成裁剪缩略图（2551KB → 271KB），4 组 × 3 张分组淡入淡出。**属纯展示层调整，未触碰 A 段任何规则** | commit 见 B.0-2 |

## B.6 待确认差异（核验发现，未自行处置）

| # | 差异 | 事实 | 待谁决定 |
|---|---|---|---|
| 1 | **不存在 `auth` 分支** | 本地与 origin 唯一分支为 `master`；AUTH 工作（`64ab70f` `e13503e` `f72aba2`）直接提交在 master 上，与 **R-9**「高风险任务用独立 branch + worktree」不符 | 甲方 / GPT 确认是否为有意为之；若否，后续 AUTH 工作应开独立分支 |
| 2 | **PORTAL-2 断言数口径不一** | 提交 `5f8bc09` 信息写 114/114，验收报告写 164/164；报告分项相加（DB 32 + 学号纠错 19 + HTTP 72 + UI 41）= 164。本文件按报告取 **164** | 确认提交信息为笔误后归档 |
| 3 | **`mailer_autoconfirm` 无法从仓库核验** | 该值在托管项目 Auth 设置中；仓库 `supabase/config.toml` 的 `enable_confirmations = false` 是 CLI 本地配置，与之不是同一处 | 需登录 Supabase 控制台核实 staging 实际值 |

## B.7 已知非缺陷（避免重复排查）

| 现象 | 结论 |
|---|---|
| 首页测评入口条的 12 成长角色卡「消失」 | **非缺陷**。原为 `baa43ae` 起的既定设计（`≤1000px` 一律隐藏）；图与样式始终完好，从未丢失。2026-09-04 已重做为走马灯，见下条 |
| 首页走马灯 / 顶部横幅**在本机不动** | **非缺陷，是系统偏好**。实测 `SPI_GETCLIENTAREAANIMATION = False`，即 Windows「设置 → 辅助功能 → 视觉效果 → 动画效果」为关；Chromium 据此上报 `prefers-reduced-motion: reduce`，命中 `main.css:694` 的全局规则（`*{animation-duration:.01ms!important}`），**全站动画一律冻结**。访客侧默认开启，线上正常播放。排查此类「动画不动」先查该系统开关，不要改代码 |

---

## 附录：本地环境须知

**新克隆后必须执行一次**（`core.hooksPath` 是本地配置，不随仓库传递）：

```bash
git config core.hooksPath .githooks
```

不执行则提交时不会自动刷新资源版本号，访客可能吃到旧缓存。

**部署链条**：改代码 → `git commit`（hook 自动 cache-bust）→ `git push origin master` → GitHub Pages 构建约 30 秒–2 分钟 → 线上更新。
**未 push 则线上不变**；只有 `master` 分支参与发布。
