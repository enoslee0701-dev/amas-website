# PORTAL-2B · Student Experience & Learning Read Model · Staging Acceptance Report

**日期**：2026-09-03
**范围**：学生资料页、课程目录只读模型、学习读模型 adapter、待处理事项、能力门禁、不可逆记录登记规范
**执行**：只读审计 → 迁移 0016–0019 → 三层验收 + 全量回归
**结论**：**208 项断言全部 PASS**（DB 129 + HTTP 31 + UI 38 + 目录一致性 10）。
验收过程发现并修复 **1 个真实权限缺陷**。

> **状态口径**（不变）：staging acceptance PASS，**不是** Production Acceptance。
> production Supabase 尚未建立；重跑验收前不开放真实学生/教师。
> `mailer_autoconfirm=true`、四语言正式申请表升版，均为 production blocker。
> 67 门课程 `credits` 继续保持 `null`，未据此推算任何数值。

---

## 1. 先做的只读审计

完整结果见 `docs/operations/PORTAL-learning-data-audit.md`。最关键的三条：

1. **两套身份系统之间没有任何关联。** 门户用 Supabase Auth；App 用自己的 `users` 表
   + 自签 JWT，App 代码里 `supabase` **零引用**（全量 grep 确认）。
2. **App 后端没有部署。** `.env.local` 指向 `http://192.168.1.107:8787`（局域网开发机），
   仓库内无 fly/railway/render/vercel 配置。GitHub Pages 上的门户无法访问。
3. **而且目前也没有数据可读。** App 本地库 `course_progress` **0 行**、`growth_state` **0 行**。
   即使今天打通身份与网络，读回来的也是空的。

因此 2B-3 / 2B-4 / 2B-5 / 2B-7 中依赖真实学习与 CP 数据的部分**无法落地**——
不是难度问题，是**根本没有 Source of Truth 可读**。按"只落地已有真实数据源的状态"，
这些一律显示真实空态并说明原因，**没有造第二份 `course_progress`，没有伪造任何状态**。

其余不依赖该决策的部分全部实施完成（见 §3）。

---

## 2. 验收发现的真实缺陷

### 学生侧权限只看业务状态，没看角色

学生侧的 RLS 与能力判断只检查 `student_records.status`，**没有同时要求持有有效的
`student` 角色**。后果：撤销某人的 student 角色后，他手上的旧 JWT 仍然能

- 通过 RLS 读到自己的 `student_records`
- 从 `my_student_capabilities()` 拿到 `official_student_services = true`

前端路由守卫（`allow:["student"]`）会挡住页面，但**服务端没有挡**——
这正是"禁止只靠隐藏按钮实现权限控制"（工程规则 R-2）要防的情况。
2B-10 ⑫ 要求"revoke student role 后旧 JWT 即时失权"，PORTAL-2 当时只覆盖了学号别名撤销，
没有覆盖读取路径。由 `P2B-H26 / H27` 捕获。

**修复**（`0019`）：把"持有有效 student 角色"加入 RLS 策略与全部学生侧 RPC 的前置条件
（`my_student_record` / `my_student_timeline` / `my_student_profile` /
`my_learning` / `my_action_items` / `my_student_capabilities`）。
角色现查、不看 JWT 内容，因此撤销后即时生效：读 0 行、能力全否、学习读模型返回空、待办为空。
管理员读取路径不受影响——学生离开后教务仍需查档。

---

## 3. 逐条落地情况

