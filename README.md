# AMAS 亚洲宣教神学院 · 官网

**Asia Missionary Association Seminary — Chiang Mai, Thailand**

学院官方网站（纯静态站，GitHub Pages 发布）。四语言（中 / 英 / 韩 / 泰），含课程设置（68 门 · 7 类）、招生信息、学费与学习支持、奉献同工、数字校园、资源下载、AI 咨询助手与「定制化神学」三分钟快速测评入口。

- 🌐 线上地址：https://enoslee0701-dev.github.io/amas-website/
- 🧭 快速测评（Discover）：https://enoslee0701-dev.github.io/amas-website/discover.html

## 关联项目

| 项目 | 仓库 | 说明 |
|---|---|---|
| **AMAS App**（移动端） | [enoslee0701-dev/AMAS-Seminary](https://github.com/enoslee0701-dev/AMAS-Seminary) | React + Vite + Capacitor，课程、校友圈、语音房、口袋神学、AI 定制化神学（九维评估与成长画像） |
| **AMAS 官网**（本仓库） | enoslee0701-dev/amas-website | 对外门户与招生入口；网站上的快速测评是 App 完整评估的「Discover」层 |

两者同属 AMAS 亚洲宣教神学院，分工：**网站负责发现与招生，App 负责持续装备与成长。**

> **Source of Truth**：`discover.html`（快速测评）以本仓库为唯一权威版本；`AMAS-Seminary/public/discover.html` 仅为集成副本，改动一律先在本仓库完成再同步过去，避免双向独立修改造成漂移。
> App 链接由 `assets/js/main.js` 的 `CONFIG.app` 统一配置（地址 + deep link + source / assessment / profile 参数），`appUrl()` 负责拼装。

## 目录

```
index.html        首页（全部版块）
discover.html     定制化神学 · 3 分钟快速测评（十题九维 · 十二大成长角色）
giving.html       与我们同工（奉献，一对一联系）
login.html        登录
admin.html        管理后台（Supabase）
assets/css/       样式
assets/js/        逻辑与四语言词典
assets/img/       图片（WebP）
assets/files/     申请表、手册、课程目录（四语言）
```

## 本地预览

```bash
python -m http.server 8080
# 打开 http://localhost:8080/
```

推送到 `master` 分支后 GitHub Pages 自动发布。

## Git hooks（新克隆后需执行一次）

仓库自带 `pre-commit` hook（在 `.githooks/`），提交时自动运行 `scripts/bump.py`
给本地 css/js 引用打 `?v=<时间戳>` 做缓存刷新，并把被戳记的文件一并暂存。

`core.hooksPath` 属于本地配置、不随仓库传递，所以**每次新克隆都要执行一次**：

```bash
git config core.hooksPath .githooks
```

未执行时 hook 不会生效：提交能正常完成，但资源版本号不会自动刷新，
浏览器可能继续使用旧缓存。

> hook 的暂存列表由 `bump.py` 的 `stamped <file>` 输出推导，
> 因此在 `bump.py` 中增删页面无需同步修改 hook。

## 自动化验证

`node scripts/test-all.mjs` 是完整本地入口；不使用线上账号，也不写托管数据库。
Node 24.19、Python 3、Chrome、Deno 2.9.6；数据库测试另需仓库外安装 PGlite 0.3.7：

```bash
npm install --prefix /tmp/amas-pglite --ignore-scripts --no-audit --no-fund @electric-sql/pglite@0.3.7
PGLITE_DIR=/tmp/amas-pglite node scripts/test-all.mjs
```

可用 `--group fast|browser|sql|types|critical` 分层运行，`--list` 列出本层任务。
`DENO_BIN`、`CHROME_PATH` 可指定可执行文件；`TEST_OUT` 指定日志目录，`TEST_WORKERS=1..4`
控制独立浏览器任务并发。每套最长 12 分钟，超时、失败或缺环境均使总结果失败，不静默跳过。

数据库用一次性 PostgreSQL，每份用例均重新装迁移；项目目录一致性使用该库导出的 JSON。
测试服务器默认隔离已提交和本地旁路的 Supabase 配置；需要后端行为的浏览器用例显式提供合成数据。
`AMAS_APP_DIR` 可额外启用与相邻 App 权威课程表的离线比较，不覆盖开发者的 `course_seed.sql`。

CI 执行单元/静态、隔离 SQL、Edge 类型/HTTP 和关键浏览器旅程。完整浏览器集在本机执行；
`test-touch-targets` 的旧像素负向对照仅有 Windows/macOS 已实测基线，Linux CI 不冒用这些值。
历史 `db6_course_contract.sql` 用于 0026 后的旧数据迁移快照，不是新数据库或现行 68 门课程的验收；
其断言保留，现行课程由课程迁移、学分闭环及页面筛选检查覆盖。

浏览器 SDK 固定 2.116.0，并通过固定版本 esbuild 降到 ES2020 语法；运行
`node scripts/build-vendor-sdk.mjs` 可从固定上游包重建，`BUILD.json` 保存输入/输出哈希。
这不等于已经在所有旧浏览器上实测。Edge SDK 同样固定版本，依赖锁位于 `supabase/functions/deno.lock`。
