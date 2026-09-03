# PORTAL-2B · 学习数据只读审计

**日期**：2026-09-03
**范围**：为 PORTAL-2B（Student Experience & Learning Read Model）确定真实数据源
**方法**：只读检查两个代码库与 App 后端数据库实际内容，不做任何修改
**审计对象**：
- 官网 + 门户 `C:\Users\enosl\Desktop\AMAS-website`（Supabase）
- App `C:\Users\enosl\Desktop\amas---asian-missionary-theological-seminary`（Node + SQLite，今日仍在提交）
- 另有两份旧副本 `AMAS-Seminary` / `AMAS-Seminary-main`（2026-08-13，**Legacy，不作为任何数据源**）

---

## 结论摘要（先看这段）

**能立刻做的**：Student Profile、课程目录只读模型、pre_enrolled/active 能力区分、
待处理事项模型、不可逆记录登记规范。这些的数据源都在 Supabase 侧，已经真实存在。

**做不了的**：「正在学习 / 已完成 / 学习证据 / CP 画像摘要 / 推荐」。
不是因为难，而是因为**门户当前读不到任何真实数据**，原因有两条，任一条都足以阻断：

1. **两套身份系统之间没有任何关联**。门户用 Supabase Auth，App 用自己的
   `users` 表 + 自签 JWT，两边完全独立、无外键、无映射表、无共同标识。
   App 代码里 **`supabase` 零引用**（已全量 grep 确认）。
2. **App 后端没有部署**。`.env.local` 指向 `http://192.168.1.107:8787`（局域网开发机），
   仓库内无 fly/railway/render/vercel 配置，只有一个自托管 `Dockerfile`。
   GitHub Pages 上的门户无法访问该地址。

**而且目前也没有数据可读**：App 本地库里 `course_progress` **0 行**、`growth_state` **0 行**。
即使今天就打通身份与网络，读回来的也是空的。

因此本阶段按"只落地已有真实数据源的状态"执行：把能做的全部做完，
学习/CP 相关一律显示真实空态并说明原因，**不造第二份 course_progress，不伪造任何状态**。
需要甲方决策的只有一件事（见 §17），其余无争议部分直接实施。

---

## 1. 67 门课程的唯一数据源

| 位置 | 内容 | 是否权威 |
|---|---|---|
| **App `services/catalog.ts` → `OFFICIAL_CATALOG`** | 67 条，含稳定 id、中文名、分类、层级、讲师、totalLessons | **是。** 文件头自述"全 App 课程的唯一来源"，后端课程库、离线目录、分类页、首页统计均由此推导 |
| App SQLite `courses` 表 | 67 行，由上表播种 | 派生 |
| 官网 `index.html` | 67 张静态课程卡，显示用代码 `NT 01`…，**无机器可读 id** | 展示副本 |
| 官网 `assets/js/main.js` | `courseCards.N.title/body` 四语言文案，按**数组下标**索引 | 展示副本 |
| 门户 Supabase | **无课程表** | — |

**核对结果**：两侧各 67 门，标题 **66 门完全一致**，1 门存在命名漂移：

| 官网 | App |
|---|---|
| 世界观理解 | 世界观 |

这不是新增或删除课程，只是同一门课的名称在两处不一致。**不自行改名**——
按优先级阶梯，`OFFICIAL_CATALOG` 是课程的权威源，门户与读模型采用 App 的名称；
官网文案是否跟改，列为一条低风险确认项（§17 D-2B-2），不阻塞实施。

---

## 2. Course ID 稳定性

- App 使用语义化稳定 slug：`c_matthew`、`c_acts`、`c_1cor`、`c_greek`…
  已同时存在于 `catalog.ts` 与 SQLite `courses.id`，两边一致。
- **官网没有任何机器可读 ID**，课程卡靠 `courseCards.<数组下标>` 关联四语言文案。
  这是一个真实的脆弱点：**在课程列表中间插入或删除一门，会导致后面所有课程的文案整体错位**。
  本阶段不改官网结构，但门户读模型一律以 `c_*` slug 为准，并用一致性测试把两侧钉住。
- 有 2 个 id 带历史前缀（`c_dr_mark`、`c_dr_luke`），是迁移遗留命名，
  **不重命名**——id 是稳定标识，改名会破坏既有 `course_progress` 的外键语义。

---

## 3. 当前课程内容数据源

| 来源 | 内容 | 规模 |
|---|---|---|
| `catalog.ts` 的 `totalLessons` | 课时数；为 0 表示内容筹备中 | 67 门中 **21 门为 0** |
| `catalog.ts` 的 `availability` | `available` / `in_development`，默认由 totalLessons 推导 | 同上 |
| App SQLite `course_files` | 讲义文件（PDF 等） | **68 个文件，覆盖 44 门课** |
| `backend/uploads/` | 上述文件的实际存储 | 本地磁盘 |

