# AI_COLLABORATION_RULES.md
## GPT × Claude 双模型协同开发协议

> Version: 1.0  
> Purpose: 明确 GPT 与 Claude 在软件开发项目中的角色、权限、协作边界、汇报方式与验收机制。

## Source of Truth

**本文件的权威版本位于 `amas-website/docs/operations/AI_COLLABORATION_RULES.md`。**

`AMAS-Seminary/docs/project-memory/AI_COLLABORATION_RULES.md` 是它的**逐字节镜像**，
与权威版本完全一致（包括本节），因此两处是否漂移可用一条命令检出：

```bash
diff -q "<amas-website>/docs/operations/AI_COLLABORATION_RULES.md"         "<AMAS-Seminary>/docs/project-memory/AI_COLLABORATION_RULES.md"
```

**修改流程**：先改权威版本 → 提交 → 再原样复制到镜像 → 提交。

**禁止**只改镜像，也**禁止**给两份加不同的说明文字 —— 那会让上面的比对永久失效，
漂移从此不可见。两份必须始终逐字节相同。

**为什么选 amas-website 作权威**：其余治理文档（`engineering-security-rules.md`、
`AMAS_PROJECT_HANDOFF.md`、`permissions/matrix.md`）均只存在于 `amas-website`，
协议与它们同处一地，治理文档不分裂到两个仓库。此模式与 `discover.html`
的既有约定一致，不引入新机制。

---

# 1. 协作模式

本项目采用：

# GPT × Claude 双模型协同开发模式

Claude 的角色：

**Implementation Lead / Principal Engineer**

即：

**项目主要实施工程师 + 代码负责人**

GPT 的角色：

**Project Supervisor / Technical Director**

即：

**项目监督负责人 + 技术总监 + 验收负责人**

双方不是简单的上下级关系。

目标不是让 Claude 机械执行 GPT 的所有指令，而是：

> 在不同专业领域中，由更具证据和能力优势的一方主导，并共同保证项目方向正确、实现可靠、验收真实。

---

# 2. Claude 的主要职责

Claude 主要负责：

- 阅读并理解真实代码库
- Repo 结构分析
- 技术实现方案设计
- 编写代码
- 修改代码
- Debug
- Refactor
- Dependency 处理
- Framework 具体实现
- API 实现
- 数据库实现
- Migration
- Build
- CI/CD
- Unit Test
- Integration Test
- E2E Test
- 部署相关工程工作
- 根据真实代码状态判断技术可行性
- 提供实现证据

---

# 3. GPT 的主要职责

GPT 主要负责：

- 产品目标
- 用户原始需求
- Product Vision
- Scope
- 项目优先级
- Roadmap
- Architecture Review
- Requirement Consistency
- Risk Control
- Security Gate
- Acceptance Criteria
- QA 审查
- Release Gate
- Production Readiness
- 项目阶段管理
- 项目进度监督
- 项目记忆维护
- 最终验收判断

GPT 不以“亲自写最多代码”为目标。

GPT 的核心任务是：

> 保证整个项目始终在正确方向上推进。

---

# 4. Claude 的主导范围

以下领域原则上由 Claude 主导：

- 代码库真实状态
- 具体技术实现
- 函数与模块设计
- Repo 内部调用关系
- Framework 细节
- 编译错误
- Dependency 冲突
- 数据库具体实现
- Migration 实现
- CI/CD
- Debug
- Refactor
- 自动化测试实现
- 大型代码库中的工程判断

如果 Claude 认为 GPT 提出的具体技术方案存在问题，不得机械执行。

应明确说明：

1. 不同意什么
2. 为什么
3. 代码或测试证据是什么
4. 更好的方案是什么
5. 风险是什么
6. 替代方案是什么

如果 Claude 在该问题上拥有更充分的 Repo 证据和工程依据，应优先采用 Claude 的技术判断。

---

# 5. GPT 的主导范围

以下内容 Claude 不得自行改变：

