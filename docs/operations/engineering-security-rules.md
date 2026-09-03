# AMAS 全局工程安全规则

本文件记录**跨阶段、长期有效**的工程约束。每一条都来自一次真实事故或一次明确决策，
不是泛泛的最佳实践清单。新增 migration、Edge Function 或权限逻辑前必须先读这里。

---

## R-1｜临时特权 / 上下文绕过令牌必须最小作用域且用后即焚

> 临时 privilege / context bypass token 必须具备最小作用域，并在**首次合法消费后立即失效**；
> 安全性不得依赖调用方事务边界、连接池行为或框架默认实现。

**来源**：PORTAL-2 验收（2026-09-03）。`0009` 引入的 `amas.rpc_context` 用
`set_config(..., true)` 设置，是**事务级**的。RPC 返回后标记仍留在同一事务里，
此后同一事务内的任何直写都会被守卫当作"受保护流程"放行。

当时的实际部署没有被攻破，因为 PostgREST 一请求一事务。但这正是问题所在：
**这条防线的强度不该由调用方的事务边界决定**。换一个连接池模式、换一个客户端、
或某天在一个 RPC 里顺手多写一张表，防线就失效了——而且不会有任何报错。

**修复形态**（`0012` 起、`0013` 回补）：守卫触发器在放行一次后立即清空令牌。

```sql
declare
  in_rpc boolean := coalesce(current_setting('amas.rpc_context', true), '') = 'student';
begin
  if in_rpc then perform set_config('amas.rpc_context', '', true); end if;   -- 用后即焚
  ...
```

副作用是每个受保护 RPC 只能写主表一次——这是**特性不是限制**：需要写两次，
就说明该重新想清楚这个 RPC 的职责边界。

### 强制测试要求

后续 migration 中凡出现类似的 GUC / context flag / bypass marker，
**验收测试必须包含"合法 RPC 之后、同事务内继续尝试直接写入"的逃逸测试**。

现有实现：
- `supabase/tests/portal2_number_void.sql` → `V14`
- `supabase/tests/portal2_acceptance.sql` → `P2-D10`（直接 INSERT）、`P2-D11`（直接改状态）

新写一个这样的测试时，注意**测试必须在调用过合法 RPC 之后**再尝试直写；
在干净事务里直写只能证明"没有令牌时会被拒"，证明不了令牌是否会泄漏。

---

## R-2｜权限展示 ≠ 权限控制

按钮显隐、导航项过滤、路由跳转都只是**展示**。真正的门禁必须同时存在于：

1. RLS 策略
2. RPC / SECURITY DEFINER 函数内的角色复核
3. Edge Function 的入口校验（角色 + `aal`）

**禁止只靠隐藏按钮来实现权限控制。** 每个功能上线前必须验证：
绕过 UI 直接打 REST / RPC / Edge 会被拒。

---

## R-3｜身份标识级操作必须双人控制

释放、重新分配或撤销一个已经出现过的身份标识（学号、教职工号、登录别名），
属于高风险操作，不得由单个管理员静默完成。

**实现形态**（`0015`）：
- 发起与确认拆成两个 RPC，各自独立鉴权
- 发起人与确认人**不得为同一人**
- 两人之中**必须有 super_admin**
- 所有前置条件在**确认时刻原子重验**一次（申请提交后状态可能已变）
- 发起、确认、驳回、撤回全部写审计

---

## R-4｜外键维护动作不得被写保护触发器误伤

给表加 append-only / 写保护触发器时，必须同时考虑数据库自身发出的
`ON DELETE SET NULL` 与 `ON DELETE CASCADE`。

**来源**：`0007` 曾修过"actor 外键阻止账号注销"；`0012` 的 append-only 触发器
把同一问题重新引入——只要某人在学籍流程里留过痕，账号就再也删不掉。`0014` 修复。

**做法**：
- 写保护只拦 UPDATE，并显式放行"仅把 actor 外键置空、其余字段一字未改"的更新
- DELETE 交给外键级联；对客户端的 append-only 由**权限**保证
  （`revoke all` + 按列 `grant select`），不靠触发器
- 新增写保护触发器时，验收必须包含一条"注销一个参与过该流程的账号"的用例

---

## R-5｜fail-closed 占位函数不得被临时改成 true

`is_assigned_teacher` / `is_enrolled_student` / `is_assigned_mentor` 在正式关系表
建立前恒返回 `false`。**禁止**为了让某个页面"先能看到数据"而临时改成 `true`。

同理，`student_number_has_irreversible_records`（`0015`，`0018` 起改为遍历登记表）
是纠错流程的安全闸门：任何产生不可逆正式记录的表都必须登记——
具体强制流程见 **R-8**。

---

## R-6｜密钥与配置

- `service_role` / secret key **永不进前端、永不进 Git**
- 前端只允许 `PUBLIC_SUPABASE_URL` + anon / publishable key
- 本地跑 UI 探针时临时填入 staging 配置，**跑完必须还原为空配置**
- MFA secret、otpauth URI、邀请码明文 **不得进入**数据库审计、console log、
  network error log 或前端持久存储

---

## R-7｜不制造假数据

没有真实数据就显示真实空态，不填充占位内容；没有已批准的业务规则就不实现该功能。
具体到当前系统：

- 67 门正式课程固定，不得新增 / 改名 / 把候选课程算入正式课程
- `credits = null` 显示为"不显示学分信息"，**不显示 0、不推算、不生成进度百分比**
- 无 enrollment 时显示空态，**不创建空 enrollment 记录**
- 不建立点进去空无一物的页面；宁可先不放导航入口

