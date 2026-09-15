# 学员侧页面「读不到 ≠ 没有」盘点（T-013）

读者：Luna / Enos。分支 `csc/2026-09-14`，基于提交 `861ec4b`。只做盘点，**没有改页面**。

## 一、仓库里已有、可以复用的模式

| 编号 | 模式 | 已经在用的地方 |
|---|---|---|
| P1 | 主读取 `error` → `UI.error(main, { message: error.message, onRetry: reload })`，整页换成「载入失败 + 重试」 | 三个学员页的主读取、申请人资料页、申请人历史页 |
| P2 | 没有 `error` 但 `data` 不是数组 → 明说「这一次没读到」，并给刷新入口；空数组才说「没有」 | 申请人历史页列表（`!Array.isArray(rows)`） |
| P3 | 次要读取读不到时，只让**那一张卡**降级说明，页面其余部分照常显示 | 学员首页：`actsErr \|\| !Array.isArray(acts)`、`learnUnknown` |
| P4 | 单行对象要按契约判断「读到了」：必须是对象、不是数组、至少有一个字段非 null | 申请人资料页（T-009） |
| P5 | 用 node:vm 加桩运行页面内联脚本做边界检查：不开浏览器，几百毫秒跑完 | `scripts/test-applicant-profile-read-boundary.mjs`、`scripts/test-applicant-history-read-boundary.mjs` |

## 二、学员侧入口与现状

「实测」= 在草稿区用 node:vm 加桩实际运行页面脚本得到的结果；「读码」= 只读了源码，没有运行。

### portal/student/（学员中心）

| 读取 | error 时 | 无结论（无 error，data 为 null 或非数组）时 | 依据 |
|---|---|---|---|
| `my_student_record`（returns table） | P1 ✓ | 显示「**尚未查到你的学籍记录**」，把「读不到」说成「没有」✗ | 实测 |
| `my_student_timeline`（returns table） | error 被丢弃，`(tl \|\| [])` → `UI.timeline([])` 显示「**暂无记录**」✗ | 同左 ✗ | 读码（ui.js:110） |
| `program_catalog`（select） | error 被丢弃，修读项目显示「**待确认**」✗ | 同左 ✗ | 实测 |
| `my_action_items` | P3 ✓ | P3 ✓ | 已有探针 S1 |
| `my_learning` | P3 ✓ | P3 ✓ | 已有探针 S2 |
| `my_student_capabilities` | 首页没有用到这个结果 | — | 读码 |

### portal/student/courses/（课程目录）

| 读取 | error 时 | 无结论时 | 依据 |
|---|---|---|---|
| `my_learning`（returns table） | P1 ✓（已有探针 S6） | `data = null` → 「AMAS 正式课程共 **0** 门」「当前 0 门已有线上学习内容」✗ —— 与学员首页修掉的 S2 是同一个坑；`data = {}` → 抛 `list.filter is not a function`，页面**一直停在骨架屏** ✗ | 实测 |
| `my_student_capabilities` | error 被丢弃 → 不显示「学习入口在 App」那条说明，只是少一条提示 | 同左 | 读码 |

### portal/student/profile/（我的资料）

| 读取 | error 时 | 无结论时 | 依据 |
|---|---|---|---|
| `my_student_profile`（returns jsonb，查不到 profiles 行时服务端 raise） | P1 ✓ | `data = null` → 抛 `Cannot read properties of null (reading 'has_student_record')`，页面**一直停在骨架屏** ✗；`data = {}` → 渲染出空表单，学籍状态写「**尚无学籍记录**」✗ | 实测 |
| `program_catalog`（select） | error 被丢弃，修读项目显示「—」✗（轻微） | 同左 | 读码 |
| `update_my_contact`（写入） | 已按契约校验 `ok === true`；在途重复提交已防护（T-011） | — | 已有探针 |

注：`my_student_profile` 传 `{}` 时，实测还抛出了 `box.querySelector is not a function`。这是我草稿区里的桩没实现 `querySelector` 导致的，不算页面问题，不计入上表。

## 三、归纳

- 最严重的是两处：一处**卡在骨架屏**（courses 收到 `{}`、profile 收到 `null`），用户既看不到错误提示，也没有重试入口；另一处**说假话**（courses 显示「共 0 门」，首页显示「尚未查到学籍记录」「暂无记录」）。
- 次要读取的 error 被静默丢弃（首页的 timeline 和 program_catalog、profile 的 program_catalog），会显示成「暂无 / 待确认 / —」。适合用 P3 处理：只让那一格降级。
- 按契约，无结论的情形很少真实出现（returns table 经 PostgREST 返回的总是数组）。这些都是**防御性边界**，没有声称线上已经发生过。

## 四、有界候选任务（建议 1 条）

**候选：学员课程目录 `my_learning` 无结论时不说「共 0 门」、不卡骨架屏**

- 范围：只改 `portal/student/courses/index.html` 这一处读取，不动其他页面，不改共享层。
- 做法：复用 P2 / P3 —— `!Array.isArray(rows)` 时明说「这一次没能读到课程目录」并给重试入口，不渲染计数和筛选；空数组 `[]` 照旧显示「共 0 门」。
- 验收：
  1. 新增 `scripts/test-student-courses-read-boundary.mjs`（P5 模式），先写后修：`null`、`{}`、`undefined` 三种情形修前不符、修后退出码 0；`[]`、有记录、`error` 三种情形前后都符合；
  2. `node scripts/test-portal-pages.mjs` 的 S1~S6 仍然全部通过（其中 S5 空目录仍显示 0、S6 读失败仍给重试）；
  3. `./scripts/verify.sh` 退出码 0。
- 级别建议：GREEN（本地页面修复 + 测试，不涉及 Schema、依赖或权限）。

其余几处（profile 收到 `null` 卡骨架屏、首页 timeline / program_catalog 的 error 被吞、首页 `my_student_record` 无结论）建议之后各拆一条，不要和上面这条合并做。