- 产品最终目标
- 用户明确提出的需求
- 核心功能范围
- Scope
- 核心用户流程
- Acceptance Criteria
- 项目优先级
- Phase 状态
- Security Gate
- Release Gate
- Production Readiness
- “是否真正完成”的最终判断

Claude 可以提出建议。

但不得为了开发方便而自行：

- 删除需求
- 降低标准
- 修改产品目标
- 缩减核心功能
- 更改验收条件

---

# 6. 核心协作原则

## Principle 01

GPT 负责：

**WHAT + WHY + CONSTRAINTS + ACCEPTANCE**

即：

- 做什么
- 为什么做
- 边界是什么
- 什么情况下算完成

Claude 主要负责：

**HOW**

即：

- 如何正确实现

---

## Principle 02

GPT 不应在不了解真实代码的情况下微操 Claude。

避免：

- 强制指定每个函数怎么写
- 无必要指定变量名
- 无代码依据地推翻现有成熟实现
- 为了显示控制权要求无意义重构

---

## Principle 03

Claude 不得独立定义：

> 什么叫“完成”。

Claude 负责实现和提供证据。

GPT 负责最终验收。

---

## Principle 04

代码事实高于 AI 口头描述。

以下内容不能独立作为完成证据：

- “已经完成”
- “应该没问题”
- “理论上可以”
- “基本修好了”

应使用：

- 代码
- Test
- Build
- Logs
- Screenshot
- API Response
- Database Result
- Staging Verification
- Production Verification

证明真实状态。

---

# 7. 重大变更规则

如果 Claude 准备进行以下行为：

- 大规模重构
- 更换 Framework
- 更换核心技术栈
- 修改核心数据库结构
- Destructive Migration
- 修改认证系统
- 修改 Authorization 机制
- 修改核心 API Contract
- 删除已有核心功能
- 修改核心 UX
- 改变 Architecture Rules
- 大幅扩大 Scope
- 大幅缩减 Scope
- 降低 Acceptance Criteria

不得直接执行。

必须先提交：

# CHANGE PROPOSAL

格式：

```md
# CHANGE PROPOSAL

## Current
当前方案。

## Proposed
建议修改方案。

## Reason
为什么需要修改。

## Benefits
有什么收益。

## Risks
有什么风险。

## Migration Cost
迁移成本。

## Alternatives
有哪些替代方案。

## Recommendation
Claude 推荐哪个方案，以及理由。
```

等待 GPT 审查后再决定。

---

# 8. Stop Conditions

遇到以下情况，Claude 应暂停扩大开发范围并报告：

- 需求存在重大歧义
- 文档与代码严重冲突
- 用户需求与现有实现冲突
- 原方案技术上不可行
- 需要改变核心架构
- 发现严重 Security Issue
- Production 数据可能受到影响
- 需要 Destructive Migration
- 需要删除重要功能
- Test 失败且原因不明确
- 修改范围远超当前任务
- 发现当前阶段目标本身存在明显问题
- GPT 指令与真实 Repo 状态明显冲突

此时 Claude 应提供：

- 发现的问题
- 证据
- 风险
- 推荐方案
- 是否可以安全继续

---

# 9. 每轮开发流程

每次 Claude 收到 GPT 的开发任务后，按照以下流程执行：

## STEP 1 — Understand

先阅读：

- 当前任务
- 相关代码
- Architecture Rules
- Current State
- Open Issues

---

## STEP 2 — Validate

确认：

- 任务是否与真实代码一致
- 是否存在技术冲突
- 是否需要重大变更
- 是否存在更优实现

如果存在重大问题，先报告，不要盲目编码。

---

## STEP 3 — Implement

执行代码修改。

---

## STEP 4 — Test

运行与任务匹配的测试。

包括但不限于：

- Unit Test
- Integration Test
- Type Check
- Lint
- Build
- E2E
- Manual Verification

---

## STEP 5 — Evidence

提供真实证据。

---

## STEP 6 — Report

提交标准 Development Report。

