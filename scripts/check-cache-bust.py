# 缓存戳覆盖率校验 —— 纯静态、零依赖、无网络、不碰数据库。
#
# 为什么需要它：官网仓库的 30 套验收测试（12 个 .mjs + 18 个 .sql）全部需要
# staging.env 或数据库连接，因此本地没有任何可无条件运行的验证入口。
# 本脚本是其中一项可以完全本地判定的契约，独立于 scripts/bump.py 实现，
# 这样 stamper 自身的覆盖漏洞不会同时让校验失效。
#
# 断言：
#   C1  每一处指向本地 assets/css|js 的 HTML 引用都带 ?v= 缓存戳
#   C2  全站戳记值唯一（多值意味着某些页面漏戳后又被单独补戳，仍是漂移）
#
# 运行：python scripts/check-cache-bust.py
# 退出码：0 全过；1 有失败项。
import re, sys, pathlib
from collections import defaultdict

root = pathlib.Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", ".claude", "node_modules", "docs"}
REF = re.compile(r'<(?:script|link)[^>]*?(?:src|href)="([^"]+)"')
LOCAL_ASSET = re.compile(r'\.(?:js|css)(?:\?|$)')
STAMP = re.compile(r'\?v=(\d+)')

refs = []
for p in sorted(root.rglob("*.html")):
    rel = p.relative_to(root)
    if SKIP_DIRS & set(rel.parts[:-1]):
        continue
    text = p.read_text(encoding="utf-8", errors="replace")
    for url in REF.findall(text):
        if url.startswith(("http://", "https://", "//", "#", "mailto:", "data:")):
            continue
        if not LOCAL_ASSET.search(url):
            continue
        refs.append((rel.as_posix(), url))

unstamped = [(f, u) for f, u in refs if "?v=" not in u]
stamps = defaultdict(list)
for f, u in refs:
    m = STAMP.search(u)
    if m:
        stamps[m.group(1)].append(f)

results = []


def rec(cid, name, ok, detail=""):
    results.append(ok)
    print("%s %s %s%s" % ("PASS" if ok else "FAIL", cid, name, (" | " + detail) if detail else ""))


rec("C1", "所有本地 js/css 引用均带缓存戳", not unstamped,
    "refs=%d unstamped=%d" % (len(refs), len(unstamped)))
if unstamped:
    for f, u in unstamped:
        print("       缺戳: %-40s %s" % (f, u))

rec("C2", "全站戳记值唯一", len(stamps) <= 1,
    "values=%s" % (sorted(stamps) if stamps else "(none)"))
if len(stamps) > 1:
    for v in sorted(stamps):
        print("       %s -> %d 处: %s" % (v, len(stamps[v]), ", ".join(sorted(set(stamps[v]))[:4])))

passed = sum(1 for r in results if r)
print("\n=== CACHE-BUST 覆盖: %d/%d PASSED ===" % (passed, len(results)))
sys.exit(0 if passed == len(results) else 1)
