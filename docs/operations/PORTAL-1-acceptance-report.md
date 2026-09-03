# PORTAL-1 Applicant Center · Staging Acceptance Report

**范围**：PORTAL-SHARED（门户共同底座）+ PORTAL-1（申请者中心：正式入学申请 → 招生审核闭环）
**环境**：Supabase staging `amas-staging`（ref `sdrwyebizfdwldlfjyim`，ap-southeast-1 / 新加坡，Postgres 17.6）
**日期**：2026-09-03
**执行**：迁移 0008–0011、`review-application` Edge Function、三层自动化验收（DB / HTTP / 浏览器）
**结论**：**103 项断言全部 PASS**（DB 23 + HTTP 46 + UI 28 + D-2 一致性 6）。验收过程发现并修复 **3 个真实缺陷**，修复后完成全量回归。

> **状态口径**：本报告是 **staging acceptance PASS**，不是 Production Acceptance。
> Production 环境尚未建立；在 production 重跑全量验收前，不开放真实申请人与教师使用。
> `mailer_autoconfirm=true` 仍是 production blocker，上生产前必须恢复 `false` 并配置正式 SMTP。

---

## 0. 交付事实

| 项目 | 结果 |
|---|---|
| 迁移 | `0008_applications`、`0009_application_rpc_context`、`0010_program_catalog`、**`0011_requirement_field_unlock`** 全部成功应用 |
| Edge Function | `review-application` ACTIVE（强制 aal2 + 服务端角色复核 + 写库全部委托 RPC） |
| 新增页面 | `portal/applicant/`（申请者中心）、`portal/applicant/application/`（六步正式申请表）、`portal/admin/admissions/`（招生审核台） |
| 共享底座 | `assets/js/portal/{auth,api,ui,shell,application-form}.js` |
| 前端配置 | 验收期间临时指向 staging；**验收后已还原为空配置**，仓库内不含任何密钥（已 grep 复核） |
| 测试数据 | 13 个 `@amas-test.dev` 账号与 8 份测试申请**已全部清除**，staging 现有 0 用户 / 0 申请 |

---

## 1. 验收发现的真实缺陷（3 个，均已修复并回归）

### 缺陷 1 — 补件流程死锁（业务逻辑，最严重）

**现象**：申请提交时锁定 `name_zh / birth_ym / gender / nationality / conversion_date / baptism_date / programs`。若审核员要求补充的恰好是其中之一（真实场景：**要求补填受洗日期**），申请人根本改不了这个字段，却又必须"完成补件"才能重新提交——流程彻底卡死。

这不是测试写错，是产品缺陷：现有实现里"要求补充资料"与"字段锁定"两条规则互相冲突，且冲突恰好落在最常见的补件对象上。

**修复**（`0011_requirement_field_unlock.sql`）：补件条目新增可选 `field` 列。审核员指定 `field` 时，`review_application` 把该字段**从 `locked_fields` 精确移除**——只解锁这一个，其余保持锁定；申请人订正后重新提交，`submit_application` 再次全量锁定。解锁范围与旧值一并写入 `admissions` 类审计。未指定 `field` 的条目不解锁任何字段（纯文字说明型补件）。

**为何不用更省事的做法**：整段放开 needs_information 的锁定检查，会让申请人在补件窗口内改掉姓名、国籍、申请项目——锁定机制形同虚设。按条精确解锁保住了锁的意义，且每次解锁都有审核员署名与审计记录。

**回归**：`P1-D10b/D10c/D12b`（DB）、`P1-H23b/H25b/H25c/H26b`（HTTP）。

### 缺陷 2 — Edge Function 二次序列化导致 500

`review-application` 把 `requirements` 数组 `JSON.stringify` 后再交给 RPC 的 `jsonb` 参数，`jsonb_array_elements` 收到的是字符串而非数组，`needs_information` 动作稳定 500。改为直接透传数组。

### 缺陷 3 — 移动端触控目标不足 40px

`shell.js` 头部的「退出」按钮在 390px 下实测仅 **25px** 高，低于 WCAG 2.5.8 触控目标下限。修复：`button.link` / `a.link` 统一 `min-height:40px`；句中行内链接（`.notice` 内）按该条款的 inline 例外排除，避免撑坏正文行高。

---

## 2. 三层验收结果

### 2.1 数据库层 · `supabase/tests/portal1_acceptance.sql` —— 23/23 PASS

状态机（非法跳转被拒、终态不可逆）、唯一活动申请约束、提交锁定与精确解锁、补件门禁、审核 RPC 服务端专属、跨用户 RLS、内部备注隔离、`internal_note` 列未授权、审计写入。

