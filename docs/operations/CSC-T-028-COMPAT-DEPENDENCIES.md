# 浏览器兼容性：未满足的依赖与 NOT_RUN 清单（T-028）

读者：Luna / Enos。复核对象是 `CSC-T-023-BROWSER-COMPAT-SCOPE.md`。本清单**只列依赖和没跑的检查**：没有执行发布，没有下载外部包，没有更改本机设置。
复核时间 2026-09-16，分支 `csc/2026-09-14`。每项状态都是当天用只读方式核对的，核对方法写在「依据」列里。

## 实际跑过的（作为对照）

只有 Chromium：本机 Google Chrome 153.0.8010.48，headless 模式，63 支探针，移动与桌面视口模拟。另外 Playwright 缓存里只有 `chromium-1234` 和 `chromium_headless_shell-1234`，没有 webkit 或 firefox。

## 一、未满足的依赖

| 编号 | 依赖 | 当前状态 | 依据（只读核对） | 挡住了什么 | 谁能解开 |
|---|---|---|---|---|---|
| D1 | 目标浏览器矩阵（支持哪些浏览器、最低版本） | **未满足** | 仓库里没有 browserslist；`git grep` 搜「目标浏览器 / 浏览器矩阵」只命中报告自己提到这件事的地方，没有矩阵本身 | 所有「兼容 / 不兼容」的结论；N5、N8 的判定标准 | **Enos**（业务决定） |
| D2 | Safari 远程自动化已开启 | **未确认开启** | safaridriver 存在（`/System/Cryptexes/App/usr/bin/safaridriver`）；Safari 26.6.2，macOS 26.6.2；`defaults read com.apple.Safari AllowRemoteAutomation` 返回「该键不存在」 | N1 | **Enos**：在 Safari 设置里开启；`safaridriver --enable` 需要管理员授权 |
| D3 | Firefox 引擎 | **未满足** | `/Applications` 下没有 Firefox；`which firefox geckodriver` 都找不到；Playwright 缓存里没有 firefox | N2 | **Enos**：安装新软件属于环境变更 |
| D4 | 真机与内置浏览器（iOS Safari、Android WebView、微信 / QQ / LINE） | **未满足** | 本机没有这些设备或环境 | N3、N4、N5 | 需要安排人和设备 |
| D5 | supabase-js 2.116.0 UMD 包本身的语法级别 | **未核** | 仓库里没有这个包的本地副本（`find` 只找到三个 supabase-config*.js 配置文件）；22 个页面都从 jsdelivr 加载 | N6 | **Luna** 决定是否允许从外网取包做离线核对 |
| D6 | T-023 报告里各特性版本号的逐项复核 | **未核** | 报告里的版本号是常识性下限，没有对照 MDN / caniuse 核对 | N7 | **Luna** 决定是否允许外部查阅 |
| D7 | C3：`backdrop-filter` 补 `-webkit-` 前缀 | **未落地** | main.css 7 行、portal.css 2 行、discover.html 1 行用了 `backdrop-filter`，带 `-webkit-` 前缀的是 **0** | N9 | 没有外部依赖，**可以直接入队**（GREEN） |
| D8 | C2：静态特性下限检查脚本 | **未落地** | `scripts/` 下没有 feature / compat 类脚本 | N8 | 依赖 D1；在 D1 之前可以先做「现状即基线、不许新增」的版本 |

## 二、NOT_RUN（没有跑的检查）

| 编号 | 检查 | 状态 | 被哪个依赖挡住 |
|---|---|---|---|
| N1 | Safari / WebKit 冒烟（首页、登录、门户降级页、discover） | NOT_RUN | D2 |
| N2 | Firefox 冒烟 | NOT_RUN | D3 |
| N3 | iOS Safari 真机（重点：没有 `-webkit-` 前缀的毛玻璃效果、`inset` 弹窗、`:focus-visible`） | NOT_RUN | D4 |
| N4 | Android WebView，以及微信 / QQ / LINE 内置浏览器（重点：`?.` / `??` 语法下限） | NOT_RUN | D4 |
| N5 | 旧版本行为验证（例如 Chrome 80~104、Safari 13.1~15.3） | NOT_RUN | D1（先定要不要支持）+ D4 |
| N6 | supabase-js UMD 语法下限核对 | NOT_RUN | D5 |
| N7 | 特性版本号逐项复核 | NOT_RUN | D6 |
| N8 | 静态特性下限检查（C2） | NOT_RUN | D1（基线版可以先做） |
| N9 | 补前缀之后的视觉回归（C3） | NOT_RUN | D7 还没入队 |

## 三、不需要等任何人、可以直接入队的

- D7 / C3：补 `-webkit-backdrop-filter`，附一条静态检查（每个 `backdrop-filter` 都要有同值的前缀）。
- D8 / C2 的基线版：把当前扫描到的特性集合固定为基线，新增更高门槛的特性就失败。

其余各项都需要 Enos 或 Luna 先做决定或提供环境。