| 条目 | 状态 | 说明 |
|---|---|---|
| **2B-1 Student Profile** | ✅ 完成 | 坚持 Single Person Model，未复制第二份人物主数据；`my_student_profile()` 返回 `self_editable` / `registrar_managed` 两个分区，UI 上教务字段标注「🔒 由教务维护」；`update_my_contact()` 的**函数签名本身就是字段白名单**，学号/状态/项目/HQ 审核无法经此修改 |
| **2B-2 Course Catalog Read Model** | ✅ 完成 | `course_catalog` 67 门只读镜像，权威源仍是 App `OFFICIAL_CATALOG`；`credits` 全 null 且由**数据库触发器**强制（写入即报错）；21 门 `in_development` 显示"课程已列入 AMAS 正式课程目录，当前线上学习内容尚未开放"，**无空播放器、无假课程页** |
| **2B-3 Learning Read Model** | ⚠️ 部分（受 D-2B-1 阻断） | adapter `my_learning()` 已建立，六种状态中**只落地有数据源的两种**：`catalogued`、`content_pending`。`accessible` / `recommended` / `assigned` / `in_progress` / `completed` 当前无 Source of Truth，**刻意不产生**。数据源接通后只改这一个函数，门户页面不必改 |
| **2B-4 我的学习** | ⚠️ 部分（同上） | 「正在学习」「已完成」因无可采信数据源而**不渲染**；「可学习」因无课程级授权数据源而不冒充；如实说明学习记录目前在 App 中 |
| **2B-5 CP 集成** | ⚠️ 部分（同上） | 未重新实现、未重算、未创建第二份 Profile。门户读不到 CP 数据，因此**不显示 Top 3 / 倾向指数 / 证据强度**，只给真实入口「建立你的信仰成长档案」 |
| **2B-6 Current Action** | ✅ 完成 | 首页当前行动**最多 1 学习 + 1 实践 + 1 反馈**（`P2B-U03` 验证 ≤3）；每条带原因与下一步 |
| **2B-7 Learning Evidence** | ⚠️ 不落地（同上） | App 的 `evidence.ts` 证据模型**已经存在且设计正确**（12 种类型、targetOrientations、polarity、strength），门户无需也不应重新定义。当前正确做法是什么都不建 |
| **2B-8 Notifications** | ✅ 完成 | `my_action_items()` 带 `source_type / source_id / reason / target_url / status`，且**由真实状态派生而非存储**——`P2B-B15` 验证：填写电话后该事项自动消失，证明不是硬编码文案 |
| **2B-9 pre_enrolled / active** | ✅ 完成 | `my_student_capabilities()` 服务端权威判断；`course_content_access` **不因 active 自动为真**（`P2B-H16` 专门验证） |
| **2B-10 Security** | ✅ 完成 | 13 项攻击测试全覆盖，见 §4 |
| **2B-11 Irreversible Registry** | ✅ 完成 | 见 §5 |
| **2B-12 禁止项** | ✅ 遵守 | 未实现选课、drop/add、GPA、成绩、成绩单、自动学分、毕业进度、账单、支付、奖学金、证书签发、休学/退学/毕业政策、自动学号 |

---

## 4. 2B-10 十三项攻击测试

| 要求 | 结果 |
|---|---|
| ① Student A 读 Student B profile | 学籍 0 行、profile 0 行（H02/H03） |
| ② student PATCH student_number | 403，值未变（H06） |
| ③ student PATCH status | 403；pre_enrolled 无法自升 active（H07/H08） |
| ④ student 修改 HQ approval | 403（H09） |
| ⑤ finance 读取学籍/CP | 0 行（H10/H11） |
| ⑥ teacher 默认读学生 | 0 行（占位函数 fail-closed，H12） |
| ⑦ applicant 访问 Student Dashboard | 学籍 0 行；能力门禁 `status=none` 全否（H13/H14） |
| ⑧ pre_enrolled 访问仅 active 能力 | 拒绝；且 active 也不自动获得课程访问权（H15/H16） |
| ⑨ 推荐课程伪造 enrollment | 系统内无 enrollment 表可写；读模型不产生 enrolled/recommended（H17/H18） |
| ⑩ completed 由客户端 PATCH | 403；credits 写入 403（H19/H20） |
| ⑪ 直接 REST 写 learning evidence | 三种表名全部拒绝（H21） |
| ⑫ revoke student role 后旧 JWT | **发现缺陷并修复**，现读 0 行、能力立即收敛（H26/H27） |
| ⑬ RPC context 同事务逃逸 | 保留；正面验证在 `portal2_number_void.sql` V14 与 `portal2_acceptance.sql` P2-D10/D11 |

---

## 5. 2B-11 不可逆记录登记规范

