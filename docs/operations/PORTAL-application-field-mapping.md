# PORTAL-1 · 正式申请表字段映射

**日期**：2026-09-03 · **状态**：D-1～D-6 全部 RESOLVED（决策见 §12）

## 招生字段优先级阶梯（Source of Truth）

以下顺序自上而下裁决冲突。**不存在「Word 申请表无条件是最高 Source of Truth」这回事**——纸质表落后于政策时，以政策与目录为准，并把表升版。

| 级别 | 来源 | 说明 |
|---|---|---|
| 1 | **当前明确批准的招生政策 / 当前决策** | 本文件 §12 的 D-x 决策、开发总规范 §17.1 隐私红线 |
| 2 | **Admissions Schema / 当前正式项目目录** | `supabase/migrations/0010_program_catalog.sql` 中的 `program_catalog` 表（唯一权威项目清单） |
| 3 | **最新正式申请表** | `assets/files/AMAS-application-form.docx`（须升版至与级别 2 一致） |
| 4 | **官网 Quick Apply** | `index.html` 申请弹窗——仅用于预填，不得据此删减正式字段 |
| 5 | **Legacy 表单 / 历史版本** | 仅作历史参考，不构成实现依据 |

**实现原则**：官网已有字段自动预填正式申请；官网没有的正式字段一律保留；与级别 1／2 冲突的字段按 §12 决策执行，不自行解释政策。

## 图例

- **必填**：R = Required，O = Optional，—— = 未定（见 Decision Required）
- **可改阶段**：`draft` / `needs_info`（提交后锁定，但审核员在补件条目上指定 `field` 时**按字段精确解锁**，重新提交后再次锁定——见 `0011_requirement_field_unlock.sql`）/ `never`
- **敏感级别**：S1 一般联系信息 · S2 信仰与教会关系 · **S3 特殊类别（健康/第三方个人信息/可能涉政治身份）**
- **入 student record**：建档时是否复制进 `student_profiles`（其余仅留在申请域）

---

## 1. 申请修读项目

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record | 备注 |
|---|---|---|---|---|---|---|---|---|
| 申请修读项目（**可多选**：B.Th / G.Dip / M.Div / D.Min·D.Miss / 牧会者进修 / 讲道学校 / 宣教士训练） | `program`（单选，9 项含平信徒指导者、牧会训练课程） | `form_data.programs text[]` | R | draft | **锁定** | S1 | ✓（主项目） | **D-1/D-2 RESOLVED**：单一主项目，选项来自 `program_catalog`（9 项） |
| 学习路径（正式学籍 / 共同学习） | 无 | `applications.pathway` | R | draft | 锁定 | S1 | ✓ | 手册两条路径；**D-3 RESOLVED**：保留并必填，正式表待补此栏 |

## 2. 个人资料

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record |
|---|---|---|---|---|---|---|---|
| 中文姓名 | `nameZh` | `form_data.name_zh` | R | draft | **锁定** | S1 | ✓ |
| 英文姓名 | `nameEn` | `form_data.name_en` | O | draft, needs_info | 锁定 | S1 | ✓ |
| 性别 | `gender` | `form_data.gender` | R | draft | 锁定 | S1 | ✗ |
| 出生年月 | `birth` | `form_data.birth_ym` | R | draft | **锁定** | S1 | ✓ |
| 国籍 | `nationality` | `form_data.nationality` | R | draft | 锁定 | S1 | ✗ |
| 使用语言（普通话/广东话/其他） | `language` | `form_data.languages text[]` + `language_other` | R | draft, needs_info | 可改 | S1 | ✓（locale） |
| 现居地址 | `location`（仅城市） | `form_data.address` | R | draft, needs_info | 可改 | S1 | ✗ |
| 手机 | `phone` | `form_data.phone` | R | draft, needs_info | 可改 | S1 | ✓ |
| 固定电话 | 无 | `form_data.tel` | O | draft, needs_info | 可改 | S1 | ✗ |
| Email / QQ | `email` | `form_data.email_alt` | O | draft, needs_info | 可改 | S1 | ✗ |
| 微信 / Line | 无（官网另有联系方式栏） | `form_data.im_contact` | O | draft, needs_info | 可改 | S1 | ✗ |

