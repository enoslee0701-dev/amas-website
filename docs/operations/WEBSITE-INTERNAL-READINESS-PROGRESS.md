# WEBSITE INTERNAL READINESS — PROGRESS

日期：2026-09-11 · 督工：Codex · 执行：AMAS-website 会话（本轮为该隔离分支的唯一 Website writer）
基线：`6a72656`（== 本地 `master` == `origin/master`，复核时工作区干净）
分支：`worktree-website-cachebust-coverage`（隔离 worktree，**未推 master/main**）

> 本文档按轮次追加。**第一轮**（§1–§9）为初次修复；**第二轮**（§10）应 Codex 复核意见
> 修正校验器的三处假阳性并加装 hook 闸门。第一轮记录原样保留，未改写。

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

---

# 第二轮 —— 修正校验器假阳性 + 加装 hook 闸门

日期：2026-09-11 · 依据：Codex 对 `eff0067` 的复核意见
基线：`eff0067`（第一轮提交）· 同一隔离分支 · **仍未推 master**

Codex 指出的三处问题**全部成立**，且第二处属于我自己在别处用过、却在这里漏掉的同一类错误。

---

## 10. Codex 指出的缺陷与修正

### 10.1 C1 接受空戳 / 非数字戳（假阳性）

原实现 C1 只判断 `"?v=" not in url`，于是 `?v=`、`?v=abc`、`?v=2026` 全部算通过；
而 C2 的 `STAMP = r'\?v=(\d+)'` 又匹配不到它们，于是这些引用在两条断言里**同时隐身**。

**这比没有戳更危险**，而且不是洁癖 —— 实测证明（见 §11 的 B1）：`bump.py` 的正则是

```
((?:href|src)="(?:\.\./)*assets/(?:css|js)/[^"?]+)(?:\?v=\d+)?"
```

`[^"?]+` 在 `?` 处停下，随后的可选组只接受**全数字**。遇到 `?v=abc` 时整条匹配失败，
该引用**既不会被戳、也不会被重戳**，成为永久静默盲区 —— 而它看起来像已经处理过了。

修正：C1 改为要求 query **恰好**是 `?v=<12 位数字>`，闭合引号前不得有其它内容。
空戳、非数字、长度不符、附加参数、尾随字符一律 FAIL。

### 10.2 零引用即通过（空过）

原实现在扫描到 0 条引用时，`unstamped` 为空 → C1 PASS；`stamps` 为空 → `len<=1` → C2 PASS。
一次路径写错或正则失配就能拿到满绿。

修正：新增 **C0 反空过**，页面数与可判定引用数必须同时 `> 0`，否则立即判失败并停止后续断言。
这一条列为第一条，因为它是本校验最容易出的假阳性。

### 10.3 引号形态

实测当前仓库 129 处 `src`/`href` **全部是双引号**，单引号 0、无引号 0。
但 `bump.py` 的正则也只认双引号 —— 将来若出现 `src='…'`，stamper 摸不到它，
而校验若照同样口径扫描就会**一起看不见**，正是第一轮所修缺陷的新实例。

修正：扫描**放宽**到双引号 / 单引号 / 无引号三种形态，断言**收紧** ——
新增 **C3**：本地 assets 引用若使用 stamper 无法处理的引号形态，直接 FAIL。
把静默盲区变成响亮失败。

### 10.4 顺带补上的一条：stamper 与校验的版本格式漂移

C1 的「12 位」来自 `bump.py` 的 `strftime("%Y%m%d%H%M")`。两者分处两个文件，可能各改各的。
新增 **C4**：读 `bump.py` 核对其 strftime 格式仍为 `%Y%m%d%H%M`，并要求该文件存在。
格式一改，校验立刻报错而不是开始误判。

---

## 11. 契约用例（`scripts/test-cache-bust-contract.py`，一次性 fixture，不碰真实仓库）

一条永远为真的断言不是断言。每一项契约都构造了应当失败的场景：

```
PASS  P1   合法：双引号 + 12 位数字戳              exit=0 全过
PASS  N1   空戳 ?v=                              exit=1 failed=['C1']
PASS  N2   非数字戳 ?v=abc                        exit=1 failed=['C1']
PASS  N3   长度不符 ?v=2026                       exit=1 failed=['C1']
PASS  N4   附加参数 ?v=…&x=1                      exit=1 failed=['C1']
PASS  N5   完全无戳                               exit=1 failed=['C1']
PASS  N6   戳后有尾随内容 ?v=…x                    exit=1 failed=['C1']
PASS  N7   单引号引用                              exit=1 failed=['C3']
PASS  N8   无引号引用                              exit=1 failed=['C3']
PASS  N9   两个不同戳记值                           exit=1 failed=['C2']
PASS  N10  目录内无任何 HTML                        exit=1 failed=['C0']
PASS  N11  有 HTML 但零本地资产引用                  exit=1 failed=['C0']
PASS  N12  bump.py 版本格式漂移为 %Y%m%d            exit=1 failed=['C4']
PASS  N13  scripts/bump.py 不存在                  exit=1 failed=['C4']
PASS  B1   畸形戳 ?v=abc 运行 bump.py 后仍未被修正 → 永久盲区（实测未变更）

=== 契约用例: 15/15 PASSED ===
```

**B1 是 §10.1 严格性的实测依据** —— 不是论证出来的，是跑出来的。

---

## 12. hook 闸门（`.githooks/pre-commit`）

按授权加装，顺序为：**打戳 → 精确暂存 → 跑校验 → 失败即中止提交**。

关于「不得损坏无关已暂存内容」的处理：
hook 只做那三件事，**不执行** `reset` / `checkout` / `stash` / `clean` / `add -A`。
失败时既有暂存区除戳记文件外原样保留，作者修完直接重新提交即可。
戳记文件被暂存后即使提交中止也留在暂存区 —— 那是它们本就该有的更新，不是损坏。

同时修掉原 hook 的一处静默放行：原版把 `bump.py` 的 stderr 丢进 `/dev/null` 并无条件 `exit 0`，
stamper 崩溃时管道产出空集、提交照常通过，等于闸门失效。现改为 stamper 失败即中止。

### 端到端验证（`scripts/test-hook-gate.py`，一次性 fixture 仓库内真跑 `git commit`）

```
PASS  A1   合法状态提交成功（闸门不误杀）        exit=0 commits=1
PASS  A2   畸形戳导致提交被中止                 exit=1 HEAD 未前进=True
PASS  A3   无关已暂存内容原样保留               仍在暂存=True 内容一致=True
PASS  A2b  中止原因在 hook 输出中可见           输出含 FAIL C1=True
PASS  A4   stamper 崩溃时提交被中止             exit=1 commits=0

=== HOOK 闸门: 5/5 PASSED ===
```

A3 是「无附带损害」的直接证据：中止后 `unrelated.txt` 仍在暂存区且内容逐字节一致。

---

## 13. 第二轮验证汇总

| 项 | 结果 |
|---|---|
| 真实仓库跑硬化后的校验 | **5/5 PASSED**（C0 pages=23 refs=82 · C3 non-double-quoted=0 · C1 invalid=0 · C2 单一值 · C4 格式未漂移） |
| 契约用例（14 负向 + 1 正向 + B1 实测） | **15/15 PASSED** |
| hook 闸门端到端 | **5/5 PASSED** |
| 第一轮断言是否仍成立 | 是 —— C1/C2 在硬化后对真实仓库仍 PASS，覆盖率与唯一性结论不变 |

---

## 14. 第二轮改动清单

```
M  .githooks/pre-commit                    加装校验闸门 + 修掉 stamper 崩溃时的静默放行
M  scripts/check-cache-bust.py             C0 反空过 / C1 格式严格 / C3 引号形态 / C4 防漂移
A  scripts/test-cache-bust-contract.py     14 负向 + 1 正向 + B1 实测
A  scripts/test-hook-gate.py               一次性 fixture 仓库内真跑 commit 的端到端验证
M  docs/operations/WEBSITE-INTERNAL-READINESS-PROGRESS.md   追加本轮（第一轮记录未改写）
```

未触碰：`supabase/migrations/**` · `supabase/tests/**` · `assets/**` 的任何逻辑 ·
`supabase-config.js` 的取值 · 任何历史报告（`RELEASE-READINESS-REPORT.md` 等原样保留）。

**本轮对 live 零访问**：无 schema 变更 · 无迁移 · 无 persona · 未应用 0027 ·
未部署或公开暴露 staging · 未改权限或密钥 · 未引入 CI · 未推 master。

---

## 15. 仍未解决、依赖 owner 的项

与第一轮 §7 相同，未因本轮变化：`RB-03/04/08/09/10/12/13` · `#22` · `#26`。
「Website 仓库零 CI」一项的状态更新为：**已有可无条件本地运行的验证入口，
且已接上 pre-commit 闸门**；是否另行引入 CI 仍是 owner/Codex 的基础设施决策。

---

## 16. 一处必须写明的限制：hook 闸门在本分支上无法自证

提交 `d6bc448` 之后核对发现：`core.hooksPath` 配的是**绝对路径**

