# 发布前浏览器兼容性检查范围盘点（T-023）

读者：Luna / Enos。分支 `csc/2026-09-14`。**只做盘点**：没有改页面，没有发布，也没有碰任何真实数据或账号。

## 一、现状：我们实际测过什么

| 维度 | 现状 | 依据 |
|---|---|---|
| 浏览器引擎 | **只有 Chromium**。63 支浏览器探针全部基于本机 headless Chrome（lib/chrome-launcher 或写死的 Chrome 路径） | `git grep launchOwnChrome\|Google Chrome -- scripts/*.mjs` |
| WebKit / Safari | 0 支。本机装有 Safari 和 safaridriver，但没有任何脚本用它 | `/Applications/Safari.app`、`/System/Cryptexes/App/usr/bin/safaridriver` |
| Firefox | 0 支，本机也没有装 | — |
| 视口 | 以移动端模拟为主：375×780（20 处）、390×820（9 处）、320 宽（4 处）、420 宽（3 处）；桌面 900 / 1100 / 1280 宽共 6 处 | 探针里的 `setDeviceMetricsOverride` |
| 真机、旧版本、内置浏览器 | 都没有测过（iOS Safari、Android WebView、微信 / QQ / LINE 内置浏览器） | — |
| 目标浏览器定义 | **仓库里没有**：没有 browserslist，没有 package.json，文档里也没有写支持范围 | `git grep -i browserslist\|兼容\|safari -- docs README.md` |

交接文档 D-33 写着「目标版本验证不可用『理论兼容』替代」。下面第二节的特性表就属于理论兼容，只能用来**圈定要测什么**，不能当成验收结论。

## 二、站点代码用到的、有版本门槛的特性

范围：git 跟踪的 `assets/**/*.js`、`assets/**/*.css`，以及所有 HTML（不含 docs/）的内联 `<script>`、`<style>` 和 `style=""`。共 36 段 JS、210 段 CSS。方法是一次性正则扫描（先剥掉注释），数字表示出现在几个文件里。

**版本号是按常见资料（MDN / caniuse）整理的下限印象，没有逐项核对。入队前要逐项复核。**

### JS（不支持时整段脚本解析失败或抛错，是**硬下限**）

| 特性 | 文件数 | 大致最低版本 Chrome / Safari / Firefox | 不支持时 |
|---|---|---|---|
| 可选链 `?.` | 11（含 main.js、portal/api.js、shell.js、ui.js） | 80 / 13.1 / 74 | **整个脚本解析失败**，页面交互全部失效 |
| 空值合并 `??` | 5（含 main.js、ui.js） | 80 / 13.1 / 72 | 同上 |
| `String#replaceAll` | 1（main.js） | 85 / 13.1 / 77 | 运行到那一行时抛错 |
| `Object.fromEntries` | 8 | 73 / 12.1 / 63 | 抛错 |
| `focus({preventScroll})` | 3 | 64 / 15 / 68 | 参数被忽略，焦点移动时页面会滚动（功能正常） |
| `navigator.clipboard` | 3 | 66 / 13.1 / 63，且只在 HTTPS 下可用 | 复制按钮失效 |
| `IntersectionObserver` | 2 | 51 / 12.1 / 55 | 抛错 |
| `AbortController` | 2 | 66 / 12.1 / 57 | 抛错 |
| async/await、箭头函数、模板字符串 | 27~28 | 55 / 11 / 52 | 解析失败 |
| 同步 XHR（supabase-config.js 的本地旁路） | 1 | 只在本机回环地址执行 | 发布站点上不执行 |

生产代码里**没有**用到：`requestSubmit`、`dialog.showModal`、`inert`、`structuredClone`、`Array#at`、`Object.hasOwn`、`AbortSignal.timeout`、`crypto.randomUUID`、私有字段、逻辑赋值（`requestSubmit` 只出现在测试脚本里）。

另外有一项**没有核对**：supabase-js 2.116.0 UMD 包本身编译到的语法级别。门户页的实际下限取「站点脚本」和「这个包」两者中较高的那个。

### CSS（不支持时通常只丢掉这一条规则，是**软下限**）