课程内容**全部存放在 App 后端本地磁盘 + SQLite**，门户不可达。

`catalog.ts` 已经把两件事分得很清楚，这与 2B-2 的要求完全吻合，直接沿用其语义：

> `officialCatalog / approvalStatus` 说明「这门课属不属于学院」；
> `availability` 说明「现在有没有可学的内容」。67 门全部是正式课程，其中 21 门内容在筹备。

---

## 4. 当前课程访问权限来源

**结论：不存在任何按人授权的课程访问模型。**

- `GET /api/courses` —— **无需认证**，任何人可读全部 67 门目录。
- `GET/POST /api/courses/:id/progress` —— 只需 `requireAuth`，
  **任何已登录用户都能读写任意课程的进度**，没有"该用户是否有权学这门课"的判断。
- 全仓 grep `enrollment` / `enrolled` / `assignment`：**零命中**。
- `TrialCoursesView` 的"免费试听"是**客户端过滤**（`totalLessons > 0 && level === BTH`），
  不是服务端授权。
- `permissions.ts` 只管管理端能力（编辑课程、上传、发公告），与学生访问无关。

因此 2B-9 所说"不通过 `status=active` 自动假设所有 67 门都能学习"——
当前实际情况更彻底：**根本没有课程级访问权数据源**。
门户不得凭空发明一个，读模型只能诚实地表达"目录已列入 / 内容是否开放"。

---

## 5. 当前学习进度数据源

```sql
CREATE TABLE course_progress (
  user_id TEXT, course_id TEXT,
  progress INTEGER DEFAULT 0,          -- 0..100 百分比
  completed_lessons INTEGER DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (user_id, course_id)
);
```

- 位置：**App 后端 SQLite**，`user_id` 指向 App 自己的 `users` 表。
- 当前数据量：**0 行**。
- 粒度：课程级百分比，**没有逐课时记录**，没有观看位置、没有时间戳明细。
- 写入方式：客户端 `POST` 自报进度，服务端只做 `clampInt(0..100)` 范围钳制，
  **不校验是否真的学过**。也就是说这个数字目前是客户端声明值，不是可采信的学习证据。

---

## 6. 当前完成记录数据源

**不存在独立的完成记录表。** 没有 `completed_at`、没有完成事件、没有结业凭证。
"完成"目前只能由 `progress = 100` 推断，而该值如 §5 所述是客户端自报的。

按 2B-4「有真实 completion evidence 才出现"已完成"」的要求：
**当前没有任何可采信的完成证据**，因此门户不得渲染"已完成"分区。

---

## 7. 当前 Christian Profile 数据源

| 层 | 位置 | 说明 |
|---|---|---|
| 评估引擎 | App `services/christianProfile/{items,scoring,evidence,experiments,store}.ts` | **跑在客户端**；题库、计分、证据模型、验证实验全在前端 |
| 会话草稿 | 浏览器 `localStorage`（`amas_cp_session_v1`） | 每题自动保存，用于续答 |
| 画像文档 | `localStorage` `amas_ct_state_v2` → 经 `growthSyncService` 同步 | 前端拥有 merge 语义 |
| 跨设备存储 | App 后端 `growth_state(user_id, state_json, updated_at)` | 一人一份 JSON，`PUT/GET /api/growth/state`，需 App JWT |
| 当前数据量 | **0 行** | |

官网 `discover.html` 是 **Level 0 快速探索**，明确不输出事奉类型，
除 `amas_discover_src` 外**不持久化任何结果**——它不是 CP 的数据源。

`evidence.ts` 的铁律与 2B-5/2B-7 完全一致，原文照录：

> 任何证据都**不会**直接改动倾向指数；指数只有重新评估才更新；
> 证据只影响「证据可信度」与「冲突提示」；导师反馈独立保存，不覆盖用户原始作答。

---

## 8. 当前 Recommendation 数据源

`scoring.ts` 的 `buildRecommendations(topOrientations, faithFoundation, ministryReadiness)`
在**评估完成的同一次客户端计算中**产生，随画像一起存进 `growth_state` 的 JSON。

- 没有独立的 recommendation 表，没有服务端推荐引擎。
- `experiments.ts` 已区分来源：`profile_recommendation` / `mentor_assigned` / `self_selected`，
  这与 2B-4「推荐 ≠ 已选课程」的语义要求一致。
- 无画像即无推荐。当前 0 份画像 → **0 条推荐**。

---

## 9. 当前 Evidence 数据源

`evidence.ts` 定义了 12 种 `EvidenceType`（8 种当前可产生、4 种预留），
含 `course_completion` / `learning_performance` / `ministry_practice` / `mentor_feedback` 等，
带 `targetOrientations`、`polarity`（支持/中性/反驳）、`strength`。

