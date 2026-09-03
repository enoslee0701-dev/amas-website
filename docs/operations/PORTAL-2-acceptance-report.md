# PORTAL-2 Student Core · Staging Acceptance Report

**范围**：PORTAL-2 第一阶段 —— 学籍身份与学习门户核心（生命周期 / HQ 审核门禁 / 学号 / 角色转换 / 学员中心 / 教务学籍管理）
**环境**：Supabase staging `amas-staging`（ref `sdrwyebizfdwldlfjyim`，ap-southeast-1，Postgres 17.6）
**日期**：2026-09-03
**执行**：迁移 0012–0015、`student-lifecycle` Edge Function、三层自动化验收
**结论**：**164 项断言全部 PASS**（DB 32 + 学号纠错 19 + HTTP 72 + UI 41）。
验收过程发现并修复 **2 个真实缺陷**，并对 PORTAL-1 做了一次同源加固。

> **状态口径**：staging acceptance PASS，**不是** Production Acceptance。
> production Supabase 尚未建立；重跑验收前不开放真实学生使用。
> `mailer_autoconfirm=true` 仍是 production blocker。
> 正式四语言申请表尚未升版，真实招生开放前必须完成。
> 67 门课程 `credits` 继续保持 `null`，未据此推算任何数值。

---

## 0. 交付事实

| 项目 | 结果 |
|---|---|
| 迁移 | `0012_student_core`、`0013_rpc_context_single_use`、`0014_history_guard_fk_safe`、`0015_student_number_states` |
| Edge Function | `student-lifecycle` ACTIVE（aal2 + 角色复核，写库全部委托 RPC） |
| 新增页面 | `portal/student/`（学员中心）、`portal/admin/students/`（教务学籍管理） |
| 前端配置 | 验收期间临时指向 staging，**验收后已还原为空配置**；仓库内无任何密钥（已 grep 复核） |
| 测试数据 | 全部 `@amas-test.dev` 账号、学籍、申请、学号登记与纠错申请已清除；staging 现为 0 用户 / 0 学籍 / 0 学号 / 0 纠错申请 |

---

## 1. 验收发现的真实缺陷

### 缺陷 1 — RPC 上下文令牌可在同一事务内被继承（安全，已回补到 PORTAL-1）

`amas.rpc_context` 用 `set_config(..., true)` 设置，是**事务级**的。RPC 返回后标记仍留在同一事务里，此后同一事务内的任何直写都会被守卫当成"受保护流程"。

PostgREST 一请求一事务，实际不构成风险；但这条防线的强度不该依赖调用方的事务边界。PORTAL-2 的 DB 验收（P2-D10）正是在同一事务内先调 RPC 再直写，一次就穿透了。

**修复**：令牌**用后即焚**——守卫触发器放行一次后立即清空。每个受保护 RPC 因此只能写主表一次（现有 RPC 均只写一次），多写即被拒。`0012` 的 `student_guard` 一开始就采用该写法；`0013` 把 PORTAL-1 的 `application_protect_locked` 补齐，PORTAL-1 全量回归 23/23 无变化。

这次事故已上升为**全局工程规则 R-1**（见 `docs/operations/engineering-security-rules.md`）：
临时 privilege/context bypass token 必须最小作用域并在首次合法消费后立即失效；
安全性不得依赖调用方事务边界、连接池行为或框架默认实现。今后凡出现类似的
GUC / context flag / bypass marker，验收**必须包含**"合法 RPC 后同事务继续尝试直接写入"
的逃逸测试（现有实现：`portal2_number_void.sql` V14、`portal2_acceptance.sql` P2-D10/D11）。

### 缺陷 2 — append-only 触发器使学生账号永远无法注销