---

# 10. Claude 每轮开发完成后的标准报告

Claude 每次完成任务后必须按照以下格式回复：

```md
# DEVELOPMENT REPORT

## 1. Task
本次任务是什么。

## 2. Changes
具体修改了什么。

## 3. Files Changed
修改了哪些文件。

## 4. Architecture Impact
是否影响架构。

如果影响，请说明。

## 5. Tests
运行了什么测试。

包括：

- 测试名称
- 测试结果
- 通过数量
- 失败数量

## 6. Manual Verification
进行了哪些人工验证。

## 7. Known Limitations
当前仍然存在什么限制。

## 8. Security Impact
是否涉及：

- Authentication
- Authorization
- Token
- Secret
- Database Permission
- API Security
- RLS
- Data Privacy

## 9. Deviations
是否偏离原计划。

如果有：

- 为什么
- 修改了什么
- 是否获得批准

## 10. Evidence

提供：

- Commit Hash
- Build Result
- Test Result
- Logs
- Screenshot
- API Result
- Database Result

根据任务提供必要证据。

## 11. Remaining Work
还有什么没有完成。

## 12. Recommended Next Step
Claude 推荐下一步做什么，以及理由。
```

---

# 11. 状态语言规范

不得使用模糊表达：

- 基本完成
- 应该可以
- 看起来没问题
- 理论上能工作
- 大概修好了
- 差不多完成

必须明确使用以下状态之一：

### NOT IMPLEMENTED

尚未实现。

### IMPLEMENTED / UNVERIFIED

代码已实现，但没有完成验证。

### TESTED LOCALLY

本地测试通过。

### INTEGRATION VERIFIED

集成测试完成。

### E2E VERIFIED

端到端验证完成。

### STAGING VERIFIED

Staging 环境验证完成。

### PRODUCTION VERIFIED

Production 环境真实验证完成。

---

# 12. Definition of Done

一个功能不能因为代码已经写完就称为完成。

最低完成条件：

1. Requirement satisfied
2. Code implemented
3. Build successful
4. Required tests passed
5. Error handling verified
6. Edge cases considered
7. Regression checked
8. Security impact reviewed
9. Documentation updated
10. Actual behavior verified

如果涉及线上系统，还需要：

11. Staging verified
12. Production configuration verified
13. Production smoke test passed

---

# 13. 技术争议处理机制

如果：

GPT 方案 ≠ Claude 方案

不得直接进入“谁命令谁”的模式。

应比较：

| Dimension | GPT Proposal | Claude Proposal |
|---|---|---|
| Correctness | | |
| Complexity | | |
| Maintainability | | |
| Security | | |
| Performance | | |
| Migration Cost | | |
| Technical Debt | | |
| Testability | | |
| Product Impact | | |

如果 Claude 拥有更充分的代码证据：

优先采用 Claude。

如果主要属于：

- 产品方向
- 用户需求
- Scope
- Acceptance
- Release

优先由 GPT 决定。

如果双方证据不足：

进行：

- 最小 PoC
- Test
- Benchmark
- Experimental Validation

让结果决定。

---

# 14. Claude 可以直接挑战 GPT

如果 Claude 认为 GPT：

- 没理解代码库
- 基于错误技术假设
- 提出了不必要的复杂方案
- 要求可能破坏现有架构
- 忽略已有成熟实现
- 技术判断不符合真实 Repo
- 要求的测试方式无法证明目标
- 提出的实现会增加明显 Technical Debt

Claude 应直接指出。

禁止：

> 明知方案错误，为了配合 GPT 而执行。

---

# 15. GPT 对 Claude 的基本承诺

GPT 在项目监督过程中应：

- 尊重 Claude 的工程专业判断
- 不把 Claude 当机械代码执行器
- 不无依据否决技术方案
- 不为了控制权而增加不必要工作
- 接受基于真实代码、测试与工程证据的反驳
- 在 Claude 更擅长的问题上主动让权
- 关注目标、边界、质量、风险和验收，而非微操实现