> 账号邮箱来自 `auth.users`，**不在表单内编辑**（SEC-1：邮箱变更须走 Auth 流程）。

## 3. 教会资料

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record |
|---|---|---|---|---|---|---|---|
| 教会名称 | `church` | `form_data.church_name` | R | draft, needs_info | 可改 | S2 | ✗ |
| 教会类型（三自/家庭/其他） | `churchType` | `form_data.church_type` | —— | —— | —— | **S3** | ✗ | **D-4 RESOLVED：不收集**（服务端剥离） |
| 教会电话 | 无 | `form_data.church_phone` | O | draft, needs_info | 可改 | S2 | ✗ |
| 目前服事 | `role` | `form_data.church_role` | R | draft, needs_info | 可改 | S2 | ✗ |
| 初信日期 | `conversion` | `form_data.conversion_date` | R | draft, needs_info | 锁定 | S2 | ✗ |
| 受洗日期 | `baptism` | `form_data.baptism_date` | O | draft, needs_info | 锁定 | S2 | ✗ |

## 4. 学历（多行表格）

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record |
|---|---|---|---|---|---|---|---|
| 学校 / 城市 / 入学日期 / 毕业日期 / 学位或文凭 | `eduLevel`、`eduSchool`（各一项） | `form_data.education jsonb[]`（每项：`school, city, start_ym, end_ym, degree`） | R（≥1 行） | draft, needs_info | 锁定 | S1 | ✗ |

## 5. 工作 / 事奉简历（多行表格）

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record |
|---|---|---|---|---|---|---|---|
| 教会或机构名 / 城市 / 开始日期 / 离职日期 / 职位 | 无 | `form_data.experience jsonb[]`（每项：`org, city, start_ym, end_ym, position`） | O | draft, needs_info | 可改 | S2 | ✗ |

## 6. 家庭状况（多行表格）

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record |
|---|---|---|---|---|---|---|---|
| 关系 / 姓名 / 出生年月 / 信仰 | 无 | `form_data.family jsonb[]` | —— | —— | —— | **S3** | ✗ | **D-5 RESOLVED：不收集**（服务端剥离） |

## 7. 其他事项

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record |
|---|---|---|---|---|---|---|---|
| 健康状况 | 无 | `form_data.health` | —— | —— | —— | **S3** | ✗ | **D-6 RESOLVED：不收集**（服务端剥离） |
| 性格 | 无 | `form_data.personality` | O | draft, needs_info | 可改 | S1 | ✗ |
| 恩赐 | `gifts` | `form_data.gifts` | O | draft, needs_info | 可改 | S2 | ✗ |
| 异象 / 蒙召 | `motivation` | `form_data.calling` | R | draft, needs_info | 可改 | S2 | ✗ |
| 介绍人及电话 | `referrer` | `form_data.referrer` | O | draft, needs_info | 可改 | S1 | ✗ |

## 8. 自我介绍及信仰见证

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record |
|---|---|---|---|---|---|---|---|
| 自我介绍及信仰见证（长文本，可另附页） | 无 | `form_data.testimony`（≤5000 字） | R | draft, needs_info | 可改 | S2 | ✗ |
| 「可另附页」附件 | 无 | —— | —— | —— | —— | —— | ✗ | **Documents Center 暂不做**：V1 提供纯文本框，不做上传 |

## 9. 声明与签署

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record |
|---|---|---|---|---|---|---|---|
| 「本人确认资料真实无误…」勾选 | `consent` | `form_data.declaration_accepted` + `declared_at` | R | 提交时 | 锁定 | S1 | ✗ |
| 申请人签署 / 日期（纸质签名） | 无 | 由提交动作与 `submitted_at` 等价替代 | —— | —— | —— | —— | ✗ | 电子提交即视为签署（与手册"在线申请为快速通道"一致） |

