# Cache-busting: stamp ?v=<timestamp> on local css/js references so browsers fetch fresh assets after each deploy.
#
# 覆盖范围由「实际引用了本地 assets 的 HTML」决定，不再用硬编码清单。
# 原先的 13 项清单漏掉了 auth/recovery 与整个 portal/**（10 个页面 / 51 处引用），
# 导致 Portal 的 auth.js · api.js · ui.js · shell.js · portal.css · supabase-config.js
# 在变更后仍被浏览器按旧副本缓存 —— 而缓存戳的存在意义正是阻止这件事。
#
# ── 为什么本脚本自带 GUARD（在任何写入之前）────────────────────────────
# .githooks/pre-commit 会把本脚本报告为已改动的文件**自动暂存**。
# 于是「打戳」这个动作会连带把工作区里**未暂存的内容**一起送进提交：
#
#   index.html 已 add（意图变更 A），随后又被改出一段未暂存的私稿 B
#   → 本脚本读工作区（A+B）打戳并写回
#   → hook 对整文件暂存
#   → 私稿 B 被提交            ← 污染
#
# 同一机制还有第二条路径：全量扫描会覆盖**未跟踪**的 HTML，
# 打戳后被 hook 暂存，等于把一个作者没打算提交的新文件带进提交。
# （这条是覆盖范围从清单改为扫描时引入的，硬编码清单时代不存在。）
#
# 因此在**写入任何文件之前**先做一次检查，不安全就整体拒绝，并列出确切路径。
# 刻意不做 stash / reset / checkout / 丢弃工作区，也不做整目录暂存 ——
# 那些都会替作者做他没要求的决定。拒绝 + 报路径，让作者自己处置。
#
# ── 为什么运行时输出全是 ASCII ────────────────────────────────────────
# 这条拒绝消息会流经 git 的 stderr、Windows 控制台代码页，以及外部采集脚本。
# 非 ASCII 在 GBK 环境下会让整条流解码失败 —— 而这条消息的全部价值
# 就在于把确切路径交到人手上，解不出来等于没给。注释与文档保持中文。
#
# 用法：
#   python scripts/bump.py              先 GUARD，安全则打戳（hook 用的就是这个）
#   python scripts/bump.py --list       只列出候选文件，不检查、不写入
#   python scripts/bump.py --guard-only 只检查，不写入（退出码即结论）
#
# 退出码：0 正常；2 GUARD 拒绝（未做任何写入）。
# 校验：python scripts/check-cache-bust.py [--from-index]
import re
import subprocess
import sys
import time
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAT = re.compile(r'((?:href|src)="(?:\.\./)*assets/(?:css|js)/[^"?]+)(?:\?v=\d+)?"')
# 只用来判断「这个 HTML 是否引用了本地 assets」，与 PAT 的改写口径保持一致。
HAS_LOCAL_ASSET = re.compile(r'(?:href|src)="(?:\.\./)*assets/(?:css|js)/')
SKIP_DIRS = {".git", ".claude", "node_modules", "docs"}


def candidates():
    """实际引用了本地 assets 的 HTML，相对仓库根、正斜杠。"""
    out = []
    for p in sorted(ROOT.rglob("*.html")):
        rel = p.relative_to(ROOT)
        if SKIP_DIRS & set(rel.parts[:-1]):
            continue
        if HAS_LOCAL_ASSET.search(p.read_text(encoding="utf-8", errors="replace")):
            out.append(rel.as_posix())
    return out


def _vcs(*args):
    return subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True,
                          text=True, encoding="utf-8", errors="replace")


def inside_work_tree():
    r = _vcs("rev-parse", "--is-inside-work-tree")
    return r.returncode == 0 and r.stdout.strip() == "true"


def guard(paths):
    """返回 (untracked, unstaged)。两者皆空才算安全。"""
    if not paths:
        return [], []
    untracked = _vcs("ls-files", "--others", "--exclude-standard", "--", *paths).stdout.split()
    # index 与工作区之间的差异 = 未暂存改动（含「已暂存后又改」的部分暂存场景）
    unstaged = _vcs("diff", "--name-only", "--", *paths).stdout.split()
    return sorted(set(untracked)), sorted(set(unstaged))


def report_and_refuse(untracked, unstaged):
    e = sys.stderr
    e.write("bump.py: REFUSED - stamping would let pre-commit auto-stage unstaged content.\n")
    e.write("         No file was modified. Working tree and index are unchanged.\n")
    if unstaged:
        e.write("\n  UNSTAGED changes (includes partially-staged files):\n")
        for item in unstaged:
            e.write("    BLOCKED unstaged  %s\n" % item)
    if untracked:
        e.write("\n  UNTRACKED (stamping would add them as new files):\n")
        for item in untracked:
            e.write("    BLOCKED untracked %s\n" % item)
    e.write("\n  Resolve it yourself - this script will not decide for you:\n")
    e.write("    * belongs in this commit -> stage it, then commit again\n")
    e.write("    * does not belong        -> move it out of the working tree first\n")
    e.write("    * untracked              -> track it explicitly, or add to .gitignore\n")
    e.write("\n  Check without writing: python scripts/bump.py --guard-only\n")


def main() -> int:
    args = sys.argv[1:]
    cands = candidates()

    if "--list" in args:
        for c in cands:
            print(c)
        return 0

    guard_only = "--guard-only" in args

    # ── GUARD：在任何写入之前 ────────────────────────────────────────
    if inside_work_tree():
        untracked, unstaged = guard(cands)
        if untracked or unstaged:
            report_and_refuse(untracked, unstaged)
            return 2
    # 不在版本库工作区里时没有暂存可污染，直接放行（便于独立使用与 fixture 测试）。

    if guard_only:
        return 0

    # ── 写入 ────────────────────────────────────────────────────────
    v = time.strftime("%Y%m%d%H%M")
    for rel in cands:
        p = ROOT / rel
        s = p.read_text(encoding="utf-8")
        n = PAT.sub(lambda m: m.group(1) + "?v=" + v + '"', s)
        if n != s:
            p.write_text(n, encoding="utf-8")
            # 输出格式固定为 `stamped <相对路径>`：.githooks/pre-commit 依赖它做精确暂存。
            print("stamped", rel)
    return 0


if __name__ == "__main__":
    sys.exit(main())
