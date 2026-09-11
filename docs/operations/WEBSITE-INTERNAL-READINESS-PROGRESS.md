# WEBSITE INTERNAL READINESS — PROGRESS

日期：2026-09-11 · 督工：Codex · 执行：AMAS-website 会话（本轮为该隔离分支的唯一 Website writer）
基线：`6a72656`（== 本地 `master` == `origin/master`，复核时工作区干净）
分支：`worktree-website-cachebust-coverage`（隔离 worktree，**未推 master/main**）

**边界遵守**：未改 App 仓库 · 未动 live 数据库（本轮对 live 零访问）· 无 schema 变更 ·
未应用 0027 · 未创建 persona · 未部署或公开暴露 staging · 未改权限或密钥 · 未回显凭据 ·
未新开写者会话。原检出保持在 `master`，未被本轮触碰。

---

## 1. 历史已闭 vs 当前未满足

`RELEASE-READINESS-REPORT.md` 的时点是 **2026-09-07 / website `088dce7` / App `03bb842`**。
本轮逐项核对其 P0/P1/P2 清单，**不把过时条目当作当前事实**：

| ID | 报告中的状态 | 本轮核对结论 |
|---|---|---|
| `RB-14` 0022 未执行 | P2 OPEN | **已闭** —— live ledger 现为 `0001–0026`，0022 早已应用 |
| `RB-15` App main 有 2 个未推提交 | P2 OPEN | **已闭** —— App `HEAD == origin/main == 099f59b`，0 未推 |
| `RB-17` 课程文案「世界观理解」不一致 | P3 待拍板 | **已闭** —— D-2B-2 已拍板为「世界观」，全仓检索「世界观理解」**0 命中** |
| `RB-01` App 用本地 SQLite 无持久化 | P0 OPEN | 已大部分被 DB-12 / DB-13B 取代（App 域，非本轮范围） |
| `RB-08` 官网 Portal 线上 `SUPA` 空配置 | P1 OPEN | **仍然成立**，但**本轮刻意不修**，理由见 §2 |
| `RB-10` 11 套否定式测试一项未跑 | P1 BLOCKED | **仍然成立**，`staging.env` 至今不存在 |
| `RB-03/04/09/12/13` | P0/P1 BLOCKED/PENDING | **仍然成立**，全部 owner 依赖，见 §7 |

---

## 2. 为什么不选 `RB-08`

`assets/js/supabase-config.js` 当前已提交为 `url: ""` / `anonKey: ""`，Portal 线上确实不可用。
但把真实值填进去并让它生效，等价于**让 staging Portal 公开可用** ——
本轮明令禁止「deploy/publicly expose staging」，且 `OPEN_ISSUES #22`（IPv6 rate-limit）
本身仍在阻塞 public staging exposure。故 `RB-08` 不是本轮可执行项，保持 OPEN。

---

## 3. 本轮选定的缺口与复现

### 3.1 先确认不是缺口的几项（避免制造无谓修改）

在纯本地、零网络条件下实跑 D-2 一致性守卫中可本地判定的三项
（权威开放集合 `[bth, gdip, mdiv, dmin]` 取自此前只读实测）：

```
D2-03 官网下拉 == 开放项目（含顺序）  PASS  site=[bth,gdip,mdiv,dmin]
D2-04 Portal 申请表未 hard-code 项目   PASS  found=[]
D2-05 每个项目均有四语言文案           PASS  bth=4 gdip=4 mdiv=4 dmin=4
```

0022 收窄开放项目后官网已同步，无残留。`RB-17` 亦已闭合。

### 3.2 实际缺口：**缓存戳覆盖不全，整个 Portal 与 auth/recovery 漏戳**

静态扫描全仓 HTML（排除 `.git` / `node_modules` / `docs`）对本地 `assets/css|js` 的引用：

```
本地 js/css 引用总数 : 82
带 ?v= 缓存戳        : 31
缺缓存戳             : 51        ← 缺口
```

漏戳的是 **10 个页面**，且集中在最不该漏的位置：

```
auth/recovery/index.html
portal/admin/index.html
portal/admin/admissions/index.html
portal/admin/students/index.html
portal/applicant/application/index.html
portal/mfa/index.html
portal/student/index.html
portal/student/courses/index.html
portal/student/profile/index.html
portal/teacher/index.html
```

受影响的资产包括 `portal/auth.js` · `portal/api.js` · `portal/ui.js` · `portal/shell.js` ·
`portal.css` · `supabase-config.js`。

**影响**：这些文件变更后，回访浏览器仍会取旧缓存副本 —— 而缓存戳的存在意义正是阻止这件事。
其中两处后果具体且可预见：

1. `auth/recovery/` 是账号恢复路径，它引用的 `portal/auth.js` 一旦更新而用户拿到旧副本，
   恢复流程会以旧逻辑运行；
2. 将来 `RB-08` 被解决、`supabase-config.js` 填入真实值时，**回访用户仍会拿到 `url:""` 的旧副本**，
   Portal 对他们依然「未启用」。即修好配置也不生效，且极难归因。

### 3.3 根因

`scripts/bump.py` 用的是**硬编码 13 文件清单**。实际需要戳的页面有 **21 个**，
清单漏 10 个（另有 `discover.html` / `login.html` 列在清单里但本就不含本地资产引用，无害）。

值得记一笔：`.githooks/pre-commit` 的注释写着
「stage exactly the files bump.py reports as changed (**no hardcoded list to drift**)」——
hook 层确实做到了防漂移，但它所依赖的 `bump.py` 自己的清单漂移了。
防线建在了上层，漏洞在下层。

---

## 4. 修复（最小、可逆）

### 4.1 `scripts/bump.py` —— 用扫描替代清单