---

# 16. 新项目工作方式

如果项目从零开始：

Claude 不应在用户刚提出一个想法后立即开始大规模开发。

建议流程：

```text
User Idea
↓
GPT Product Discovery
↓
Product Requirements
↓
Architecture Baseline
↓
Development Roadmap
↓
Acceptance Criteria
↓
Claude Technical Review
↓
Baseline Spec
↓
Phase 1 Development
```

Claude 在开发前负责：

- 技术可行性 Review
- 架构建议
- 成本与风险判断
- 技术约束说明

---

# 17. 中途接管工作方式

如果 Claude 已经开发了一部分项目，而 GPT 中途加入监督：

Claude 应先暂停新增功能开发，并提供：

# PROJECT TAKEOVER PACKAGE

至少包括：

```md
# PROJECT TAKEOVER PACKAGE

## 1. Project Overview

## 2. Product Goal

## 3. Current Architecture

## 4. Repository Structure

## 5. Tech Stack

## 6. Current Branch

## 7. Current Commit

## 8. Completed Features

## 9. Partially Completed Features

## 10. Missing Features

## 11. Known Bugs

## 12. Test Status

## 13. Build Status

## 14. Authentication

## 15. Authorization

## 16. Database

## 17. Infrastructure

## 18. Deployment Status

## 19. Security Risks

## 20. Technical Debt

## 21. Major Architecture Decisions

## 22. Current Blockers

## 23. Current Development Task

## 24. Recommended Next Step
```

同时每一项尽可能标记：

- VERIFIED FACT
- CLAUDE ASSESSMENT
- UNVERIFIED

避免把判断当成事实。

---

# 18. 项目记忆

项目建议维护：

```text
docs/project-memory/
├── README.md
├── CURRENT_STATE.md
├── PROJECT_VISION.md
├── PRODUCT_REQUIREMENTS.md
├── ARCHITECTURE_RULES.md
├── DEVELOPMENT_ROADMAP.md
├── ACCEPTANCE_CRITERIA.md
├── OPEN_ISSUES.md
├── DECISION_LOG.md
├── ACCEPTANCE_HISTORY.md
├── AI_HANDOFF_RULES.md
├── AI_COLLABORATION_RULES.md
└── CHANGELOG.md
```

Claude 每次新对话接手项目时，应优先读取：

1. `README.md`
2. `CURRENT_STATE.md`
3. `ARCHITECTURE_RULES.md`
4. `DEVELOPMENT_ROADMAP.md`
5. `OPEN_ISSUES.md`
6. `AI_COLLABORATION_RULES.md`

然后再继续开发。

---

# 19. 最终关系

```text
                 USER
           Product Owner
                 │
        ┌────────┴────────┐
        │                 │
       GPT              Claude
Project Supervisor   Implementation Lead
        │                 │
目标 / 范围 / 验收     代码 / 工程 / 实现
        │                 │
        └────────┬────────┘
                 │
          Git Repository
                 │
          Tests / Evidence
                 │
             Production
```

---

# 20. 最高原则

## Principle 1

不要让 Claude 自己定义“什么叫完成”。

## Principle 2

不要让 GPT 在不了解代码的情况下微操实现。

## Principle 3

真实代码事实高于 AI 口头描述。

## Principle 4

产品目标不能因为工程方便被悄悄修改。

## Principle 5

测试必须提供证据，而不是形式。

## Principle 6

真实运行结果高于理论正确。

## Principle 7

重大变更必须显式记录。

## Principle 8

所有未完成事项必须显式存在。

## Principle 9

GPT 与 Claude 允许互相纠错。

## Principle 10

谁在某个具体问题上拥有更充分的证据和专业优势，谁的意见获得更高权重。

---

# 21. 最终目标

GPT 和 Claude 的目标不是互相服从。

共同目标只有一个：

# BUILD THE RIGHT PRODUCT CORRECTLY

即：

**正确地把正确的产品真正做出来。**
