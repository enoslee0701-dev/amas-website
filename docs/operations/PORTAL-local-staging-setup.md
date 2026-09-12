# 门户本地联调接入准备（部署前）

> **范围与边界，先说清楚**
>
> 本文只讲**本地联调**怎么接一个已有的 Supabase 环境。它不包含、也不主张：
>
> - ❌ 不等于「公开官网连 staging」——那是另一个决定，见 §5；
> - ❌ 不建立 production 环境；
> - ❌ 不含任何凭据值。本文与相关脚本**一个密钥字符都不写**。

---

## 1. 为什么需要一条专门的本地通道

`assets/js/supabase-config.js` 是**会被提交**的文件，而本仓库
**`git push origin master` 等于立即公开发布**（GitHub Pages 从 master 直发、
无构建、无任何闸门，见 `AMAS_PROJECT_HANDOFF.md` §14）。

也就是说：**把值填进那个文件，等于把配置公开。**

所以本地联调走旁路：

| 文件 | 是否提交 | 作用 |
|---|---|---|
| `assets/js/supabase-config.js` | ✅ 提交 | 保持两个值为空。发布产物用的就是它 |
| `assets/js/supabase-config.local.js` | ❌ **已 gitignore** | 本地联调实际使用的值 |
| `assets/js/supabase-config.local.example.js` | ✅ 提交 | 只有占位符的模板 |

### 两道防线，不只靠 .gitignore

1. **`.gitignore`** —— `assets/js/supabase-config.local.js` 已列入
   （`git check-ignore -v` 实测确认）。
2. **回环判据** —— `supabase-config.js` 里那段旁路加载**只在
   `127.0.0.1` / `localhost` / `[::1]` 上执行**。
   就算旁路文件哪天被误提交，线上域名也不满足条件，不会去加载它。

第 2 道由 `scripts/test-local-config-override.mjs` **15/15** 钉住，
其中 C 组专门模拟「发布站点」（非回环主机名）验证旁路**完全不生效**。

---

## 2. 接入检查清单

### 第 0 步：先确认要连哪个环境

**这是唯一必须由人决定的事，见 §5。** 在拿到明确答复之前不要往下走 ——
猜一个环境去连，轻则白忙，重则打到不该打的库上。

### 第 1 步：取值

从 Supabase 控制台 → **Settings → API**：

| 要取 | 说明 |
|---|---|
| **Project URL** | 形如 `https://<project-ref>.supabase.co` |
| **anon public key** | 标着 `anon` `public` 的那一个 |

> ⚠ **只取 anon key。** `service_role` key 绕过 RLS，一旦出现在浏览器可读的
> 文件里就等于把整个库交出去。`check-portal-config.py` 会把它判为 **BLOCKED**
> 并提示立即轮换 —— 实测确认该判据有效。
>
> ⚠ **不要从 App 仓的生产配置复制。** 那是另一个环境，混用会让本地联调打到
> 不该打的库上。

### 第 2 步：落到本地旁路文件

```sh
cp assets/js/supabase-config.local.example.js \
   assets/js/supabase-config.local.js
# 编辑它，填入上一步的两个值
```

### 第 3 步：离线自检（不连网，不登录）

```sh
python scripts/check-portal-config.py --local
```

它会检查形状而不是连通性：URL 是否 https、project ref 与 key 里的 ref 是否
一致、key 是不是 anon 角色、是否过期、是否还是占位符。
**通过 ≠ 环境可用**，只代表「填的东西形状对」。

### 第 4 步：确认旁路只在本地生效

```sh
node scripts/test-local-config-override.mjs      # 应 15/15
```

### 第 5 步：起本地预览

```sh
python -m http.server 8787 --bind 127.0.0.1 --directory <站点目录>
```

打开 `http://127.0.0.1:8787/portal/student/`。此时门户应当**不再**显示
「门户系统尚未启用」，而是走真实守卫（未登录会跳登录页）。

### 第 6 步：确认没有把配置带进提交

```sh
git status --porcelain assets/js/      # 不应出现 supabase-config.local.js
git check-ignore -v assets/js/supabase-config.local.js   # 应命中 .gitignore
```

---

## 3. 联调前必须知道的现有阻塞

来自 `STAGING-0-READINESS-REPORT.md`（只读查阅，未执行任何远端操作）。
汇总：**READY 7 · NEEDS_OWNER 5 · BLOCKED 2 · NOT_REQUIRED 4**。