保持正则、时间戳格式、以及 `stamped <相对路径>` 的输出契约**完全不变**
（`.githooks/pre-commit` 依赖该输出做精确暂存）。
仅把「遍历硬编码清单」换成「遍历实际引用了本地 assets 的 HTML」，
跳过 `.git` / `.claude` / `node_modules` / `docs`。

新增页面自此自动纳入，不会再以同样方式漂移。

### 4.2 新增 `scripts/check-cache-bust.py` —— 可无条件本地运行的校验

官网仓库 30 套验收测试（12 个 `.mjs` + 18 个 `.sql`）**全部**需要 `staging.env` 或数据库连接，
因此本地此前没有任何可无条件运行的验证入口，`.github` 目录亦不存在（零 CI）。
本校验是其中一项可完全本地判定的契约：

```
C1  每一处指向本地 assets/css|js 的 HTML 引用都带 ?v= 缓存戳
C2  全站戳记值唯一（多值意味着漏戳后又被单独补戳，仍是漂移）
```

它**独立于 `bump.py` 实现**（自己扫描、自己解析），这样 stamper 的覆盖漏洞
不会同时让校验失效 —— 否则就是用同一个错误去检查它自己。

---

## 5. 验证证据

| 步骤 | 结果 |
|---|---|
| 修复前跑校验 | `FAIL C1 refs=82 unstamped=51`，**exit=1**（反证非空过） |
| 运行改造后的 `bump.py` | 输出 `stamped …` **21 行**，正是需要戳的 21 个页面 |
| 修复后跑校验 | `PASS C1 refs=82 unstamped=0` · `PASS C2 values=[单一值]` · **2/2 PASSED** |
| HTML 改动是否纯戳记 | **是** —— 剥离 `?v=\d+` 后，diff 的删除行多重集与新增行多重集**完全相同**，覆盖全部 82 条引用；零内容变更 |
| D-2 本地断言回归 | D2-03 / D2-04 / D2-05 **全 PASS**（`index.html` 被重戳后不受影响） |
| hook 集成 | `bump.py` 输出经 hook 的 `sed` 管道解析出 21 条路径，逐条存在、均为正斜杠相对路径，暂存步骤不会失败 |

戳记值本身随时间变化，故断言钉的是**覆盖率与唯一性**，不是某个具体数值。

---

## 6. 本轮改动清单

```
M  scripts/bump.py                    覆盖改为扫描，输出契约不变
A  scripts/check-cache-bust.py        新增本地校验（零依赖、无网络、不碰数据库）
M  21 个 HTML                          仅 ?v= 戳记，无内容变更
A  docs/operations/WEBSITE-INTERNAL-READINESS-PROGRESS.md   本报告
```

未触碰：`supabase/migrations/**` · `supabase/tests/**` · `assets/js/**` 的任何逻辑 ·
`assets/css/**` · `supabase-config.js` 的取值 · `.githooks/**`。

---

## 7. 未解决且依赖 owner 的项（本轮无法推进，如实列出）

| 项 | 依赖 | 阻塞 |
|---|---|---|
| `RB-08` Portal 线上 `SUPA` 空配置 | 需授权公开暴露 staging；且 `#22` 先行 | staging + prod |
| `RB-10` 11 套否定式越权测试 | 需 `staging.env`（含 URL + anon key） | staging + prod |
| `RB-03` Production Supabase 不存在 | owner 创建项目 | prod |
| `RB-04` SMTP 未配置 / `mailer_autoconfirm=true` | owner 定发信域名 | staging + prod |
| `RB-09` `PRODUCTION_DOMAIN` 未定 | owner 拍板 | prod |
| `RB-12` LiveKit 三变量为空 | owner 提供凭据 | prod（若语音属上线范围） |
| `RB-13` 无备份 / 回滚 / 监控 | owner 决策 + 演练 | prod |
| `#22` IPv6 rate-limit | 需专项修复（非本轮范围） | public staging exposure |
| `#26` canonical SQLite write containment | App 域，已由 App 会话登记 | public staging / prod |
| Website 仓库零 CI（无 `.github`） | 需决定是否引入，及与 GitHub Pages 部署的关系 | 见 §8 |

---

## 8. 建议的下一道闸门

**把本轮新增的本地校验接上一个可重复执行的入口。**

现状是：`scripts/check-cache-bust.py` 能跑、能失败、能证伪，但**没有任何东西会自动跑它**——
Website 仓库没有 `.github`，唯一自动化是 cache-bust 的 pre-commit hook。
这与本轮发现的缺陷同源：机制存在，覆盖不到。

两条路，建议由 Codex 择一：

1. **扩展现有 pre-commit hook**：在 stamp 之后跑一次 `check-cache-bust.py`，非零退出即阻断提交。
   零新增基础设施，与现有机制同层，最小改动。
2. **引入 Website CI**：需要先决定它与 GitHub Pages 部署的关系，属基础设施决策，超出本轮授权。

路线 1 可在下一轮以同样的隔离分支方式完成并验证；路线 2 需要 owner/Codex 先定方向。

---

## 9. 结论

```
选定缺口      缓存戳覆盖不全（10 个页面 / 51 处引用，含整个 Portal 与 auth/recovery）
复现          PASS —— 修复前校验 exit=1，unstamped=51
根因          scripts/bump.py 硬编码 13 文件清单，实际需 21 个
修复          扫描替代清单 + 新增独立本地校验
验证          2/2 PASSED；HTML 改动经严格判定为纯戳记、零内容变更
回归          D-2 本地三项断言全 PASS；pre-commit hook 集成不受影响
live 变更     无（本轮对 live 零访问）
推送          无 —— 仅提交在隔离分支，待 Codex 复核
```