`0012` 给 `student_status_history` 加了 append-only 触发器，拦截所有 UPDATE 与 DELETE。但 `actor_id` 的外键是 `ON DELETE SET NULL`（0007 既定策略），注销账号时数据库会对历史行发出 `UPDATE ... SET actor_id = NULL`，被触发器挡下；`student_id` 的 `ON DELETE CASCADE` 发出的 DELETE 同样被挡下。

**结果**：只要某人在学籍流程里留过痕，其账号就再也删不掉——这正是 `0007` 当初修掉的那类问题，被新触发器重新引入。清理测试数据时暴露。

**修复**（`0014`）：触发器只管 UPDATE，放行"仅把 `actor_id` 置空、其余字段一字未改"的外键维护更新；DELETE 交由外键级联（客户端本就无 delete 权限，`0012` 已 `revoke all` 且只按列 `grant select`）。对客户端仍是严格 append-only，对数据库自身的引用完整性维护不再误伤。新增回归 P2-D31 / P2-D32 把这条行为钉死。

---

## 2. 三层验收结果

### 2.1 数据库层 —— `portal2_acceptance.sql` 32/32 + `portal2_number_void.sql` 19/19 PASS

| 组 | 覆盖 |
|---|---|
| HQ 门禁 | 无确认 / pending / rejected 三种情况建档全部失败；非管理员不得记录确认 |
| 生命周期 | 建档必为 `pre_enrolled`；直接 INSERT / 直接改 status / 直接改学号全部拒绝；非管理员不得激活；无学号不得激活；已 active 不得重复激活 |
| 学号 | 归一化（去空白+大写）且保留原样值；重复号拒绝；换发须有原因；**retired（真实用过）的旧号永不回收**；纯行政误录另见 §4 |
| 角色 | 建档授予 student、撤销 applicant；撤销 student 角色即撤销学号别名 |
| RLS | 学生只读自己；财务读不到学籍；登记簿对任何客户端不可读；`internal_note` 列未授予；特权 RPC 对 authenticated 不可执行 |
| 完整性 | 状态历史 append-only；账号注销可正常进行且历史正确处理 |

### 2.2 HTTP / REST / RPC / Edge 层 · `portal2_http.mjs` —— 72/72 PASS

以真实 JWT 直接打 Supabase，绕过所有前端逻辑。**P2-9 的十项攻击测试逐条覆盖**：

| P2-9 要求 | 结果 |
|---|---|
| ① Applicant 伪造 student route | 403（Edge）+ 浏览器层守卫弹回（P2-U21） |
| ② Student 读取他人 student record | 0 行（P2-H26） |
| ③ Student 修改自己的 status | 0 行受影响，值未变（P2-H21） |
| ④ Student 修改 student number | 0 行受影响，值未变（P2-H17） |
| ⑤ Teacher 查看无授权学生 | 0 行（占位函数 fail-closed，P2-H29） |
| ⑥ finance 获取学习/成长数据 | 0 行（P2-H28）——finance 不在 `student_records` 的读取策略内 |
| ⑦ academic_admin / registrar 边界 | 两者同属 `is_admin_any`，均可办学籍；finance / content_admin 均不可 |
| ⑧ 直接 REST 更新 student_records | 教务用 aal2 JWT 直接 PATCH 同样被拒（P2-H22） |
| ⑨ 直接 RPC 调特权函数 | 四个特权 RPC 对 authenticated 全部不可执行（P2-H09） |
| ⑩ revoke 后旧 JWT 即时失权 | 撤销 registrar 后同一张 aal2 JWT 立刻 403，且读不到任何学籍（P2-H44/H45） |

另覆盖：AAL1 一律 `mfa_required`；无 token 401；匿名读 0 行；总校内部备注对申请人不可见；学生时间线不含内部备注；建档/更正/激活三类审计齐全且更正审计含前后值与原因；审计中无 MFA secret / 口令等敏感值。

### 2.3 浏览器层 · `portal2_ui.mjs` —— 41/41 PASS

Chrome headless + CDP，采集 console 错误、未捕获异常。

