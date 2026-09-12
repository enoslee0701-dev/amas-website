#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全站内链完整性：页面与脚本里指向的站内路径，目标文件是否真的存在。

为什么需要这条检查
------------------
`assets/js/portal/shell.js` 自己写着「只放确实存在且有真实内容的页面…宁可少一个
入口，也不做点进去空无一物的假页面」，但它的 NAV 里有三个入口指向并不存在的目录。
这类缺陷**在本地是看不出来的**：门户导航只在 Supabase 配置齐全且用户已登录之后
才渲染，而那两个条件今天都不成立 —— 也就是说它会在后端开通的第一天才爆出来。
所以需要一条静态检查把它钉住。

判据
----
只检查**站内相对路径**。外部 http(s)、mailto、tel、纯锚点 #x、javascript: 一律跳过。
目录形式（以 / 结尾）要求该目录下存在 index.html。
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SKIP_PREFIX = ("http://", "https://", "//", "mailto:", "tel:", "javascript:", "data:", "#")
# 这些目录不参与扫描
SKIP_DIRS = {".git", ".claude", "node_modules", "supabase", "docs", "scripts"}

def iter_files(exts):
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for f in files:
            if f.lower().endswith(exts):
                yield os.path.join(base, f)

def resolve(src_file, ref):
    """把一个引用解析成磁盘路径。返回 (路径, 是否存在)。"""
    ref = ref.split("#")[0].split("?")[0]
    if not ref:
        return None, True
    if ref.startswith("/"):
        target = os.path.join(ROOT, ref.lstrip("/"))
    else:
        target = os.path.join(os.path.dirname(src_file), ref)
    target = os.path.normpath(target)
    if ref.endswith("/") or os.path.isdir(target):
        target = os.path.join(target, "index.html")
    return target, os.path.isfile(target)

HREF_RE = re.compile(r'(?:href|src)\s*=\s*"([^"]+)"')
SCRIPT_RE = re.compile(r"<script[^>]*>.*?</script>", re.S | re.I)
# JS 拼接出来的片段不是链接。首版没剥 <script> 块，于是把
#   '" + A.ROOT + "help/'   这类中间产物当成了 9 个「坏链」——
# 其中 help/ 等目标其实都存在。量具自己制造的假红比漏报更糟，所以必须剥掉。
CONCAT_MARKS = ("'", '"', "+", "${", "`")

def looks_like_js_fragment(ref):
    return any(m in ref for m in CONCAT_MARKS)
# shell.js 的 NAV 用 href: "portal/xxx/" 的形式写在 JS 对象里
NAV_RE = re.compile(r'href:\s*"([^"]+)"')

broken = []
checked = 0

# ---- HTML ----
for path in iter_files((".html",)):
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    text = SCRIPT_RE.sub("", text)        # 先剥掉内联脚本，避免把 JS 拼接当链接
    for ref in HREF_RE.findall(text):
        if ref.startswith(SKIP_PREFIX) or looks_like_js_fragment(ref):
            continue
        checked += 1
        target, exists = resolve(path, ref)
        if not exists:
            broken.append((os.path.relpath(path, ROOT), ref, "目标不存在"))

# ---- portal/shell.js 的 NAV：相对站点根 ----
shell = os.path.join(ROOT, "assets", "js", "portal", "shell.js")
if os.path.isfile(shell):
    with open(shell, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    for ref in NAV_RE.findall(text):
        if ref.startswith(SKIP_PREFIX) or looks_like_js_fragment(ref):
            continue
        checked += 1
        target = os.path.normpath(os.path.join(ROOT, ref))
        if ref.endswith("/") or os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            broken.append(("assets/js/portal/shell.js", ref,
                           "门户导航指向不存在的页面（登录后才会暴露）"))

print("=== INTERNAL LINK CHECK ===")
print("检查了 %d 个站内引用" % checked)
if not broken:
    print("PASS 全部站内引用都有对应文件")
    sys.exit(0)

print("FAIL 有 %d 个引用指向不存在的目标：" % len(broken))
for src, ref, why in broken:
    print("  %-34s -> %-34s %s" % (src, ref, why))
sys.exit(1)