**模型是完整的，但没有任何持久化的证据实例**：证据数组嵌在 `growth_state` 的 JSON 里，
而 `growth_state` 当前 0 行。没有独立 evidence 表，没有服务端校验。

对 2B-7 的意义：证据模型**已经存在且设计正确，不需要门户重新定义**。
门户当前唯一正确的做法是——什么都不建，等身份打通后读它。

---

## 10. Legacy / placeholder 数据

| 项 | 判定 |
|---|---|
| `AMAS-Seminary`、`AMAS-Seminary-main` 两份桌面副本 | **Legacy**（2026-08-13 停更）。不得作为任何数据源 |
| `growth_state` 内的九维 / 恩赐旧数据 | 代码注释已标 `legacy`，保留但不参与新逻辑 |
| `backend/data/amas.backup-before-catalog-*.sqlite` | 课程目录改版前的备份，非活动数据 |
| `recovered_from_simulator/`（旧副本内） | 恢复产物，非数据源 |
| App `users` 表 7 个账号，全部 role=student | **本地开发测试账号**，非真实学生 |
| `course_progress` / `growth_state` | 0 行，**不是"数据还没同步"，是从来没有过真实数据** |

---

## 11. Portal 与 App 是否存在重复模型

| 概念 | 门户（Supabase） | App（SQLite） | 是否重复 |
|---|---|---|---|
| 身份 | `auth.users` + `profiles` + `user_roles`（9 角色、RLS、MFA/aal2） | `users`（role 仅 student/admin）+ 自签 JWT | **是——两套完全独立的身份系统，无任何关联** |
| 学籍 | `student_records`（生命周期 / 学号 / HQ 审核） | 无 | 否 |
| 招生 | `applications` 全套 | 无 | 否 |
| 招生项目 | `program_catalog`（9 项，权威） | 无 | 否 |
| 课程目录 | **无** | `OFFICIAL_CATALOG` + `courses`（权威） | 否 |
| 学习进度 | 无 | `course_progress` | 否 |
| Christian Profile | 无 | `growth_state` + 客户端引擎 | 否 |

**唯一的重复是身份**，而且是最要命的那个重复：同一个人在两边是两个互不相识的账号。

---

## 12. 拟建立的 read model

### 12.1 现在就做

**`course_catalog`（Supabase，只读镜像）**
以 `OFFICIAL_CATALOG` 为权威源播种到 Supabase，字段：
`code`（= App 的 `c_*` slug）、`title_zh`、`category`、`level`、`total_lessons`、
`availability`、`credits`（**一律 null**）、`sort_order`。

理由与 `program_catalog`（D-2）完全同构：官网与 App 已各有一份，
门户再 hard-code 第三份是明确禁止的；镜像 + 一致性测试把三处钉在一起，
任一侧漂移，测试立刻失败。**这是镜像，不是新的权威源**——改课程仍然只能改 `catalog.ts`。

**`v_my_learning`（RPC，读模型 / adapter）**
返回学生视角的课程状态，当前只能诚实返回两种：

| 状态 | 判据 | 当前可产生 |
|---|---|---|
| `catalogued` | 在 67 门目录内 | ✅ 全部 67 门 |
| `content_pending` | `availability = in_development` | ✅ 21 门 |
| `accessible` | 有课程级访问授权 | ❌ 无数据源（§4） |
| `recommended` | 来自 CP 推荐 | ❌ 无数据源（§8） |
| `assigned` | 导师/教务指派 | ❌ 概念不存在（§4） |
| `in_progress` | 真实进度 | ❌ 门户不可达且 0 行（§5） |
| `completed` | 可采信的完成证据 | ❌ 不存在（§6） |

**后五种一律不落地**，等 §17 的决策落定、身份打通后再由同一个 adapter 补充——
adapter 的形状现在就定好，将来只加数据源，不改门户页面。

**`my_action_items()`（RPC，派生而非存储）**
按 2B-8 的字段要求返回 `source_type / source_id / reason / target_url / status`，
但**从真实状态计算得出，不建通知表**——避免"一堆硬编码文案"，也避免假通知。
当前可产生的真实事项：资料未完善、学籍状态变化待查看、待正式注册说明、CP 尚未建立。

### 12.2 现在不做

学习进度、完成、证据、推荐、CP 摘要的**存储与写入**一概不建。
门户侧只保留 adapter 的读接口形状，数据源接通前返回真实空态。

---

## 13. 拟修改文件