| 类别 | 关键断言 |
|---|---|
| 路由守卫 | 两页未登录均跳登录页并带 `?next=`；不渲染任何真实学籍数据 |
| 越权 | 学生打开学籍管理被弹回自己空间；applicant 伪造 student route 被弹回申请者中心；被拒页面不含任何学籍字段 |
| 前端伪造 | 篡改 `localStorage` 里的会话与角色后直接打 REST，仍然 0 行——前端角色从来不是授权 |
| MFA | AAL1 教务被导向 `/portal/mfa/?next=…` 且不渲染列表；在浏览器里走**真实 TOTP 挑战页**升到 aal2 后方可进入 |
| 学号纠错 | 纠错页签存在并说明双人控制规则；无申请时显示真实空态；`pre_enrolled` 行有「申请纠正误录」入口，`active` 行没有 |
| 真实状态 | active 显示「在读」与真实学号；`pre_enrolled` 显示「待正式注册」且不谎称在读；最近活动来自真实状态历史 |
| 数据诚实 | 不出现学分、进度百分比、GPA；`credits=null` 未被显示成 0 |
| console | 六种页面/身份组合下 runtime 错误均为 **0** |
| 移动端 | 390px 横向溢出 0px；触控目标全部 ≥40px |

---

## 3. 按 P2-1 ～ P2-11 逐条核对

| 条目 | 落地 |
|---|---|
| **P2-1 生命周期** | `accepted → HQ approved → create → pre_enrolled → active`；白名单状态机（仅 `pre_enrolled→active`）+ 用后即焚令牌；每次变化写 append-only history + `academic` 类审计；未自行扩展休学/退学/毕业/开除 |
| **P2-2 HQ Approval** | `application_hq_approvals`（status / confirmed_at / confirmed_by / approval_reference / 可见说明）+ `hq_approval_internal` 分表隔离内部备注；DB + RPC + RLS + Edge + 验收五层齐备 |
| **P2-3 学号** | registrar 录入总校实际分配结果，**系统不生成任何编码规则**；归一化仅去空白+大写；真实用过的号 `retired` 永久占用，纯行政误录经双人流程 `voided_clerical_error` 后可重新分配（§4）；换号与纠错都强制原因，前后值/操作者/原因/依据全审计；学号别名与角色撤销同事务同步 |
| **P2-4 身份/角色** | 建档授予 student、撤销 applicant（无其他活动申请时）；`student_records` 只存学籍特有数据，姓名/邮箱一律取自 `profiles`，未建第二套人物资料 |
| **P2-5 Dashboard** | 身份卡 / 学籍状态 / 学号 / 当前提醒 / 我的学习 / 学习记录 / 信仰成长档案 / 最近活动，全部真实数据或真实空态 |
| **P2-6 课程边界** | 未建课程表、未填 placeholder credits、未做进度百分比；无 enrollment 时显示真实空态并链接官网 67 门目录 |
| **P2-7 Enrollment** | **V1 完全未实现选课**，也未建 enrollment 表——现阶段没有已批准的业务规则，先不落地任何状态语义 |
| **P2-8 CP 集成** | 未重新实现、未重算、未创建第二份 Profile；学员中心只提供入口与说明，指向 `discover.html` 与「AMAS 神学院」App |
| **P2-9 权限** | 见 §2.2，十项攻击逐条覆盖 |
| **P2-10 数据最小化** | 未新增任何字段收集健康、家庭、教会类型、经济状况或证件资料 |
| **P2-11 验收矩阵** | DB / REST-RPC-Edge / Browser 三层独立矩阵，共 164 项 |

---

## 4. 学号纠错机制（甲方 2026-09-03 批准，已实现于 `0015`）

原先"误录学号被永久占用"的问题已按批准方案解决。关键是把两个此前被混为一谈的业务事件彻底分开：