```
core.hooksPath = C:\Users\enosl\Desktop\AMAS-website\.githooks
```

worktree 与主检出**共享 git 配置**，因此在本隔离 worktree 里提交时，
git 用的是**主检出**的 `.githooks/pre-commit`（仍是旧版），
而不是本分支刚改好的那一份。

实测证据：`d6bc448` 把戳记从 `202609111133` 推进到 `202609111146`，
说明旧 hook 确实运行并调用了 worktree 的 `scripts/bump.py`（hook 的 cwd 是 worktree 根）；
但旧 hook 没有校验步骤，所以**本次提交没有跑过 `check-cache-bust.py`**。

由此三点：

1. **不能拿本分支的提交当作新 hook 生效的证据。** 我先前在对话中说过
   「让新 hook 正常运行，这是它在真实仓库里的活证据」——**那句话是错的**，就地更正。
   报告 §12 引用的始终是 fixture 证据，未受影响。
2. **`scripts/test-hook-gate.py` 是唯一有效的证明方式**，而且方式是对的：
   它在一次性 fixture 仓库里把 `core.hooksPath` 指向该仓库自己的 `.githooks`，
   因此测的是 **hook 文件的内容**，与部署路径无关。5/5 PASSED 的结论成立。
3. **闸门要真正生效，必须等本分支合入且主检出拿到这份 `.githooks/pre-commit`。**
   在那之前，主检出与其它 worktree 的提交仍走旧 hook（只打戳、不校验、
   且 stamper 崩溃时静默放行）。这一点请 Codex 在决定合入时机时一并考虑。

附带一个可复用的判断：任何「改 hook 本身」的工作都无法在 worktree 内自证，
因为 `core.hooksPath` 指向主检出。以后遇到同类任务，
直接用一次性 fixture 仓库验证 hook 内容，不要试图用本分支的提交去证明它。

---

# 第三轮 —— Codex 复核发现的暂存污染：修复与证明

日期：2026-09-11 · 依据：Codex 对 `d91c596` 的独立复核
复现脚本：`Codex/2026-09-11/bang/work/review-hook-partial-stage.py`
基线：`d91c596` · 同一隔离分支 · **仍未推 master**

Codex 的复现结论是 `COMMIT_EXIT 0` / `UNSTAGED_DRAFT_ENTERED_COMMIT True` ——
**缺陷成立，而且其中一条是我第一轮引入的。**

---

## 17. 缺陷：hook 的自动暂存把未暂存内容送进了提交

### 17.1 路径一 —— 同文件部分暂存（Codex 复现的场景）

```
index.html 已 add（意图变更 A），随后又被改出一段未暂存的私稿 B
→ bump.py 读工作区（A+B）打戳并写回
→ hook 对整文件暂存
→ 私稿 B 进入提交                    ← 污染
```

要害在于 hook 把「打戳」与「暂存整个文件」绑在一起：
**打戳这个动作本身，成了把工作区未暂存内容送进提交的载体。**

### 17.2 路径二 —— 未跟踪 HTML（这条是我第一轮引入的）

第一轮把覆盖从硬编码 13 项改为全量扫描时，**同时把 `git add` 的作用面扩大到了未跟踪 HTML**。
硬编码清单时代不存在这条路径：清单里只有既有页面。
带本地资产引用的未跟踪页面会被打戳，随后被 hook 暂存 ——
等于把作者没打算提交的新文件带进提交。

扩大覆盖是对的，但我没有同时评估它对自动暂存面的影响。

### 17.3 为什么第二轮的 A3 没抓到

A3 用的是一个**未被打戳的无关文件**（`unrelated.txt`）。
它证明了「hook 不会去动它没碰过的东西」，但没有覆盖
「hook 碰过的那个文件里，有作者不想提交的部分」。
前者是旁观者，后者才是载体。**测试选错了对象。**

---

## 18. 修复：写入前 GUARD，失败即拒绝并报确切路径

### 18.1 保护放在 `bump.py` 内部，而不是另起一个脚本

两个理由：

1. **保护属于「会发生变更的那个工具」。** 任何调用者（hook、人手、将来的 CI）都自动受益，
   不依赖调用方记得先跑一个守卫脚本。
2. **Codex 的复现脚本只拷贝 `bump.py` / `check-cache-bust.py` / `pre-commit` 三个文件。**
   若保护放在第四个脚本里，他们的复现会因「文件缺失」而中止 ——
   得到正确的结果，却是错误的原因。这种"通过"没有价值。

### 18.2 GUARD 的判据与行为

在**写入任何文件之前**，对候选 HTML 逐一检查：

```
untracked  = ls-files --others --exclude-standard -- <候选>
unstaged   = diff --name-only -- <候选>        # index 与工作区的差异，含部分暂存
```

两者任一非空即整体拒绝，退出码 2，**不写入任何文件**，并按路径逐行列出：

```
BLOCKED unstaged  index.html
BLOCKED untracked scratch.html
```

**刻意不做**：`stash` / `reset` / `checkout` / 丢弃工作区 / 整目录暂存。
那些都会替作者做他没要求的决定。拒绝 + 报路径，由作者自行处置。

新增 `--list`（只列候选）与 `--guard-only`（只检查不写入），
使这套判断可以独立于提交流程被调用与测试。

### 18.3 校验器改读暂存区

新增 `--from-index`：读 `git ls-files` + `git show :<path>`，
校验**真正会被提交的那份内容**，而不是磁盘上当下的内容 ——
在部分暂存场景里两者并不相同。hook 已改用 `--from-index`。

### 18.4 运行时输出改为 ASCII

Codex 那次复现除了报出缺陷，还暴露了第二个问题：
我的中文 stderr 让他们的采集器抛 `UnicodeDecodeError: 'gbk' codec can't decode byte 0x80`。

要求是「fail closed **with precise path list**」，而**路径列表若解不出来就等于没给**。
这个仓库的历史里 psql 中文输出被 GBK 打乱过多次，是同一类问题。
故三个脚本与 hook 的**运行时输出**统一改为 ASCII；注释与文档保持中文。
修复后 Codex 的脚本输出干净，无异常。

---

## 19. 第三轮验证证据

### 19.1 Codex 自己的复现脚本（最直接的验收）

```
修复前：COMMIT_EXIT 0   UNSTAGED_DRAFT_ENTERED_COMMIT True    + UnicodeDecodeError
修复后：COMMIT_EXIT 1   UNSTAGED_DRAFT_ENTERED_COMMIT False   无异常
```

### 19.2 闸门用例扩充到 16 项（`scripts/test-hook-gate.py`）

```
PASS A1   合法状态提交成功（闸门不误杀）
PASS A2   畸形戳导致提交被中止            PASS A2b  中止原因可见
PASS A3   无关已暂存内容原样保留
PASS A4   stamper 崩溃时提交被中止
PASS A5   同文件部分暂存 → 提交被拒        exit=1，HEAD 未前进
PASS A5b  私稿未进入任何提交               HEAD:index.html 不含私稿
PASS A5c  暂存区未被改动（连戳都没打）        index 一致
PASS A5d  工作区未被改动                  worktree 一致
PASS A5e  拒绝原因含确切路径               输出含 index.html
PASS A6   未跟踪 HTML → 提交被拒
PASS A6b  该文件仍未跟踪、未被暂存           ls-files='' others='scratch.html'
PASS A6c  未跟踪文件未被改动（未打戳）
PASS A6d  拒绝原因含确切路径               输出含 scratch.html
PASS A7   无关已跟踪 HTML 有未暂存改动 → 提交被拒
PASS A7b  拒绝原因含确切路径               输出含 other.html

=== HOOK 闸门: 16/16 PASSED ===
```

**A5c / A5d / A6c 是「写入前拒绝」的直接证据**：
不只是提交被拦，连戳都没打 —— 暂存区与工作区逐字节未变。

A7 是顺带覆盖的第三条路径：无关的已跟踪 HTML 若有未暂存改动，
旧 hook 会把它一并提交（这条在硬编码清单时代就存在，只是从没被测过）。

### 19.3 其余套件

```
真实仓库契约校验（工作区）  5/5 PASSED   pages=23 refs=82 invalid=0
契约用例                 15/15 PASSED  14 负向 + 1 正向 + B1 实测
```

---

## 20. 第三轮改动清单

```
M  scripts/bump.py                  写入前 GUARD + --list / --guard-only + 输出 ASCII 化
M  scripts/check-cache-bust.py      新增 --from-index（校验暂存区）+ 输出 ASCII 化
M  .githooks/pre-commit             改用 --from-index + 输出 ASCII 化
M  scripts/test-hook-gate.py        闸门用例 5 → 16，补 A5/A6/A7 三条污染路径
M  docs/operations/WEBSITE-INTERNAL-READINESS-PROGRESS.md   追加本轮（前两轮未改写）
```

**边界**：未改 App 仓库 · 对 live 零访问 · 无 schema 变更 · 未应用 0027 ·
未创建 persona · 未部署或公开暴露 staging · 未改权限或密钥 · 未引入 CI ·
未推 master · 历史报告原样保留。