`student_number_has_irreversible_records()` 原本把检查写死在函数里，靠注释提醒后人。
**安全机制不能靠开发者记得**——新建 grades 表却忘了扩展闸门，纠错会静默漏判。

`0018` 把它升级为强制接口：

- 新增 `irreversible_record_sources` 登记表：每类正式记录必须登记，回答
  "是否构成学号的不可逆记录"，答 yes 时必须提供 `check_sql`
- 闸门改为**遍历登记表动态求值**，不再写死
- 存在 `pending_decision` 的来源时**一律 fail closed**（返回 true）——
  宁可拒绝一次合法纠错，也不能错误释放已生效的学号
- 自动化守卫 `portal2b_irreversible_guard.sql` 扫描 public schema 中名字像正式业务记录的表，
  **任何一张未登记就直接失败**

**守卫已验证确实会响**：临时造一张未登记的 `student_grades` 表，守卫立即捕获并指出该建哪条登记。
该要求已写入工程规则 **R-8**，列为 migration checklist 强制项。

---

## 6. 验收数据

| 层 | 用例 | 结果 |
|---|---|---|
| DB | `portal2b_acceptance.sql` | 17/17 |
| DB | `portal2b_irreversible_guard.sql` | 5/5 |
| DB 回归 | `acceptance_tests` 33 · `portal1_acceptance` 23 · `portal2_acceptance` 32 · `portal2_number_void` 19 | 107/107 |
| REST/RPC | `portal2b_http.mjs` | 31/31 |
| Browser | `portal2b_ui.mjs` | 38/38 |
| 一致性 | `portal2b_catalog_consistency.mjs` | 10/10 |
| HTTP 回归 | `portal1_http` 46 · `portal2_http` 72 | 118/118 |

浏览器层重点：课程页渲染 67 门、21 筹备 / 46 开放、**0 个 video/audio/iframe**（无空播放器）、
「不显示学分信息」且无「0 学分」、资料页只有 3 个可编辑输入且全部有标签、
保存真实写入服务端、390px 无溢出、触控目标全部 ≥40px、六种页面组合 console 错误均为 **0**。

---

## 7. 需要甲方决策

### D-2B-1｜门户与 App 的身份与数据打通方式

这是**唯一**阻断 2B-3/4/5/7 真实数据的问题，属于架构/政策决策。

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. App 迁移到 Supabase Auth** | App 改用 Supabase 登录，`course_progress` / `growth_state` 迁入 Supabase | 一次性改造 App 认证层；此后单一身份、单一权限模型，门户直接读 |
| **B. 账号绑定 + 后端部署** | 部署 App 后端；建绑定表；门户经服务端 adapter 拉取 | 保留两套身份，需维护绑定与令牌交换；安全面更大 |
| **C. 暂不打通**（当前形态） | 门户学习区维持真实空态 | 无额外成本；学生须回 App 看学习进度 |

**建议 A**：目前 `course_progress` 与 `growth_state` **都是 0 行**，现在迁移的数据成本几乎为零；
每晚一步，需要迁移和对账的数据只会更多。且 App 现有身份模型只有 student/admin 两级，
而 RLS、MFA/aal2、角色撤销即时失权、审计这些能力在 Supabase 侧都已验收过——
合并方向本来也应该往这边收。

### D-2B-2｜一门课的命名漂移（低风险）

官网作「世界观理解」，App 权威目录作「世界观」。同一门课，非新增非删除。
读模型按权威源采用「世界观」；官网文案是否同步修改请确认。
**未确认前不动官网**——改课程名称属于需要批准的动作。
一致性测试已把这条差异登记为 known drift，其余任何漂移都会立即失败。

---

## 8. 回滚

四个迁移均为**纯新增**（新表 + 新函数），除 `0019` 收紧了两条既有 RLS 策略外
不改动 0001–0015 的任何对象。回滚 = 反向 `drop`；新增页面为独立文件，
导航项可单独摘除，摘除后门户回到 PORTAL-2 形态。前端无构建步骤，`git revert` 单个 commit 即可。
