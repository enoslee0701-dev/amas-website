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

同理，`student_number_has_irreversible_records`（`0015`）是纠错流程的安全闸门：
**今后任何产生不可逆正式记录的表（成绩、学分认定、证书签发、收据）
都必须在该函数内登记**，否则纠错流程会漏判，把已产生正式效力的学号错误释放。

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