§16 的限制仍然成立：**hook 闸门在本分支上无法自证**，
唯一有效证明仍是 `scripts/test-hook-gate.py` 的一次性 fixture 仓库。

---

## 21. 一条值得记下的方法论

第二轮我写了 A3 并认为「无附带损害」已被证明。它确实证明了一件事，
只是不是最要紧的那件 —— 它测的是 hook **没碰过**的文件，
而污染发生在 hook **碰过**的文件里。

教训不是「测试写少了」，而是：**当一个机制会自动修改并暂存文件时，
第一个该问的问题是「它修改的那个文件里，有没有作者不想提交的部分」**，
而不是「它会不会误伤别的文件」。前者是载体，后者只是旁观者。

---
---

# 第四轮 — 本地运行时就绪性验收（Website + Portal）

任务：本地起静态服务器，用浏览器实测既有公开路由、导航、资源与控制台失败。
不使用任何真实登录账号，不产生任何 live 写入。优先找**具体断裂的路由/资源或前端运行时错误**，
不新增功能。结论：**未发现需要修复的运行时缺陷**，因此本轮为**纯验收，零代码改动**。

基线 HEAD = `0dbf499`（与 Website 本地 master 一致）。

## 22. 本轮怎么测的

本地服务：`python -m http.server 8731 --bind 127.0.0.1`（仓库根）。
浏览器：Chrome `--headless=new`，通过 Chrome DevTools Protocol 驱动（Node 22 内置
`WebSocket` + `fetch`，零依赖，不引入任何 npm 包，不写进仓库）。
全部一次性脚本放在仓库外的 `%TEMP%\amas-ro-review\`，随时可弃。

采集的信号：`Runtime.exceptionThrown`、`Runtime.consoleAPICalled`(error/warning)、
`Log.entryAdded`(error)、`Network.loadingFailed`、`Network.responseReceived` 状态码 ≥400。

## 23. 先证明探针不是瞎的（反空过）

「23 个页面全绿」这种结果，最容易的解释是探针根本没在采样。
所以先在 :8732 上放了一对对照页：

| 对照页 | EXC | CON | HTTP≥400 | NET fail |
|---|---|---|---|---|
| `bad.html`（故意抛异常 + console.error + 引用不存在资源） | 1 | 2 | 1 | 1 |
| `good.html`（干净页） | 0 | 0 | **1** | 0 |

`good.html` 那一条 404 是浏览器自动请求的 `/favicon.ico`。
这恰好解释了为什么真实站点是 0 —— **站内每个页面都显式声明了
`<link rel="icon" href="…/assets/img/favicon.png">`，而该文件存在**，
浏览器就不会去猜 `/favicon.ico`。零不是探针失灵，是站点本身把这条也堵上了。

## 24. 引用完整性（静态）

`refcheck.py` 解析所有 HTML 的 `src / href / srcset / data-src`，逐条在磁盘上解析：

```
页面 27   引用总数 260   可本地解析 191
缺失 0    空引用 0    越界（指向仓库外）0
```

## 25. 运行时审计（动态，23 个页面）

| 结果 | 数量 |
|---|---|
| 页面总数 | 23 |
| 未捕获异常 | **0** |
| console 错误 | **0** |
| HTTP ≥400 | **0** |
| 网络加载失败 | **0** |

覆盖：`index` / `about` / `academics` / `admissions` / `giving` / `discover` /
`contact` / `news` / `help/` / `login.html` + `login/` / `auth/callback` /
`auth/recovery` / 12 个 `portal/**` 页面。

## 26. Portal 的降级行为（未配置数据库 = 已知外部闸门）

所有 12 个 Portal 页 + `auth/callback` 都渲染出明确的降级说明：

> 🔧 门户系统尚未启用 — 账号与学习系统正在部署中（等待数据库环境开通），目前暂不可登录。

`auth/recovery` 有自己的专用文案（"无法完成重设 / 门户系统尚未启用，无法处理密码重设"），
并保留「重新申请重设链接」「返回官网」两个出口。

**没有一个页面是白屏或半渲染**。缺配置走的是**优雅降级**，不是崩溃。
这是本轮最值得确认的一件事：外部闸门未开时，站点仍是可发布状态。

## 27. 交互路径实测：discover 测验

`discover.html` 的 10 题测验是站内唯一的纯客户端多步交互，也是最可能藏运行时错误的地方。
实测：点击「开始快速探索」→ 逐题作答 14 轮 → 渲染结果页。

```
开始测验      clicked    累计错误 0
作答轮次      14         累计错误 0
结果页文本    833 字     累计错误 0
```

结果页正常产出（"你的初步状态…「圣经熟悉度」是最值得先投入的地方…"）。
**全流程 0 异常。**

## 28. 部署路径安全性：根绝对路径扫描

子路径部署（如 GitHub Pages 项目页）下，`/xxx` 会打到域名根而不是站点根，是典型的
"本地好好的、上线全断"。因此专门扫了一遍：

```
HTML 中根绝对路径引用 : 0
JS  中根绝对路径字面量 : 3
```

那 3 条逐条核对了上下文，**全部是拼在 Supabase base URL 之后的 API 路径，不是站点路径**：

| 位置 | 字面量 | 实际形态 |
|---|---|---|
| `assets/js/main.js:873` | `/rest/v1/submissions` | `fetch(S.url + "/rest/v1/submissions", …)` |
| `assets/js/portal/auth.js:77` | `/functions/v1/login-by-identifier` | `fetch(SUPA.url + "/functions/v1/login-by-identifier", …)` |
| `assets/js/portal/auth.js:190` | `/functions/v1/` | `fetch(SUPA.url + "/functions/v1/" + name, …)` |

结论：**全站相对路径，子路径部署不会断。非缺陷。**

## 29. i18n 现状（是产品覆盖面问题，不是运行时缺陷）

| 页面 | 机制 | `?lang=` | 跨页继承 |
|---|---|---|---|
| `index.html` | `main.js`，598 个 `data-i18n`，4 个 `data-lang` | 生效 | 写入 `localStorage("amas-lang")` |
| `giving.html` | 自带内联 zh/en/ko/th 词典 + 切换器，33 个 `data-i18n` | 4 语全部生效 | 读取并跟随 index 的选择 |
| `discover.html` / `help/` | **无词典** | 不适用 | `stored=en` 时仍保持 `zh-CN` |

后两者不是坏了 —— 是**内容尚未国际化**。属于产品范围决策，本轮不动。

## 30. 一处 UX 断点（报告，不修）

`discover.html` 有 **0 个 `<a href>`**，也没有「返回官网」出口；
它的控件全是 `<button onclick="goApp(...)">` 和测验动作。
而它被 `index.html`（第 230、877 行）以及 `portal/applicant/index.html`、
`portal/student/index.html` 三处链入。

用户进得去、出不来（只能用浏览器后退）。

判定：**UX 死角 / 产品缺口，不是断裂路由，也不是运行时错误**。
加导航属于内容与信息架构决策 —— 按本轮「不新增功能」的边界，报告而不动手。

## 31. 本轮结论

| 项 | 结论 |
|---|---|
| 断裂路由 | 无 |
| 缺失/404 资源 | 无 |
| 前端运行时错误 | 无 |
| 部署路径风险 | 无（全相对路径） |
| 交互路径 | discover 测验全流程通过 |
| 需要修复的缺陷 | **无 → 本轮零代码改动** |

**仍然存在的外部依赖（非本仓库能解）：**
1. Supabase 环境与 Portal 真实配置注入 —— Portal 全部功能的前置闸门，当前走降级路径。
2. `login-by-identifier` 等 Edge Function 部署 —— 学号登录路径依赖它。
3. `0027` 及后续迁移仍 HOLD（不在 Website 职责内）。
4. 产品侧决策两项：discover 的返航导航、discover/help 的多语言内容。

## 32. 方法论追记

第三轮我记下的教训是「先问载体、再问旁观者」。这一轮的对应版本是：
**拿到一个全绿结果时，先花力气证明探针会变红。**
`good.html` 上那条 `/favicon.ico` 404 是意外收获 —— 它同时做了两件事：
证明网络层采样是活的，以及解释了真实站点为什么合法地为零。
一个全绿结论的可信度，不取决于它有多绿，而取决于同一套装置在坏样本上有多红。

## 33. 对第四轮提交说法的更正

提交 `82b6f2b` 的信息写的是「零代码改动」。这对**我写的内容**成立，
但对**提交树**不成立 —— 该提交实际含 22 个文件、234 增 82 删。

差额来自 pre-commit hook 的既定行为：它在每次提交时把全站缓存戳号
统一重写为一个新时间戳（本次 `202609111223`），因此 21 个 HTML 文件被自动重戳。

已核实这 21 个文件**只有戳号变化**：

```
git show HEAD -- . ':(exclude)docs' | grep '^[+-]' | grep -v '^[+-][+-]' | grep -vc '?v=[0-9]{12}'
→ 0
```

即 docs 之外的每一行改动都含 `?v=<12 位数字>`，**零内容变更**。

按既有规则不 amend 已有提交，故在此更正措辞：
准确说法是「**本轮零内容改动；HTML 差异全部是 hook 自动戳号，非人为编辑**」。

这也顺带记录了一个 hook 的正常副作用：**任何一次提交都会带上全站戳号刷新**，
哪怕本次只改了一个 Markdown 文件。这是第一至三轮确定的设计（C2 要求戳号全站唯一），
不是本轮引入的问题，但审阅 diff 时值得预先知道，免得把机械改动误读成内容改动。

---
---

# 第五轮 — discover.html 返航出口（有界可用性修复）

Codex 复核第四轮后授权：为 `discover.html` 加一个清晰、可访问的「返回官网」链接，
沿用现有样式，子路径部署下解析正确，保住答题进度与既有答题行为。
不扩展翻译、不扩展产品内容。

## 34. 改了什么

两处，共 12 行，全在 `discover.html`：

**结构** —— 放在四个屏幕 div **之外**、`.wrap` 收尾处：

```html
<nav class="site-exit" aria-label="站点导航">
  <a class="back-link" href="index.html"><span class="ar" aria-hidden="true">‹</span>返回官网</a>
</nav>
```

三个决定各有理由：

- **放在屏幕 div 之外** —— `show(id)` 只在 `landing / quiz / result / detail`
  四个 div 上切 `hidden`，因此屏幕外的元素天然常驻四屏，不需要改 `show()`。
  少动一行 JS，就少一条回归风险。
- **纯静态 `<a>`，不是 `<button onclick>`** —— 该页现有控件全是 `button onclick`，
  这正是它成为死角的原因（`<a href>` 数 = 0）。用真 `<a>` 才能拿到原生键盘可达、
  中键新标签页、右键复制链接、以及搜索引擎可见的链接关系。
- **相对路径 `index.html`** —— 与 `discover.html` 同级，子路径部署照样解析。
  已在测试里用挂在 `/amas-website/` 前缀下的内置服务器实证。

**样式** —— 沿用该页既有的 `.ghost-btn` 视觉语言（白底、`#E2E5EB` 描边、
`#475467` 文字、999px 圆角），并补了三点：`min-height:44px` 触控目标、
`:focus-visible` 金色轮廓、`margin-top:auto` 让它在短屏（答题屏）也贴住底部。

固定底栏遮挡用纯 CSS 解决，不加 JS：

```css
.sticky-cta:not(.hidden) ~ .site-exit { padding-bottom: calc(84px + env(safe-area-inset-bottom)); }
```

`#stickyCta` 只在结果页去掉 `hidden`，且在 DOM 中位于 `.site-exit` 之前，
后继兄弟选择器因此能精确跟随它的显隐，无需 JS 参与。

## 35. 测试：`scripts/test-discover-back-link.mjs`（21/21 PASS）

真浏览器回归，Node 22 内置 `WebSocket` + `fetch` 驱动 Chrome CDP，零 npm 依赖。
测试内置一个静态服务器，把整站挂在 `/amas-website/` 前缀下 —— **子路径是被实测的，
不是被假设的**。

| 用例 | 断言 | 结果 |
|---|---|---|
| T0 | 反空过：删掉链接后同一套断言必须失败 | `present=false` |
| T1 / T1b | 存在、是真 `<a>`、可见、文案正确 | `tag=A h=44` |
| T2 | 子路径下 `href` 解析为 `<base>/index.html` | 精确相等 |
| T3 / T3b | Tab 可达（4 次）、焦点轮廓可见 | `outline=solid 3px` |
| T4 / T4b | 375px：触控目标 ≥44px、不溢出视口 | `h=44 left=133 right=242` |
| T4c | 1280px 桌面断点同样成立 | `left=578 right=687` |
| T5 | landing / quiz / result / detail 四屏均可见 | 四个 true |
| T6 / T6b | 结果页固定底栏确实出现；让位内边距确实生效 | `padding-bottom=84px` |
| T6c / T6d | 滚到文档底部时链接在视口内，且不被底栏遮住 | `link.bottom=636 < sticky.top=663` |
| T7 / T7b / T7c | 作答 3 题后进度仍为 3；答题中链接可见；聚焦链接不清空进度 | `answers.length=3` |
| T8 / T8b | 真实点击导航到官网首页并渲染 | `landed=<base>/index.html` |
| T9 / T9b | 10 题全程跑完出结果页，零异常零 console 错误 | `errors=0` |

附带回归：`check-cache-bust.py` 5/5 PASS（新链接是页面链接不是资源引用，
校验器按设计不管它）；引用完整性 260→**261** 条、可解析 191→**192** 条，
新增的正是这一条，缺失仍为 0。

## 36. 两处失败是器具的错，不是站点的错

第一次跑是 18 项里挂 2 项。两条都查到根因，**结论都是改测试、不改站点**：

**T9b `TypeError: Cannot read properties of undefined (reading 'a')` ×5**
`finish()` 里 `QS[qi]` 越界。成因是我的 `answerN` 在结果页出现后仍继续点击 ——
答完最后一题时 `#quiz` 被隐藏，但 `#opts` 里上一题的按钮仍留在 DOM 中，
**程序化 `.click()` 对隐藏元素照样生效**，于是 `answers` 被推过 `QS.length`。
真人点不到隐藏元素，这条路径不存在。
第四轮的探针因为过滤了 `offsetParent !== null` 才没撞上 —— 同一个坑，
两个器具一个踩一个躲，正好互为印证。修法：`answerN` 也加上可见性过滤与屏幕状态判断。

**T6d 重叠误报**
`scrollIntoView({ block:'end' })` 把**链接自身**的底边贴到视口底边，
直接绕过了我加在父元素 `.site-exit` 上的让位内边距，测出一个真人到不了的位置。
用户能到达的最低点是文档底部，所以改用 `window.scrollTo(0, scrollHeight)`。
改完 636 vs 663，留 27px 余量。
同时补了 T6b 直接断言 `padding-bottom=84px` —— **既验几何结果，也验产生它的机制**，
免得哪天内边距被删掉而几何恰好仍然过关。

## 37. 需要上报的同步义务（不在本仓可解）

`discover.html` 文件头自己写明：

> SOURCE OF TRUTH: amas-website/discover.html
> AMAS-Seminary 仓库中的 public/discover.html 为同源副本（仅资源路径与 App 链接配置不同）；
> 两处需同步修改，避免双向漂移。

本轮只改了 Website 侧。**App 仓非本会话可写**，因此
`AMAS-Seminary/public/discover.html` 的同一处返航出口**尚未同步**，
需由 Codex 派发给 App 侧执行，否则两份副本从这一轮开始漂移。

## 38. 对第四轮措辞的更正（Codex 要求）

第四轮报告里「Portal 降级正常 / 站点仍处于可发布状态」的说法需要收窄。

准确表述是：**在缺失真实 Portal 配置的前提下，本地只验证了公开页面与降级路径**，
即「配置缺失时不崩溃、有明确文案与出口」。这**不等于** Portal 具备发布就绪性 ——
登录、会话、权限、数据读写等全部真实 Portal 功能**一条都没有被验证过**，
它们的前置条件（Supabase 环境、真实配置注入、Edge Function 部署）目前都未满足。

换句话说：第四轮证明的是**降级行为正确**，不是**功能就绪**。
前者是后者缺席时的兜底，两者不能互相代替。

---
---

# 第六轮 — 焦点滚动遮挡：Codex 的质疑成立

## 39. 我上一轮的判断错了

第五轮 §36 我把 `scrollIntoView({block:'end'})` 测出的遮挡称为
「真人到不了的位置」，理由是用户能到达的最低点是文档底部。

Codex 指出：**Tab 聚焦和页内查找也会以同样方式滚动链接**。这条质疑成立。

我当时只想到了「用户手动滚动」这一种滚动来源，漏掉了浏览器自己发起的滚动。
两者的落点规则根本不同：

| 滚动来源 | 落点规则 | 受什么约束 |
|---|---|---|
| 用户手动滚 | 停在文档最大滚动量 | `.site-exit` 的 `padding-bottom`（它是文档流的一部分，撑高了 scrollHeight） |
| Tab 聚焦 / Ctrl+F / `#锚点` | 把元素**自身边缘**对齐到视口边缘 | `scroll-margin`，**与 padding 无关** |

`padding-bottom` 撑的是文档，`scroll-margin` 管的是落点。我拿前者的证据去否认后者的风险。

## 40. 先复现，再修

把三条键盘/查找路径写成用例后首跑（修复前）：

```
PASS R2   Tab-focused link is not obscured        link.bottom=636  sticky.top=663  gap=27
FAIL R4   edge-aligned scrollIntoView             link.bottom=720  sticky.top=663
```

**R4 挂了，R2 却过了** —— 这个差异本身说明了机制：

Tab 聚焦同样想把 `link.bottom` 对到 720，但文档最大滚动量被 `.site-exit`
那 84px 内边距挡住，浏览器滚不过去，于是被钳位在 636。
**内边距碰巧救了 Tab 路径，救不了 `scrollIntoView` 路径** ——
因为后者不需要文档有那么多可滚动内容，它直接改变滚动偏移的目标值。

所以：遮挡是真的（57px），但我上一轮以为的触发条件是错的。

## 41. 修法：`scroll-margin-bottom`

`discover.html` 加一条规则，与已有的内边距规则同域：

```css
.sticky-cta:not(.hidden) ~ .site-exit .back-link {
  scroll-margin-bottom: calc(84px + env(safe-area-inset-bottom));
}
```

两条规则各管一半，缺一不可：`padding-bottom` 给手动滚动留出停靠空间，
`scroll-margin-bottom` 给浏览器发起的滚动留出落点余量。

依旧是纯 CSS、零 JS、未碰答题逻辑。

## 42. 回归：`scripts/test-discover-back-link.mjs` 30/30 PASS

新增 R 系列 6 项（全部在 375px、结果页、固定底栏可见的条件下）：

| 用例 | 断言 | 实测 |
|---|---|---|
| R0 | 前置：确实在结果页且底栏可见 | `stickyTop=663` |
| R1 | 从页顶按 Tab 可达链接 | 6 次按键 |
| R2 | Tab 聚焦后不被底栏遮挡 | `636 < 663`，余 27px |
| R3 | Shift+Tab 反向退到上一个页内控件 | `now=BUTTON` |
| R3b / R3c | Tab 正向回到链接，且不被遮挡 | `focused=true`，`636 < 663` |
| R4 | 边缘对齐 `scrollIntoView`（查找代理）不被遮挡 | `636 < 663` |
| R4b | **机制断言**：`scroll-margin-bottom` 确实生效 | `84px` |
| R5 | 聚焦后按 Enter 能真的激活并导航 | `landed=<base>/index.html` |

### R3 的第一版是我写错的

首版写成「按 Tab 离开链接，再 Shift+Tab 回来」，结果 `focused=false`。
原因不是页面的问题：**链接是文档最后一个可聚焦元素**，一次 Tab 就把焦点交给了
浏览器 UI（地址栏），Shift+Tab 回来的是浏览器而不是页面。
改成真实的反向路径 —— 从链接 Shift+Tab 退到上一个控件，再 Tab 前进回来 —— 即通过。

### 负向控制：证明那行 CSS 是承重的

临时删掉 `scroll-margin-bottom` 规则重跑：

```
FAIL R4    link.bottom=720  sticky.top=663
FAIL R4b   scroll-margin-bottom=0px
```

恢复后 30/30。这排除了「几何恰好过关但修复其实无效」的可能。

R4b 这条机制断言是特意加的：只断言几何数字，将来规则被误删而数字碰巧仍然合格时，
测试会沉默地放行。同时断言机制与结果，才能让删除行为立刻可见。

## 43. 这一轮的方法论

第四轮我记的是「先证明探针会变红」，第五轮是「既验几何也验机制」。
这一轮的教训更直接：**「真人做不到」是一个需要证明的断言，不是一个可以顺手下的结论。**

我上一轮说 `scrollIntoView` 那条路径真人不可达时，脑子里只枚举了一种滚动来源。
判定「不可达」的正确做法，是把所有能产生该状态的入口列出来逐个排除，
而不是想不出入口就当它不存在。Codex 只补了两个入口（键盘焦点、页内查找），
结论就翻了过来。

代价对比也值得记：多写三条用例的成本，远低于让一个键盘用户在结果页
按 Tab 之后发现出口被压在固定底栏下面。

---
---

# 第七轮 — Portal 真实配置的本地发布前检查

督工指令：实现或完善 Portal 真实配置的本地发布前检查命令。先复用现有校验脚本；
检查真实 URL/anon 配置占位、必要 Edge Function 契约与部署路径，输出按项 ready/missing；
不输出 secret、不自动填生产配置、不登录写 live、不部署；离线 fixture 覆盖
缺失/格式错误/有效等；**不以降级页通过冒充 Portal 就绪**。

## 44. 先确认「是否已有等价检查」

指令要求能复用就不要再造。逐一核对后的结论是**没有可复用的等价命令**：

| 候选 | 实际是什么 | 能否复用 |
|---|---|---|
| `scripts/check-cache-bust.py` | 资源戳号契约（C0–C4） | 与配置无关 |
| `scripts/test-hook-gate.py` | 提交闸门 | 与配置无关 |
| `docs/operations/RELEASE-READINESS-REPORT.md` | **2026-09-07 的一次性报告快照** | 不是可执行命令 |
| `docs/operations/DB-2-DATA-PREFLIGHT-REPORT.md` 等 | 数据库侧一次性报告 | 不覆盖前端配置 |

所以新建检查，但**沿用既有约定**：ASCII 运行时输出、反空过哨兵、
`PASS/FAIL <name> | <detail>` 行格式、退出码语义。

## 45. 产物

```
scripts/check-portal-config.py              检查命令（离线只读，0=READY 1=有缺口 2=用法错）
scripts/test-portal-config-check.py         契约测试（44/44 PASS）
scripts/fixtures/portal-config/*.js         13 个离线 fixture，不含任何真实凭据
```

## 46. 检查了哪 10 项

| 项 | 检查内容 | 为什么要查 |
|---|---|---|
| P1 | 配置文件存在且确实赋值 `window.SUPA` | 文件在但没赋值 = 运行时静默降级 |
| P2 | url 非占位、https、host 形态合法 | 区分「没填」与「填错」 |
| P3 | anonKey 是结构合法的 JWT | 三段式 + payload 可解 |
| P4 | **role 必须是 anon** | `service_role` 混进客户端配置 → 直接 **BLOCKED** |
| P5 | key 未过期 | 过期 key 会让登录整体失败 |
| P6 | key 的 `ref` 与 url 的 ref 同项目 | 捕捉「两个项目的值配错对」 |
| P7 | 客户端调用的每个 Edge Function 都有 `index.ts` | 契约缺口 |
| P8 | 每个 Portal 页都加载了 `supabase-config.js` 与 supabase-js | `CONFIGURED` 还依赖 `window.supabase` |
| P9 | `siteRoot()` 的目录白名单覆盖所有 Portal 页所在目录 | 子路径部署下 ROOT 解析 |
| P10 | HTML 无根绝对路径引用 | 子路径部署 |

`P4` 是本轮唯一带安全含义的检查。考虑到本项目历史上有「service_role 暴露 =
OWNER-ACCEPTED / DEFERRED」的记录，把它做成**硬 BLOCKED 而非警告**是必要的。

## 47. 仓库当前真实输出

```
P1 config-file        READY    parsed assets/js/supabase-config.js
P2 supabase-url       MISSING  url is empty or a placeholder -> Portal runs in degraded mode
P3 anon-key-shape     MISSING  anonKey is empty or a placeholder -> Portal runs in degraded mode
P7 edge-functions     READY    all 7 called functions implemented: create-teacher-invitation,
                               login-by-identifier, recovery-finalize, review-application,
                               review-teacher-verification, student-lifecycle, submit-teacher-verification
P7c scanner-drift     INFO     4 call site(s) pass the function name as a variable
P8 runtime-deps       READY    all 17 portal pages load both supabase-config.js and supabase-js
P9 site-root-markers  READY    all portal page dirs covered by siteRoot() markers (8 markers)
P10 subpath-safety    READY    no root-absolute refs in HTML
I1 degraded-path      INFO     graceful degradation present (NOT evidence of readiness)

=== PORTAL CONFIG PREFLIGHT: 5/7 READY, 2 GAP(S) -> NOT READY ===
```

**精确缺口就两项**，都在配置值本身：`P2` 与 `P3`。
其余结构性前置（Edge Function 契约、运行时依赖、部署路径）**全部就绪** ——
也就是说 Portal 差的不是代码，是两个还没填的值和它们背后的 Supabase 环境。

## 48. 「降级页不得冒充就绪」是怎么落实的

不是靠措辞，是靠结构：

- 降级路径的检查登记为 `I1`，状态恒为 `INFO`；
- `verdict()` 只数 `GAP_STATES = {MISSING, INVALID, BLOCKED}`，`INFO` 行**在数学上无法参与判定**；
- 判定为 NOT READY 时，末尾固定打印
  `A rendering degradation page is NOT Portal readiness.`；
- 契约测试 `S5` 用仓库当前状态（`missing.js`）断言：降级路径完好 + 判定仍必须是 NOT READY；
  `S5b` 断言 `I1` 从来只会是 `INFO`，永不成为计分项。

## 49. 「不输出 secret」是可执行断言，不是承诺

- anon key 的任何字节都不打印，只打印 `len` / `role` / `exp` / ref 是否配对；
- project ref 打印时中段掩码（`abcd************qrst`）；
- 契约测试 `S4` 对每个 fixture 断言：checker 输出里不得出现该 fixture 的
  key 全串、前 24 字符、或 payload 段前 20 字符。

**负向控制**：临时把 P3 改成回显 key，`S4` 立刻列出 7 个 fixture 的泄漏
（`leaked 194 chars` 等），恢复后 44/44。证明这条断言会咬人。

## 50. 两处自查出来的缺陷

**(a) 扫描器漏了一种调用形态 —— 一次真正的假 READY**

首版的 Edge Function 扫描只覆盖两种形态：`/functions/v1/<name>` 与 `fn("<name>"`。
漏掉了 `A.callFn("<name>", ...)`，而这是仓库里最常见的一种：7 个函数里有 5 个
只以这种形式被调用。结果首跑报

```
P7 edge-functions  READY  all 2 called functions implemented: login-by-identifier, review-application
```

**结论碰巧是对的（7 个函数确实都存在），但过程是坏的** ——
它是在只看见 2/7 调用点的前提下说「全都实现了」。如果缺的恰好是那 5 个之一，
这条 READY 会直接放行一个缺失契约。

修法不止是补正则，还加了 `P7c` 漂移哨兵：统计调用点总数与解析出字面量名的调用点数，
差值即「变量传名」的静态盲区，如实登记为 INFO（当前 4 处，都是包装函数自身的定义）。
扫描器再次落后于代码时，这个差值会先变大。

**(b) 占位符识别只看串首**

`https://<project-ref>.supabase.co` 被判成 `INVALID`（填错了），
但它其实是 `MISSING`（没填）。两者给用户的下一步动作不同：前者去 dashboard 取值，
后者去查为什么取错。修法是增加「任意位置含 `<` 或 `>`」判据 ——
角括号在合法 URL 与 base64url token 里都不可能出现，**零误报**。
并补 `placeholder-inline.js` fixture 覆盖不含角括号的模板形态（`your-project` / `YOUR_`）。

## 51. fixture 覆盖（13 个，全离线）

`valid` · `missing` · `placeholder` · `placeholder-inline` · `no-window-supa` ·
`bad-scheme` · `bad-host` · `malformed-key` · `undecodable-key` ·
`service-role` · `wrong-role` · `expired` · `ref-mismatch`

所有 token 都是构造值，签名固定为 `fake-signature-for-tests-only`，
**不含也不可能含真实凭据**。退出码实测：仅 `valid.js` 为 0，其余 12 个均为 1。

契约测试的哨兵：
`S1` 语料非空 · `S2` 无 fixture 被漏测（目录与期望表一一对应）·
`S3` 检查器既能过也能挂（全过或全挂的检查器都是坏的）·
`S4` 无 key 泄漏 · `S5`/`S5b` 降级页不能顶成就绪。

## 52. 方法论

这一轮自己撞上了第二轮 Codex 指出过的同一类错误：**空过的变种 —— 不是「没扫到东西就通过」，
而是「只扫到一部分就宣布全体合格」**。

区别在于后者更难发现：输出是 `READY all 2 called functions implemented`，
数字、列表、措辞都自洽，只有把它和真实调用点数一对，才看得出 2 ≠ 7。

可迁移的做法是 `P7c` 那种**配额哨兵**：不只断言「扫到的都合格」，
还断言「扫到的数量 = 应该扫到的数量」，差额显式登记为盲区。
一个静态扫描器的可信度，不取决于它扫到的东西对不对，而取决于它知不知道自己漏了多少。

---
---

# 第八轮 — 访客路径可用性：键盘用户在首页就走丢

## 53. 先回到原始目标

`README.md` 对两个仓库的分工写得很明确：

> 两者同属 AMAS 亚洲宣教神学院，分工：**网站负责发现与招生，App 负责持续装备与成长。**

所以官网这一侧的成品标准不是「页面都能打开」，而是**一个陌生访客能不能顺利走完
发现 → 了解 → 申请这条路**。本轮据此检视 首页 → 课程设置 → 招生信息 / 联系我们，
挑一个压在这条路上的真实缺陷来修。

## 54. 选中的缺陷：关闭状态的移动抽屉仍在 Tab 顺序里

375px 下从页顶按 Tab，第 14 站之内的实测（修复前）：

```
   1  a.skip-link                       no                  "跳到主要内容"
   2  a.announce-item                   no                  "查看招生信息 →"
   3  a.announce-item                   YES <announce-set>  "查看招生信息 →"
   4  button.brand-seal-btn             no                  ""
   5  a.brand-name                      no                  "AMAS亚洲宣教神学院 · 清迈教学中心"
   6  button.lang-btn                   no                  "中文▾"
   7  button.theme-toggle               no                  "☀ ☾"
   8  button.menu-btn                   no                  ""
   9  button.icon-btn                   YES <mobile-drawer> "×"
  10  a                                 YES <mobile-drawer> "首页"
  11  a                                 YES <mobile-drawer> "关于我们"
  12  a                                 YES <mobile-drawer> "课程设置"

  落进 aria-hidden 子树的次数: 5
```

两处问题：

1. **第 3 站**：公告条为了无缝循环做了一份视觉副本，标了 `aria-hidden="true"`，
   但里面的「查看招生信息」链接仍可聚焦。键盘用户会在同一条链接上停两次，
   第二次落在辅助技术被告知「不存在」的元素上（axe-core 的 `aria-hidden-focus`，serious）。
2. **第 9 站起**：**整个关闭状态的移动抽屉都还在 Tab 顺序里**。
   键盘访客按到第 9 下，焦点就掉进一个看不见的菜单，此后连续十几站没有任何可见焦点 ——
   人在页面上看不到光标去了哪里，也不知道怎么出来。

**为什么选它**：这正好卡在「发现 → 招生」的必经之路上。一个用键盘的访客
（或使用读屏软件的访客）在首页第 9 次按 Tab 就失去方位，根本到不了
「咨询招生」与「申请神学学士 B.Th」这两个 CTA。这不是观感问题，是转化漏斗在最前端断掉。

### 根因

```css
.mobile-drawer{position:fixed;inset:0;z-index:80;pointer-events:none;opacity:0;transition:.2s}
```

`opacity:0` + `pointer-events:none` 对**肉眼**和**鼠标**隐藏了它，对**键盘**没有。
这两个属性都不影响可聚焦性。

## 55. 修法（2 行 CSS + 1 个属性）

```css
.mobile-drawer{...;visibility:hidden;transition:opacity .2s,visibility 0s linear .2s}
.mobile-drawer.open{...;visibility:visible;transition:opacity .2s,visibility 0s}
```

```html
<a class="announce-item" href="#admissions" tabindex="-1" data-i18n="announce.link">查看招生信息 →</a>
```

`visibility:hidden` 是少数几个既不影响布局、又能把子树移出 Tab 顺序的属性。
过渡时序是刻意写的：**开时 `0s` 立即翻转，关时延后 `.2s`** —— 原因见 §56。

**未新增任何机构性表述**：没有改一个字的招生、学费、认证或课程内容，
只动了可聚焦性与一个装饰性副本的 `tabindex`。

## 56. 修复中自己制造又消灭的一个回归

第一版只写了 `visibility:hidden` / `visible`，保留原来的 `transition:.2s`。
测试立刻挂了三条：

```
FAIL T4b focus moves into the drawer panel on open | focusInside=false
FAIL T5  focus stays trapped inside the open drawer | escapes=16
```

**这是我引入的回归，不是既有缺陷** —— 把 CSS 回滚到原状重跑，T4b/T5 都是 PASS。
先做这一步对照再动手，避免了把自己的错误当成页面的老毛病。

根因：`transition:.2s` 是 `all`，把 `visibility` 也纳入了过渡。
`openLayer()` 在加上 `.open` 的**同一 tick 内**同步调用 `first.focus()`，
此刻 `visibility` 的计算值还没翻成 `visible`，浏览器拒绝聚焦一个不可见元素，
于是焦点没进面板，焦点陷阱自然也就失效。

改成显式时序后 14/14 通过：开时 `visibility 0s`（立即可见，`.focus()` 成功），
关时 `visibility 0s linear .2s`（延后翻转，淡出动画完整保留）。

## 57. 修复后的实测

```
   1  a.skip-link            no   "跳到主要内容"
   2  a.announce-item        no   "查看招生信息 →"
   3  button.brand-seal-btn  no   ""
   4  a.brand-name           no   "AMAS亚洲宣教神学院 · 清迈教学中心"
   5  button.lang-btn        no   "中文▾"
   6  button.theme-toggle    no   "☀ ☾"
   7  button.menu-btn        no   ""
   8  button.hero-seal-btn   no   ""
   9  button.btn             no   "咨询招生→"
  10  button.btn             no   "申请神学学士 B.Th"
  11  a.ai-strip             no   "AI 定制化神学 · 3 分钟看见你的信仰成"
  12  a.text-link            no   "了解我们的异象与使命 →"

  落进 aria-hidden 子树的次数: 0
```

重复链接消失；第 8 站起焦点直接进入真实内容，**第 9、10 站就是
「咨询招生→」与「申请神学学士 B.Th」两个招生 CTA**。
这就是本轮要的效果：键盘访客现在走得到招生入口。

## 58. 回归测试：`scripts/test-drawer-a11y.mjs`（14/14 PASS）

只验「隐藏的确实退出 Tab 顺序」是不够的 —— 一个把抽屉彻底焊死的改动同样能通过。
因此同时验打开后的完整行为：

| 用例 | 断言 | 实测 |
|---|---|---|
| T0 | 反空过：往 aria-hidden 子树塞一个可聚焦元素，遍历必须抓到 | `hits=1` |
| T1 | 机制断言：关闭态 `visibility:hidden` | `visibility=hidden opacity=0` |
| T2 | 遍历确实走了足够站数（前置） | `stops=14` |
| T2b / T2c | 无一站落进 aria-hidden 子树 / 关闭的抽屉 | `hits=0` / `0` |
| T3 / T3b | 公告条本体链接仍可达；副本链接退出 Tab 顺序 | `tabIndex=-1` |
| T4 / T4b | 打开后可见且 `aria-hidden=false`；焦点移入面板 | `aria-expanded=true` |
| T5 | 焦点陷阱：连按 16 次 Tab 不逃出面板 | `escapes=0` |
| T6 / T6b | Esc 关闭并重新退出 Tab 顺序；焦点归还菜单按钮 | `restored=true` |
| T7 / T7b | 抽屉里点「招生信息」仍能跳转，且抽屉关闭 | `hash=#admissions` |

T6b 首跑是 FAIL，**这条也是器具的错**：我用 `.click()` 直接激活按钮，
`activeElement` 仍是 `body`，`openLayer` 记下的 `restoreTo` 自然就是 `body`。
真人点按钮时按钮会先获得焦点。改成「先 focus 再 click」后通过。

附带回归：全站运行时审计 **23/23 页面干净**；
`check-cache-bust.py` 5/5、`test-portal-config-check.py` 44/44、
`test-discover-back-link.mjs` 30/30 全部照旧。
截图确认抽屉打开态渲染与原先一致（遮罩、面板、全部条目）。

## 59. 同路径上发现但**本轮未修**的问题（留给排期）

诚实登记，不夹带进本轮改动：

1. **顶部公告条无法暂停**（WCAG 2.2.2 Pause/Stop/Hide）。
   `animation:announceScroll 46s linear infinite`，暂停条件只有 `.announce-bar:hover` ——
   **触屏没有 hover，键盘也用不上**。实测暂停/停止控件数量 = `0`。
   其中「查看招生信息」链接 1.2 秒内移动 32px，是一个持续移动的点击目标。
2. **`prefers-reduced-motion` 下公告条的落点可疑**。
   全局规则 `*{animation-iteration-count:1!important;animation-duration:.01ms!important}`
   会让轨道瞬间跑完并停在 `translateX(-50%)`，即停在那份 `aria-hidden` 的副本上。
   需要为公告条单独写 `animation:none`。
3. **若干触控目标偏小**：抽屉关闭按钮 `30x34`、主题切换 `34x34`、
   资源区若干 `64x26` 的「下载/查看/填写」按钮，均低于 44px 建议值。

这三项都需要独立的设计取舍（加控件、改版式），不适合塞进一次可访问性修复。

## 60. 方法论

这一轮值得记的是**如何避免把自己的错误算到页面头上**。

修完出现三条失败时，第一反应容易是「原来这页焦点管理本来就有问题」。
实际做法是把 CSS 回滚到原状再跑一遍：T4b/T5 在原状下是 PASS —— 结论立刻清楚，
是我引入的回归。这一步只花了一次测试运行的时间。

配套的一条是 §58 里 T6b 的判法：同样是失败，但回滚后**依然失败**，
说明它既不是我的回归，也未必是产品缺陷 —— 再查一层，发现是器具用
`.click()` 绕过了真实的焦点路径。

**同样是红色，回滚一次就能把它们分成三类**：我的回归、既有缺陷、器具假象。
这三类的处置完全不同，混为一谈就会要么改错地方，要么把好代码改坏。

---
---

# 第九轮 — 公告条可暂停、键盘可操作、reduced-motion 显式静止

## 61. 先更正上一轮的一条推断

第八轮 §59 第 2 条我写过：reduced-motion 下全局规则会让轨道「瞬间跑完并停在
`translateX(-50%)`，即停在那份 aria-hidden 的副本上」。

**实测是错的。** `animation-fill-mode` 默认为 `none`，动画结束后元素回到基础样式，
所以终态是 `transform: none` —— 显示的恰好就是真实的第一份内容：

```
=== 公告条探针 [prefers-reduced-motion: reduce] ===
  animation : announceScroll  1e-05s  iterations=1
  transform : none
```

这是我按 `forwards` 的行为想当然，没有实测就写进了报告。更正在此。

不过结论的方向仍然成立，只是理由换了：**这个正确结果是全局 `!important` 覆盖的副产物，
不是被声明的行为**。任何人给它补一个 `forwards`，显示的就会变成 aria-hidden 的副本，
且不会有任何测试拦住。所以仍需显式化。

## 62. 改了什么

### (1) 暂停 / 继续控件

```html
<button class="announce-toggle" type="button" id="announceToggle" aria-pressed="false">
  <span class="announce-toggle-icon" aria-hidden="true"></span>
</button>
```

原先唯一的暂停条件是 `.announce-bar:hover` —— **触屏没有 hover，键盘也用不上**，
等于没有机制（WCAG 2.2.2 Pause, Stop, Hide）。

用真 `<button>` 因此原生可聚焦、可 Enter/空格激活。状态写在 `.announce-bar` 上
（`.announce-paused`），让同一个类同时驱动动画与图标，不需要 JS 操心样式：

```css
.announce-bar.announce-paused .announce-track{animation-play-state:paused}
.announce-bar:not(.announce-paused) .announce-toggle-icon{ /* 两条竖杠 = 暂停图标 */ }
.announce-toggle-icon{ /* 三角 = 播放图标 */ }
```

图标是纯 CSS 边框画的，不引入字体或图片依赖。
`aria-label` 随状态在「暂停公告滚动 / 继续公告滚动」之间切换，四语言词条已补齐
（中 / 英 / 韩 / 泰），并挂进 `applyLanguage()` 以便切换语言时同步。

### (2) reduced-motion 显式静止

```css
@media(prefers-reduced-motion:reduce){
  .announce-track{animation:none!important;transform:none!important}
  .announce-set[aria-hidden="true"]{display:none}
  .announce-inner{overflow-x:auto;margin-right:0;padding-left:14px;padding-right:14px}
  .announce-toggle{display:none}
}
```

四件事各有理由：
- `animation:none + transform:none` —— 让「静止在第一份真实内容」成为规则而非巧合。
- 副本 `display:none` —— 静止时它毫无用处，留着只会让横向滚动里同一段话出现两次。
- `overflow-x:auto` —— 静止后视口外的内容本来就读不到，改为可横向滚动；
  这和仓库里 `.hab-reel` 在 reduced-motion 下的既有做法一致，不是新发明。
- 隐藏暂停键 —— 没有动效可暂停。

### (3) 触控尺寸

按钮 **44px 宽**，高度跟随公告条自身（实测 `44x30`）。
纵向要凑满 44px 就得加高公告条，那是改品牌版式，按指令不做。
横向达标 + 键盘可操作已是这一处能拿到的全部收益。

## 63. 文字与按钮重叠：两次才修对

320px 下按钮压住了「B.Th 招生」。第一次修法是给 `.announce-inner` 加
`padding-right:46px` 并让按钮背景 `.97` 不透明 —— **无效**：

`overflow:hidden` 在 **padding 边缘**裁切，padding 本身仍在可见区内，
滚动文字照样跑到按钮底下；`.97` 不透明留的那 3% 让高对比度金字仍然透出来。

改用 `margin-right:44px`：**margin 在 overflow 盒之外，裁切点因此提前 44px**，
文字根本到不了按钮区。按钮背景随之还原为透明（露出公告条本身的渐变），
只留一条 22px 的柔化带避免硬裁边。

这条值得记：`padding` 和 `margin` 在「预留空间」这件事上看起来等价，
遇到 `overflow:hidden` 时完全不是一回事。

## 64. 回归 `scripts/test-announce-a11y.mjs`（22/22 PASS）

| 用例 | 断言 | 实测 |
|---|---|---|
| T1 / T1b / T1c | 真 `<button>`；44px 触控宽度；`aria-pressed` + 本地化标签 | `44x30` |
| T2 | **反空过**：暂停前跑马灯确实在动 | `tx -52 -> -78` |
| T3 | Tab 可达 | 3 次按键 |
| T3b / T3c / T3d | 空格激活并暂停；`aria-pressed` 翻转；标签改为「继续」 | `playState=paused` |
| T4 | 暂停后位置真的不再变 | `tx -89 -> -89` |
| T5 | Enter 恢复播放并还原 `aria-pressed` | `running / false` |
| T6 / T6b | 只有一份内容暴露给辅助技术；副本内无可聚焦链接 | `sets=2 exposed=1` |
| T7 / T7b / T7c / T7d | 320px：按钮仍在且 44px 宽；公告条自身不溢出 | `bar=320` |
| T8–T8f | reduced-motion：`animation-name=none`、`tx 0->0`、显示真实首份、副本移除、可横向滚动、暂停键隐藏 | 全部通过 |

首跑两条失败，都是器具的错：
- **T5**：CDP 的 `rawKeyDown` 不会给按钮产生合成 click，Enter 因此没激活
  （空格是靠我额外补的 `char` 事件才生效）。改为带 `text` 的 `keyDown` 后通过。
- **T7**：只改 `Emulation.setDeviceMetricsOverride` 而不重新导航时，
  `innerWidth` 仍沿用上一次的布局宽度，所谓「320px」其实不是 320px。补重载后修正。

## 65. 顺带实测到、但**本轮不修**的一项

把视口设成 320 后 `innerWidth` 实测是 **329** —— 浏览器的 shrink-to-fit：
页面存在约 9px 的最小宽度溢出，元凶是 hero 的装饰渐变层：

```
innerWidth=329  scrollWidth=329  body=320
超过视口宽度的元素: div.sunset-glow  w=385
```

它是既有的 hero 视觉元素，与公告条无关；收紧它属于改品牌版式，按指令不做。
测试里因此只断言**公告条自身不是元凶**（`bar=320 <= vw`），并把这条如实登记。

## 66. 附带回归

全站运行时审计 **23/23 页面干净**；
`test-drawer-a11y` 14/14、`test-discover-back-link` 30/30、
`check-cache-bust` 5/5、`test-portal-config-check` 44/44。

公告条高度修改前后同为 **31px** —— 品牌版式未变。
机构文本（招生、学费、认证、课程、经文）一字未动，新增的只有按钮的辅助标签。

## 67. 方法论

这一轮最该记的是 §61：**我上一轮凭 CSS 语义推断写了一条结论，没实测，是错的。**

`animation-fill-mode` 默认 `none` 与 `forwards` 的区别，正是「动画结束后停在哪」
的全部答案。我按后者想当然，于是报告里出现了一个具体、可证伪、且错误的技术断言。
代价不大只是因为 Codex 授权了这一轮、我顺手实测了一次。

可迁移的规则很简单：**报告里写「会发生 X」时，X 必须是被观测到的，不是被推导出来的。**
推导出来的要写成「预计」，并在同一轮里补测。

---
---

# 第十轮 — 320px 横向溢出：真凶不是我上一轮说的那个

## 68. 先推翻自己的归因

第九轮 §65 我把 320px 的 9px 横向溢出判给了 hero 的装饰层：

> 元凶是 `div.sunset-glow`（`w=385`）

**这是错的。** `.sunset-glow` 在 `.hero-media` 内部，而后者有 `overflow:hidden` ——
它那 385px 的盒子被完整裁掉，从未参与文档宽度。

我错在方法上：当时用 `getBoundingClientRect().width > vw` 来筛选嫌疑元素。
**`getBoundingClientRect` 量的是元素自身盒子，不反映祖先的 `overflow` 裁切**，
所以它把一堆「盒子很宽但根本画不出来」的装饰层全列成了嫌疑人。

换成能证伪的方法 —— **逐个 `display:none` 后重量 `scrollWidth`，
只有真正撑宽文档的元素隐藏后才会让它下降**：

```
盒子右缘越界的候选元素: 38 个
隐藏后真正让 scrollWidth 变小的（= 真凶）:
   div.header-actions          -9px -> 320
   button#menuBtn.menu-btn     -9px -> 320