### 2.2 HTTP / REST / RPC 层 · `supabase/tests/portal1_http.mjs` —— 46/46 PASS

以真实 JWT 直接打 Supabase REST / RPC / Edge，绕过所有前端逻辑。

| 类别 | 关键断言 |
|---|---|
| 权限与提权 | 申请人 / 教师 / 无 token / AAL1 教务调审核函数 → 403·401；`review_application` 对 `authenticated` 直呼 → 403 |
| MFA | AAL1 审核 → `403 mfa_required`；真实 TOTP 换 aal2 后放行 |
| RLS | 跨用户读 0 行、跨用户写 0 行受影响且值未变；申请人选取 `internal_note` 列 → 403 |
| 状态机 | 直接 PATCH 改 status 被拒；重复提交 409；终态再流转 409；一人一份活动申请 409；撤回后可重建 |
| 隐私红线 | D-4/D-5/D-6 字段即使绕过 UI 直接写入，也被服务端触发器剥离，不落库 |
| 失权 | 撤销 registrar 后，**同一张 aal2 JWT** 立即失权 → 403 |

### 2.3 浏览器层 · `supabase/tests/portal1_ui.mjs` —— 28/28 PASS

Chrome headless + CDP，采集 console 错误、未捕获异常、失败请求。

| 类别 | 关键断言 |
|---|---|
| 路由守卫 | 三页未登录均跳登录页并带 `?next=`；不渲染任何业务数据 |
| 越权 | 申请人打开审核台被**路由守卫**弹回自己空间（不是只藏按钮）；页面不含任何内部数据 |
| console | 未登录态 / 登录态 / 移动端，六种组合下 runtime 错误均为 **0** |
| 移动端 390px | 申请者中心与申请表横向溢出 **0px**；触控目标全部 ≥40px |
| 可访问性 | 14/14 表单输入均有可及标签；无正数 `tabindex`；skip-link 存在 |
| 闭环 | 空状态 → 建草稿 → 渲染 6 步表单，全程无错误 |

### 2.4 D-2 项目清单一致性 · `supabase/tests/program_catalog_consistency.mjs` —— 6/6 PASS

官网 Quick Apply 下拉的 9 个项目代码与顺序，和 `program_catalog` 完全一致；Portal 申请表已不再 hard-code 项目代码；每个项目四语言文案齐全；项目目录未混入课程代码。

**这条测试是 D-2 决策的执行保障**：官网首页是纯静态营销页，不宜引入 Supabase 运行时依赖，因此改用测试把它钉在权威清单上——任何一侧改动而另一侧没跟上，测试立刻失败。

---

## 3. D-1 ～ D-6 决策落地核对

| 决策 | 落地方式 | 验收 |
|---|---|---|
| D-1 一份申请一个主项目 | `application_validate_program()` 服务端强制 | HTTP 层项目校验 |
| D-2 `program_catalog` 为唯一权威清单 | `0010` 表 + 种子；Portal 从表读取；官网由一致性测试钉住 | D2-01～06 |
| D-3 学习路径保留必填 | `applications.pathway` | 表单 S1 |
| D-4/D-5/D-6 不收集教会类型 / 家庭隐私 / 健康资料 | `application_strip_forbidden` 触发器服务端剥离 | P1-H08～H10 |

D-4/D-5/D-6 **不是靠前端不渲染实现的**：绕过 UI 直接写 REST 也不会落库。

---

## 4. 尚未完成 / 明确不在本次范围

- **Production Acceptance 未执行**——production 项目尚未建立。
- `AMAS-application-form.docx` 四语言版本**尚未升版**（需对齐 9 项目录、补入学习路径栏、删除 D-4/5/6 三节、标注文档版本）。不阻塞 PORTAL-1，但应在开放真实申请前完成。
- 课程学分表仍待甲方提供，67 门课程的 `credits` 保持 `null`，未自行推算。
- PORTAL-2 Student Core 未开始。按 P1/P4 决策，建档 RPC 必须先有 `hq_approval_status = approved` / `hq_approved_at` / `confirmed_by` 记录，学号规则参数化且不回收重用——将由 `0012` 起的迁移落地。

---

## 5. 复跑方式

```bash
# staging.env（含 URL / ANON / SERVICE / DBPW）只放在本机运行目录，绝不入库
psql "$PGURL" -f supabase/tests/portal1_acceptance.sql          # 23
node supabase/tests/portal1_http.mjs                            # 46
python -m http.server 8090 &                                    # UI 探针需要本地站点
node supabase/tests/portal1_ui.mjs                              # 28
node supabase/tests/program_catalog_consistency.mjs             #  6
```

UI 探针需临时把 `assets/js/supabase-config.js` 指向 staging，**跑完必须还原为空配置**。