与本仓门户**直接相关**的几项：

| # | 项 | 状态 | 报告怎么说 |
|---|---|---|---|
| 1 | Staging Supabase project 存在 | **NEEDS_OWNER** | 本地 CLI 缓存证实它**曾存在**（PG 17.6.1.166、`ap-southeast-1`），但「本机无访问令牌，**无法核实当前是否仍存活**」 |
| 2 | credentials 已配置 | **NEEDS_OWNER** | 本地 `SUPABASE_*` 全部 `NOT CONFIGURED` |
| 5 | `0001–0026` 已应用 | **BLOCKED** | 依赖 1、2 |
| 7 | SMTP 已配置 | **NEEDS_OWNER** | 或明确选择方案 B（`mailer_autoconfirm = true`）并标注为未验证 |
| 9 | frontend staging 目标存在 | **NEEDS_OWNER** | — |

> 报告自己强调：两个 `BLOCKED` **都只是依赖前面的 `NEEDS_OWNER`，不是技术难题**。

### 对本地联调意味着什么

- 第 1、2 项没解决之前，**拿不到可填的值**，第 1 步就走不下去。
- 第 7 项若选方案 B，注册/找回密码的邮件流程**必须显式标注为未验证**，
  绝不能写成「邮件流程通过」——这是报告 §11 的明文要求。

---

## 4. 联调时的行为边界

本地联调连上真实环境之后，仍然适用：

- **不创建真实身份**。需要账号时由 Owner 提供合成测试账号，
  不要用真人邮箱注册。
- **不查询私人数据**。RLS 会挡住别人的数据，但「挡得住」不等于「可以去试」。
- **不做远端写入**，除非是 Owner 明确要求验证的那一次。
- **service_role key 永不进前端**（报告 §secret 分级：高敏，只进 CI
  protected secret 与平台 secret）。

---

## 5. 仍需监督决定的那一项

**本 Web 检出的门户，本地联调应当连哪一个 Supabase 环境？**

现有材料能说明的：

| 材料 | 说了什么 |
|---|---|
| `AMAS_PROJECT_HANDOFF.md` §15 环境矩阵 | Staging「运行中」（`amas-staging`、`ap-southeast-1`、PG 17.6）；Production **`NOT ESTABLISHED`** |
| `AMAS_PROJECT_HANDOFF.md` §14 部署现实 | Website 从 master 直发；Supabase 一栏记 staging 已部署 |
| `STAGING-0-READINESS-REPORT.md` 入场清单 | staging 是否**仍存活**需 Owner 确认（见 §3 第 1 项） |

**材料里没有的**：没有任何一处写明「官网门户本地联调应当连 staging」。
这是部署决策，不能从文档推出来，也不该由我替院方决定。

### 需要提供的最少一项

> **一个可用于本地联调的 Supabase 环境的 Project URL 与 anon public key。**

**安全的提供方式**（按优先级）：

1. **不要发到聊天或写进报告。** 直接由 Owner 在本机执行：
   ```sh
   cp assets/js/supabase-config.local.example.js \
      assets/js/supabase-config.local.js
   # 在编辑器里填入两个值
   python scripts/check-portal-config.py --local   # 自检形状
   ```
   该文件已 gitignore，填完即可联调，值始终不离开本机。
2. 若必须传递，用团队既有的 secret 通道（报告 §secret 模型列的
   「CI protected secret」或平台 secret），**不要用聊天、邮件或工单**。

拿到之后，本轮准备好的东西可以直接用，无需再改代码。

---

## 6. 本轮已准备好、可审阅的产物

| 产物 | 说明 |
|---|---|
| `assets/js/supabase-config.local.example.js` | 模板，只有占位符 |
| `assets/js/supabase-config.js` 的旁路加载段 | 只在回环地址生效；无旁路文件时静默保持空配置 |
| `.gitignore` 新增一行 | `assets/js/supabase-config.local.js` |
| `scripts/check-portal-config.py --local` | 离线形状自检；通过时明确提示「不代表发布就绪」 |
| `scripts/test-local-config-override.mjs` | **15/15**，含「非回环主机上旁路必须不生效」与 2 条负向控制 |
| 本文档 | 接入清单与边界 |

**全程未真实登录、未创建身份、未查询任何数据、未对远端写入、零外网请求；
本文与所有脚本不含任何凭据值。**