```

38 个嫌疑人里真凶只有 1 个，而且完全不在我上一轮点名的位置。

## 69. 真正的根因

320px 下量出来的账很清楚（`clientWidth=320`，shell 内宽 292，位于 14..306）：

| 部件 | 宽度 |
|---|---|
| `.brand`（校标 44 + 间距 9 + 品牌名 89） | **142** |
| `.header-inner` 栅格间距 | **20** |
| `.header-actions`（语言 57 + 9 + 主题 34 + 9 + 汉堡 44） | **153** |
| 合计 | **315** vs 可用 **292** |

溢出 23px，文档因此宽到 329，浏览器 shrink-to-fit 把布局视口也放宽到 329。
后果是**汉堡菜单键被顶到屏幕边缘之外，页面可以横向拖动**。

**最值得记的一点**：仓库里 `@media(max-width:380px)` 早就写了

```css
.brand-name{font-size:17px;min-width:0}          /* 允许收缩，把压缩量导向文字而非校标 */
.brand-name small{overflow:hidden;text-overflow:ellipsis}
```

作者的意图完全正确 —— 窄屏时让副标题截断。**但它从未生效**：
栅格首列是 `1fr`，其自动最小值等于 min-content，而 `.brand` 作为栅格项
没有 `min-width:0`，所以品牌列永远按 142px 的 min-content 占位，
`.brand-name` 内部那条 `min-width:0` 根本没有机会被用到。

这不是一个缺失的功能，是一个**写好了却被上游一个默认值堵死的功能**。

## 70. 修法（3 处，均为布局属性，零内容改动）

```css
@media(max-width:1250px){                 /* 切汉堡菜单的断点 */
  .header-inner{grid-template-columns:minmax(0,1fr) auto}
  .brand,.brand-name{min-width:0}
}
@media(max-width:480px){
  .brand-name small{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;...}
}
@media(max-width:380px){
  .header-inner{gap:10px}
  .header-actions{gap:8px}
}
```

- `minmax(0,1fr)` + `min-width:0` —— 把作者原本的意图接通，让品牌列真的能收缩。
- `≤480` 补省略号收尾 —— 该断点本就已是 `white-space:nowrap`，只差这一步。
- `≤380` 收紧两处间距 —— 只动间距，**不动校标尺寸、不动字号、不动三个控件的触控面积**，
  目的是让「需要截断」这件事尽量不发生。

## 71. 两个旋钮的分工（负向控制逼出来的）

写反空过控制时发现：只还原 `minmax` 而保留新间距，**溢出不会回来**。
查下去才明白两个旋钮各干了什么：

| 只做这一项 | 320px 结果 |
|---|---|
| 只收紧间距 | 315 → 303，溢出 11px，但溢的是 **shell** 不是视口，文档宽度不变 |
| 只加 minmax | 品牌列压到 119px，副标题截得更狠，但确实不溢出 |
| 两个都做 | 品牌列 131px，截断最少，且结构上不可能溢出 |

所以**间距负责「少截断」，`minmax` 负责「不可能溢出」**。
单靠间距把中文挤了进去，换一种更长的语言还会再溢 —— 这正是 T2 语言用例要证的。

负向控制因此必须同时还原两个旋钮，否则它永远变不了红：

```
PASS T0 control: reverting the shrink fix brings the overflow back
     | div.header-actions(-9), button#menuBtn.menu-btn(-9)