| 文件 | 动作 |
|---|---|
| `supabase/migrations/0016_course_catalog.sql` | 新增课程目录镜像 + RLS + 一致性所需字段 |
| `supabase/migrations/0017_student_experience.sql` | `my_student_profile()`、`update_my_contact()`、`my_learning()`、`my_action_items()`、能力门禁 |
| `supabase/migrations/0018_irreversible_registry.sql` | 2B-11 正式接口规范 + 自动化 guard |
| `portal/student/index.html` | Dashboard 升级：当前行动、我的学习、CP 入口 |
| `portal/student/profile/index.html` | 新增：本人可改 vs 教务维护，明确标注 |
| `portal/student/courses/index.html` | 新增：课程目录只读视图 |
| `assets/js/portal/shell.js` | 学员导航补齐已真实存在的页面 |
| `supabase/tests/portal2b_*.{sql,mjs}` | 三层验收 |
| `docs/operations/engineering-security-rules.md` | 追加 R-8 迁移清单强制项 |

---

## 14. Migration 需求

- `0016` 课程目录镜像（67 行，credits 全 null，`code` 为 App slug）
- `0017` 学生体验读模型（profile / learning / action items / 能力门禁）
- `0018` 不可逆记录登记规范（把 `student_number_has_irreversible_records` 升级为强制接口）

三个迁移都**不引入**任何学分、成绩、选课、GPA、毕业、财务字段。

---

## 15. Acceptance matrix

| 层 | 覆盖 |
|---|---|
| DB | 目录 67 门且 credits 全 null；本人可改字段与教务字段分离；学号/状态/项目不可自改；HQ approval 不可自改；pre_enrolled 与 active 能力差异；action items 只由真实状态派生 |
| REST/RPC/Edge | 2B-10 的 13 项攻击测试；推荐不得形成 enrollment；completed 不可由客户端 PATCH；直接写 learning evidence 被拒；撤销 student 角色后旧 JWT 即时失权；**同事务逃逸测试** |
| Browser | 学生资料页正确区分可改/只读并标注"由教务维护"；课程页对 21 门筹备中课程显示真实说明且无空播放器；`credits=null` 不显示 0；无进度时不出现"正在学习/已完成"；首页当前行动最多 1+1+1；390px 无溢出；console 0 错误 |
| 一致性 | Supabase 课程镜像 ↔ App `OFFICIAL_CATALOG` ↔ 官网课程卡三方一致 |
| 回归 | PORTAL-1 与 PORTAL-2 全量重跑 |

---

## 16. 回滚方案

- 三个迁移均为**纯新增**（新表 + 新函数），不改动 0001–0015 的任何既有对象。
- 回滚 = 反向迁移 `drop function` / `drop table course_catalog` 即可，
  `applications`、`student_records`、`student_number_registry` 不受影响。
- 新增页面为独立文件；导航项可单独摘除，摘除后门户回到 PORTAL-2 Phase 1 形态。
- 前端无构建步骤，`git revert` 单个 commit 即可完全回退。
- 课程目录镜像若与 App 漂移，一致性测试会先失败，不会静默带病上线。

---

## 17. Decision Required

只有一条，且是架构/政策层面的，不是实现细节。

### D-2B-1｜门户与 App 的身份与数据打通方式（阻断 2B-3/4/5/7 的真实数据）

门户（Supabase）与 App（Node+SQLite）是两套独立身份系统，App 后端未部署、
学习与 CP 数据均为 0 行。在这件事定下来之前，门户无法读取任何真实学习数据。

可选路径（各有明确代价，需要甲方选）：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. App 迁移到 Supabase Auth** | App 改用 Supabase 登录，`course_progress` / `growth_state` 迁入 Supabase | 一次性改造 App 认证层与数据迁移；此后单一身份、单一权限模型，门户直接读，长期最干净 |
| **B. 账号绑定 + 后端部署** | 部署 App 后端；建立 Supabase ↔ App 账号绑定表；门户经服务端 adapter 拉取 | 保留两套身份，需维护绑定与令牌交换；两套权限模型长期并存，安全面更大 |
| **C. 暂不打通** | 门户学习区维持真实空态，专注学籍与资料能力 | 无额外成本；学生在门户看不到学习进度，须回 App |

**我的建议是 A**，理由：目前 `course_progress` 与 `growth_state` **都是 0 行**，
现在迁移的数据成本几乎为零；而每晚一步，需要迁移和对账的数据只会更多。
同时 App 现有身份模型只有 student/admin 两级，安全能力（RLS、MFA/aal2、
角色撤销即时失权、审计）全都在 Supabase 侧已经验收过——合并方向本来也应该是往这边收。

**在此决策做出之前，PORTAL-2B 按 C 的形态实施**：把不依赖该决策的部分全部做完，
学习与 CP 区显示真实空态并说明"学习记录目前保存在「AMAS 神学院」App 中"。

### D-2B-2｜一门课的命名漂移（低风险，确认即可）

官网作「世界观理解」，App 目录作「世界观」。同一门课，非新增非删除。
读模型按权威源采用 App 的「世界观」；官网文案是否同步修改，请确认。
**未确认前不动官网**——改课程名称属于需要批准的动作。
