# Cache-busting: stamp ?v=<timestamp> on local css/js references so browsers fetch fresh assets after each deploy.
#
# 覆盖范围由「实际引用了本地 assets 的 HTML」决定，不再用硬编码清单。
# 原先的 13 项清单漏掉了 auth/recovery 与整个 portal/**（10 个页面 / 51 处引用），
# 导致 Portal 的 auth.js · api.js · ui.js · shell.js · portal.css · supabase-config.js
# 在变更后仍被浏览器按旧副本缓存 —— 而缓存戳的存在意义正是阻止这件事。
# 用扫描替代清单，新增页面自动纳入，不会再以同样方式漂移。
#
# 校验：python scripts/check-cache-bust.py（零依赖、无网络，可独立于本脚本运行）
import re, time, pathlib

v = time.strftime("%Y%m%d%H%M")
root = pathlib.Path(__file__).resolve().parent.parent
pat = re.compile(r'((?:href|src)="(?:\.\./)*assets/(?:css|js)/[^"?]+)(?:\?v=\d+)?"')

# 不扫描的目录：版本库内部、依赖、以及不参与部署的文档（docs/ 下的 HTML 不引用本地 assets）
SKIP_DIRS = {".git", ".claude", "node_modules", "docs"}


def html_files(base: pathlib.Path):
    for p in sorted(base.rglob("*.html")):
        rel = p.relative_to(base)
        if SKIP_DIRS & set(rel.parts[:-1]):
            continue
        yield p, rel.as_posix()


for p, rel in html_files(root):
    s = p.read_text(encoding="utf-8")
    n = pat.sub(lambda m: m.group(1) + "?v=" + v + '"', s)
    if n != s:
        p.write_text(n, encoding="utf-8")
        # 输出格式固定为 `stamped <相对路径>`：.githooks/pre-commit 依赖它做精确暂存。
        print("stamped", rel)