```

## 72. 前后对照

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `innerWidth` @ device 320 | **329**（shrink-to-fit） | **320** |
| `document.scrollWidth` | **329** | **320** |
| 汉堡键右缘 | **329**（越出视口） | **306**（在 14px 内边距内） |
| 汉堡键尺寸 | 44x44 | 44x44（未变） |
| 品牌副标题 | 视觉被硬裁 | 省略号收尾，**DOM 文本 16 字一字不少** |
| 375px / 桌面 | 无溢出 | 无溢出（未变） |

截图：`work/shots/hdr-before-320.png` · `hdr-after-320.png` ·
`hdr-before-375.png` · `hdr-after-375.png` · `hdr-after-1280.png`。

## 73. 回归 `scripts/test-header-layout.mjs`（19/19 PASS）

| 组 | 断言 |
|---|---|
| T-320 / T-375 / T-1280 | 布局视口不被 shrink-to-fit 放宽；无文档横向溢出；**用隐藏重量法确认无任何元素撑宽文档**；header 控件全在视口内 |
| T-320e / T-375e | 汉堡键保持 44x44 且不越界 |
| T0 | **负向控制**：两个旋钮一起还原后，溢出必须精确复现（`-9px` ×2） |
| T1 | **内容保全**：副标题 DOM 文本 16 字与桌面完全一致，只是视觉截断 |
| T2-en / ko / th | 切到另三种语言后 320px 仍无溢出 |

同时修正了 `test-announce-a11y.mjs` 里那条基于错误归因写下的注释，
并把 T7 断言从 `vw<=340` 收紧为 `vw<=321`。

**附带回归**：`test-announce-a11y` 22/22、`test-drawer-a11y` 14/14、
`test-discover-back-link` 30/30、`check-cache-bust` 5/5、全站运行时审计 23/23。
公告暂停键与 reduced-motion 行为均无回归。

## 74. 方法论

连着两轮，我两次在同一件事上栽跟头：**用一个测不准的量具下了结论**。

第九轮用 `getBoundingClientRect().width > vw` 找溢出源 —— 这个量具**永远不会告诉你
祖先把它裁掉了**，于是装饰层必然排在嫌疑名单最前面，而它们恰恰是最容易被裁掉的。
第十轮换成「隐藏后重量 scrollWidth」，38 个嫌疑人当场剩 1 个。

两者的差别不是精度，是**性质**：前者是相关性（盒子宽 → 可能溢出），
后者是因果性（拿掉它 → 文档真的变窄）。

可迁移的判据很简单：**当你要指认「X 导致了 Y」时，先问这个量具能不能证伪它。**
量不出「拿掉 X 后 Y 消失」的方法，就只配用来生成嫌疑人名单，不配用来结案。