| 特性 | 位置 | 大致最低版本 Chrome / Safari / Firefox | 不支持时 |
|---|---|---|---|
| `:has()` | main.css:942（招生胶囊在卡片展开时隐藏） | 105 / 15.4 / 121 | 注释里写明回退为「被卡片盖住」，也就是改动之前的样子 —— 低风险 |
| `inset:` | main.css（`.modal`、`.modal-backdrop`、`.faq-section::after`）、portal.css（门户确认弹窗 `.portal-modal`、`.pm-backdrop`，以及 `body::before`）、discover.html | 87 / 14.1 / 66 | 弹窗和遮罩没有尺寸，**可能盖不住页面，确认弹窗的位置也可能不对** —— 中风险 |
| flex `gap` | 17 个文件 | 84 / 14.1 / 63 | 按钮和栏目之间没有间距，挤在一起 —— 中风险（观感） |
| `aspect-ratio` | main.css:181 `.image-wrap` | 88 / 15 / 89 | 图片按原比例显示，不裁成 16:7 —— 低风险 |
| `:focus-visible` | main.css、portal.css、discover.html | 86 / 15.4 / 85 | 整条规则被丢掉，**键盘焦点框不显示** —— 可访问性风险 |
| `backdrop-filter`（没有 `-webkit-` 前缀） | main.css 7 处、portal.css 2 处、discover.html | 76 / 18（带前缀的版本 Safari 9 起就有）/ 103 | 没有毛玻璃效果；背景本身是 .82~.97 的半透明色，可读性不受影响 —— 低风险，但 **iOS 18 以下的 Safari 全部命中** |
| `clamp()` | main.css | 79 / 13.1 / 75 | 这条声明失效 |
| `scroll-behavior` | main.css:20 | 61 / 15.4 / 36 | 锚点跳转没有平滑滚动 —— 低风险 |
| `env(safe-area-inset-*)` | main.css、portal.css、discover.html | 69 / 11.1 / 65 | 刘海屏底栏可能被遮住一点 |

### 粗略结论（仍然是理论推断，需要实测）

- **整站能不能用**的下限大约是 Chrome 80 / Safari 13.1（iOS 13.4）/ Firefox 74，由 `?.` 和 `??` 决定。
- **观感完全符合设计**需要大约 Chrome 105 / Safari 15.4 / Firefox 121。其中 `backdrop-filter` 在 Safari 上要到 18 才生效。
- 学员主要在泰国和中国大陆，**内置浏览器**（微信、QQ、LINE）和**旧版 Android WebView** 所用的内核版本本地无法确定，是最大的未知项。

## 三、本地能做的和做不了的

| 能在本机做 | 做不了（需要人、设备或业务决定） |
|---|---|
| 对 JS / CSS 做静态特性扫描，和约定的下限比较 | 决定**支持哪些浏览器、最低到哪个版本**（业务决定） |
| 用 Chromium 模拟各种视口（已经在做） | iOS Safari 真机、微信 / LINE 内置浏览器、旧 Android WebView 实测 |
| 用 safaridriver 驱动本机 Safari 做冒烟 —— **需要先在 Safari 里打开「允许远程自动化」**，这是本机设置，要 Enos 同意并操作 | Firefox 实测（本机没装；装新软件属于环境变更） |

## 四、有界候选任务

| 编号 | 任务 | 验收 | 建议级别 |
|---|---|---|---|
| C1 | 定下目标浏览器矩阵（例如「iOS Safari ≥ 15.4、Android Chrome ≥ 100、微信内置浏览器当前版本」），写进 docs | 文档里有一张明确的矩阵表，并由 Enos 确认 | **需要 Enos 决定**，不能由 Claude 自行定 |
| C2 | 静态「语法与特性下限」检查：扫描站点 JS / CSS，出现超出 C1 矩阵的特性就失败；附负向夹具 | 本地脚本退出码 0；夹具里放一个超出下限的特性时退出码 1 | GREEN（依赖 C1 给出下限；在 C1 之前可以先按「现状即基线、不许新增」来做） |
| C3 | 补上 `-webkit-backdrop-filter` 前缀（main.css 7 处、portal.css 2 处、discover.html） | 静态检查确认每个 `backdrop-filter` 都带同值前缀；Chromium 视觉回归不变 | GREEN |
| C4 | Safari（WebKit）冒烟：用 safaridriver 打开首页、登录、门户降级页、discover 共 4 页，检查无脚本错误、关键元素可见 | 4 页各自退出码 0，结果写入报告 | 需要 Enos 先打开 Safari 远程自动化，之后才是 GREEN |

建议顺序：先定 C1，然后 C3（最小、最确定），再 C2，最后 C4。**真机和内置浏览器的验收**不在这四条范围内，需要另外安排人和设备。
