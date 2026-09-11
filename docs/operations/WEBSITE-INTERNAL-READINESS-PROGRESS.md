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