| 情形 | 判据 | 状态 | 号码占用 |
|---|---|---|---|
| **A 真实使用过** | 该号确实由总校分配给该学生（换号、退学、注销、状态变化均属此类） | `retired` | **永久占用**，任何人不得再取得 |
| **B 纯行政误录** | 该号从未真正属于该学生（总校分的是 A，录入写成了 B） | `voided_clerical_error` | 保留完整历史，但**不再占用**分配资格 |

因此弃用了含义模糊的 `released_*`——它此前同时被用来表示这两件事。
唯一性也从"主键"改成**部分唯一索引**：同一号码可以有多行历史，但处于占用态的至多一行。
**旧的 registry / history 记录一律保留，绝不删除。**

**刻意不采用"建档后 N 小时内可释放"**：建档 2 小时后已真实使用过号码 ≠ 可以释放；
建档 4 天后才发现纯录入错误 ≠ 不能纠正。真正的判据是「是否仍处于 `pre_enrolled`，
且该号是否从未成为真实正式身份」。时间只记录、只用于异常检测，不作决定性规则。

### 双人控制

释放一个曾出现过的学号属于身份标识级高风险操作，因此拆成两个独立鉴权的 RPC：

- `request_student_number_void` — registrar 或 super_admin 发起，必须给出**正确学号、纠错原因、HQ/教务依据**
- `approve_student_number_void` — 由**另一个人**确认；**发起人与确认人不得为同一人**，
  且两者之中**必须有 super_admin**（两种顺序都成立）
- 所有前置条件在**确认时刻原子重验**一次——申请提交后学生可能已被激活
- `reject_student_number_void` — 他人驳回记 `rejected`，发起人自撤记 `cancelled`

界面按批准的 V1 简化形态实现：教务在「在册学生」页对 `pre_enrolled` 学生点「申请纠正误录」，
在「学号纠错」页签由第二人确认。`active` 学生不出现该入口。

### 安全闸门

`student_number_has_irreversible_records()` 是纠错流程的闸门，目前检查"当前 active"与
"曾经进入过 active"。**今后任何产生不可逆正式记录的表（成绩、学分认定、证书签发、收据）
都必须在该函数内登记**，否则纠错会漏判——这条已写入全局工程规则 R-5。

### 验收（19 项，`portal2_number_void.sql`）

甲方指定的 12 项全部覆盖，另加 7 项：pre_enrolled 可申请纠正、active 不得 void、
retired 不得重新分配、voided 可重新分配给正确的人、registrar 单独不能释放、
super_admin 也不能直接 PATCH、发起人不得自批、旧号历史完整存在、
替代号冲突原子失败、alias 同事务更新、审计含 old/new/reason/依据且不泄漏敏感信息、
并发抢号只能一个成功，以及**强制的同事务逃逸测试**（见下）。

---

## 5. 尚未完成 / 明确不在本次范围

- **Production Acceptance 未执行**——production 项目尚未建立。
- 选课、学分算法、成绩单、GPA、毕业审核、财务缴费、文件中心：均无已批准业务规则，V1 一律未实现。
- `AMAS-application-form.docx` 四语言升版仍未完成（PORTAL-1 遗留，真实招生开放前必须完成）。
- 67 门课程学分表仍待提供。

---

## 6. 复跑方式

```bash
psql "$PGURL" -f supabase/tests/portal2_acceptance.sql     # 32
psql "$PGURL" -f supabase/tests/portal2_number_void.sql    # 19
node supabase/tests/portal2_http.mjs                       # 72
python -m http.server 8090 &                               # UI 探针需要本地站点
node supabase/tests/portal2_ui.mjs                         # 41
# 回归 PORTAL-1（0013 改动了共用守卫）
psql "$PGURL" -f supabase/tests/portal1_acceptance.sql     # 23
node supabase/tests/portal1_http.mjs                       # 46
```

UI 探针需临时把 `assets/js/supabase-config.js` 指向 staging，**跑完必须还原为空配置**。
