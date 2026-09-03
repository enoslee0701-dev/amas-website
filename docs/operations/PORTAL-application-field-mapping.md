# PORTAL-1 · 正式申请表字段映射（Source of Truth = AMAS 正式完整版入学申请表）

**日期**：2026-09-03
**Source of Truth**：`assets/files/AMAS-application-form.docx`（中文正式版，四语言同构）
**次级来源（仅用于预填，不得据此删减正式字段）**：官网 Quick Apply（`index.html` 申请弹窗）
**原则**：官网已有字段自动预填正式申请；**官网没有的正式字段一律保留**。与手册/规范冲突的字段**停止实现并列入 Decision Required**（§4），不自行解释政策。

## 图例

- **必填**：R = Required，O = Optional，—— = 未定（见 Decision Required）
- **可改阶段**：`draft` / `needs_info`（管理员要求补充时解锁）/ `never`（提交后永久锁定）
- **敏感级别**：S1 一般联系信息 · S2 信仰与教会关系 · **S3 特殊类别（健康/第三方个人信息/可能涉政治身份）**
- **入 student record**：建档时是否复制进 `student_profiles`（其余仅留在申请域）

---

## 1. 申请修读项目

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record | 备注 |
|---|---|---|---|---|---|---|---|---|
| 申请修读项目（**可多选**：B.Th / G.Dip / M.Div / D.Min·D.Miss / 牧会者进修 / 讲道学校 / 宣教士训练） | `program`（单选，9 项含平信徒指导者、牧会训练课程） | `form_data.programs text[]` | R | draft | **锁定** | S1 | ✓（主项目） | **冲突 D-1、D-2**：正式表为多选且缺 2 个新增项目 |
| 学习路径（正式学籍 / 共同学习） | 无 | `applications.pathway` | R | draft | 锁定 | S1 | ✓ | 手册两条路径；**冲突 D-3**：正式表无此栏 |

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
| 教会类型（三自/家庭/其他） | `churchType` | `form_data.church_type` | —— | —— | —— | **S3** | ✗ | **冲突 D-4：暂停实现** |
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
| 关系 / 姓名 / 出生年月 / 信仰 | 无 | `form_data.family jsonb[]` | —— | —— | —— | **S3** | ✗ | **冲突 D-5：暂停实现** |

## 7. 其他事项

| 正式表字段 | Quick Apply | 数据库 | 必填 | 可改阶段 | accepted 后 | 敏感 | 入 student record |
|---|---|---|---|---|---|---|---|
| 健康状况 | 无 | `form_data.health` | —— | —— | —— | **S3** | ✗ | **冲突 D-6：暂停实现** |
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

## 12. Decision Required（冲突项，**V1 暂停实现**）

| 编号 | 冲突 | 双方依据 | 需要的决定 |
|---|---|---|---|
| **D-1** | 正式表「申请修读项目」为**多选**；官网与数据模型按**单一项目**处理 | 正式表勾选框 vs 现行申请弹窗单选 | 正式申请是否允许同时申请多个项目？（影响 §唯一活动申请约束） |
| **D-2** | 正式表项目清单**缺少**现行官网已上线的「平信徒指导者课程」「牧会训练课程」，且未含已删除的 AB.Th | 正式表 vs 官网现行 9 项目 | 以哪份为准？正式表是否需更新版次？ |
| **D-3** | 正式表**无「学习路径（正式学籍 / 共同学习）」栏**，但手册 V2.0 将其定为核心分流 | 正式表 vs 手册 V2.0 §四 | 申请时是否必须选择路径？还是由招生同工在审核阶段判定？ |
| **D-4** | 「教会类型（三自 / 家庭 / 其他）」属可能涉及政治身份的高敏感信息；开发总规范 §17.1 禁止默认收集「不必要的政治或身份信息」 | 正式表 vs 规范 §17.1 | 是否在线上系统收集？若收集，是否加密/限管理员可见/缩短保留期？ |
| **D-5** | 「家庭状况（第三方姓名/出生/信仰）」= 第三方个人信息；规范 §17.1 禁止默认收集「家庭成员隐私」 | 正式表 vs 规范 §17.1 | 是否线上收集？还是仅纸质/面谈阶段？ |
| **D-6** | 「健康状况」属特殊类别个人数据；规范 §17.1 禁止默认收集「详细医疗记录」 | 正式表 vs 规范 §17.1 | 是否线上收集？若收集，字段是否改为「是否有影响学习的健康状况：是/否 + 可选说明」？ |

**V1 处理方式**：D-1 按单一主项目实现（`programs[]` 结构已可扩展多选）；D-2 项目选项**沿用官网现行 9 项**（避免申请人看到已下线/缺失项目）并标注待正式表更新；D-3 路径栏**保留并必填**（手册为准）；**D-4 / D-5 / D-6 三组字段在 V1 完全不实现**——表单不出现、数据库不建字段、不做隐藏占位，待决定后由 PORTAL-1b 增补。