---

## 10. 仅招生阶段使用（不进入 student record）

除表中标 ✓ 的字段外，其余全部**仅存于申请域**：教会资料、学历、事奉简历、其他事项、见证、内部备注与时间线。建档时只复制姓名、出生年月、语言、手机、主项目、路径至 `student_profiles`/`profiles`。

---

## 11. Quick Apply → 正式申请 预填映射（自动，可覆盖）

`nameZh→name_zh` · `nameEn→name_en` · `gender→gender` · `birth→birth_ym` · `nationality→nationality` · `language→languages[]` · `phone→phone` · `location→address(城市部分)` · `church→church_name` · `role→church_role` · `conversion→conversion_date` · `baptism→baptism_date` · `eduLevel+eduSchool→education[0]` · `program→programs[]` · `gifts→gifts` · `motivation→calling` · `referrer→referrer`

预填仅作草稿初值，申请人可全部修改；**官网无对应项的正式字段留空待填，不得删除**。

---

## 12. 招生字段决策 D-1 ～ D-6（全部 RESOLVED · 2026-09-03 拍板）

| 编号 | 议题 | **决策** | 实现落点 |
|---|---|---|---|
| **D-1** | 一份申请可否同时申请多个项目 | **RESOLVED — 一份 application = 一个主项目。** V1 只收一个项目；`form_data.programs` 保留数组结构以便日后扩展多选，但服务端强制长度为 1 | `0010_program_catalog.sql` → `application_validate_program()`；表单 S1 单选 |
| **D-2** | 项目清单以哪份为准 | **RESOLVED — 以 `program_catalog` 表为唯一权威清单（9 个项目）。** `AMAS-application-form.docx` 已落后，需升版对齐；**不允许**官网、Portal、Word 表三处各自维护 hard-coded 项目列表。课程与项目是不同概念，67 门课程目录不得混入招生项目目录 | `0010_program_catalog.sql`（表 + 种子 + 校验）；前端一律从该表读取 |
| **D-3** | 是否保留「学习路径」栏 | **RESOLVED — 保留并必填**（正式学籍 / 共同学习 / 未选择），沿用既有实现决定。正式表需补入此栏 | `applications.pathway`；表单 S1 |
| **D-4** | 是否收集「教会类型（三自/家庭/其他）」 | **RESOLVED — V1 不收集。** 表单不出现 / DB 不建字段 / 不做隐藏占位 / 不进入审核条件 / 不从其他字段推断 | `0010` → `application_strip_forbidden` 触发器服务端剥离 `church_type` |
| **D-5** | 是否收集详细家庭成员资料 | **RESOLVED — V1 不收集**家庭成员隐私（第三方姓名/出生/信仰）。约束同 D-4 | 同上，剥离 `family` / `family_members` / `spouse` / `children` |
| **D-6** | 是否收集健康 / 医疗资料 | **RESOLVED — V1 不收集**详细健康或医疗资料。约束同 D-4 | 同上，剥离 `health` / `health_status` / `medical` / `diagnosis` |

### D-4 / D-5 / D-6 的执行力度

这三项**不是靠前端不渲染来实现的**。`application_strip_forbidden` 触发器在 `applications` 的 insert/update 上服务端剥离上述 key，因此即便有人绕过 UI 直接调用 REST/RPC 写入，这些字段也不会落库。验收覆盖见 `supabase/tests/portal1_http.mjs`（P1-H08～H10）。

若日后确需恢复其中任一项，须先有明确的招生政策决定与隐私说明，再新增 migration；不得以「先建字段留着备用」的方式提前落地。

### 待办（不阻塞 PORTAL-1 验收）

- `assets/files/AMAS-application-form.docx` 四语言版本升版：项目清单对齐 `program_catalog` 的 9 项、补入「学习路径」栏、删除教会类型/家庭状况/健康状况三节，并在页脚标注文档版本与生效日期。