---

## R-8｜新增正式业务记录必须回答"是否构成学号的不可逆记录"

**这是 migration checklist 的强制项，不是建议。**

凡新增以下任一类型的记录模型，migration 必须**同时**在
`public.irreversible_record_sources` 中登记，并回答"它是否构成 student number 的
irreversible record"：

`grade` · `earned_credit` · `transcript` · `certificate` ·
`financial_receipt` · `graduation_record` · `official enrollment record`

- 答 **yes**：必须同时提供 `check_sql`（接受 normalized 学号、返回 boolean），
  闸门 `student_number_has_irreversible_records()` 会自动把它纳入判断。
- 答 **no**：也要登记，并写明理由。
- 答 **pending_decision**：闸门**一律 fail closed**（返回 true），
  宁可拒绝一次合法纠错，也不能把已产生正式效力的学号错误释放。

**来源**：0015 的学号纠错闸门原本把检查逻辑写死在函数里，靠一句注释提醒后人来改。
安全机制不能靠开发者记得——一旦有人新建 grades 表却忘了扩展闸门，纠错会静默漏判。
`0018` 把它改为遍历登记表动态求值。

### 自动化守卫

`supabase/tests/portal2b_irreversible_guard.sql` 会扫描 public schema 中名字像正式
业务记录的表（grade/credit/transcript/certificate/receipt/payment/graduation/enrollment），
**任何一张未登记就直接失败**，并打印该建哪条登记。已验证该守卫确实会响
（造一张未登记的 `student_grades` 表，守卫立即捕获）。

每次新增 migration 后都要跑这条测试。

---

---

## R-9｜不同工作流不得共享同一个 Git working tree

> 不同 Agent / 自动化工作流不得在同一个 Git working tree 中并发修改和提交。
> 高风险或跨域任务必须使用独立 branch + worktree。
> 共享主分支的最终集成必须经过明确 merge window 和全量回归。

**来源**：2026-09-03。祷告室工作流与 Supabase Auth 迁移工作流在同一个工作区并发进行，
祷告室侧 `git add -A` 把尚未提交的 AUTH 文件一并纳入 `376344d`，
提交信息只描述了 Voice 侧工作。**两条工作流本身都没有错误，错在共享了工作区。**

后果不是"历史不好看"，而是：身份迁移这类高风险改动失去了独立的回滚边界——
想撤销 AUTH 就会连带撤销 Voice 的成果。

### 做法

- 高风险 / 跨域任务开独立 branch + `git worktree`（独立目录、独立 `node_modules`）
- 两个工作流各自只动自己的工作区，互不越界
- baseline 必须在自己的 worktree 中**重新取得**，不引用混合 commit 上的旧结果

### 合并窗口

一个可合并里程碑完成后，按顺序执行：

1. 暂停其他工作流的自动提交
2. fetch / rebase 或 merge 最新主分支
3. 处理冲突
4. **全量回归**（本分支 + 被合并方 + 前后端）
5. merge
6. 恢复并发工作流

### 万一已经混合

不要为了"漂亮的 Git 历史"增加工程风险——**禁止** force push、amend 已共享提交、
rebase 已共享主分支、或整体 revert 混合提交。改为补一份 provenance / rollback manifest
（范例：App 仓库 `docs/operations/AUTH-M2-M3-provenance.md`），逐文件说明归属、
给出精确的 AUTH-only diff 范围与逐路径回滚步骤，并**显式列出不得随之回滚的他方文件**。
可追溯性从"提交信息"转移到"显式清单"，在工程上等价且更安全。

---

## R-10｜缺失作者 ≠ system author

> 任何历史内容在身份主体消失后，如业务要求保留，应使用 tombstone / deleted identity 语义，
> 而不是重新赋予一个虚构所有者。

**来源**：2026-09-03 AUTH-M6。迁移中发现 2 条 `prayer_shares` 的作者账号已不存在。
把它们挂到 `system`、super_admin、房间管理员或任何其他用户，都会**凭空制造一个
从未写过这条内容的"作者"**——那不是保留历史，是伪造历史。

### 正确语义

```sql
user_id      -> NULL                  -- 当前没有可登录的 owner
author_state -> 'deleted_account'     -- 明确说明为什么没有
```

内容、`created_at`、room / audience / visibility 边界一律保持不变，
**不得因迁移扩大可见范围**。

### 配套要求

1. **不建 fake system user** 来承接这类记录
2. 前端显示「已注销用户」，**不显示「匿名用户」**——后者是作者主动选择匿名，
   把系统状态显示成匿名等于冒充用户的主动选择
3. 普通用户不得 claim 该内容；管理员不得把它重新绑定给其他人物
4. 原身份 UUID 存入**受限的 migration/audit artifact**（供回滚与审计），
   不进入普通前端读模型
5. orphan 扫描应把经过明确 tombstone 处理的记录归类为 **resolved orphan**，
   不再计为 migration blocker

### 检查归属判断是否对 NULL 安全

改成可空之前，先确认既有比较不会误判：
`row.user_id === me.id` 在 NULL 时为 `false`（无人拥有，正确）；
`row.user_id !== me.id` 在 NULL 时为 `true`（普通用户无法 claim，正确）。
若代码里存在 `!row.user_id || ...` 之类的短路，则必须显式处理，否则会变成"人人可 claim"。

> 本条只解决身份迁移中的归属问题。完整的 Account Deletion / Content Retention
> 政策属另一件事，未经批准不得借此顺手制定。
