# 缓存戳契约校验 —— 纯静态、零依赖、无网络、不碰数据库。
#
# 为什么需要它：官网仓库的 30 套验收测试（12 个 .mjs + 18 个 .sql）全部需要
# staging.env 或数据库连接，且仓库没有 .github，因此本地没有任何可无条件运行的
# 验证入口。本脚本是其中一项可完全本地判定的契约，**独立于 scripts/bump.py 实现**
# （自己扫描、自己解析），否则就是用同一个错误去检查它自己。
#
# ── 断言 ─────────────────────────────────────────────────────────────
#   C0  扫描非空（页面数 > 0 且可判定引用数 > 0）
#       没有这一条，一次路径写错或正则失配就会「零引用 → 全部通过」，
#       得到一个空过的绿灯。这是本校验最容易出的假阳性，故列为第一条。
#   C1  每一处本地 assets/css|js 引用都带**格式合法**的戳：?v=<12 位数字>，
#       且闭合引号前不得有其它内容。
#       ★ 空戳 `?v=`、非数字戳 `?v=abc`、长度不符、附加参数一律判为 FAIL。
#         原因不是洁癖：bump.py 的改写正则中 [^"?]+ 在 ? 处停下，随后的可选组
#         只接受全数字。遇到畸形戳时整条匹配失败 —— 该引用**既不会被戳、
#         也不会被重戳**，成为永久静默盲区。畸形戳比没有戳更危险，
#         因为它看起来像已经处理过了。
#   C2  全站戳记值唯一。多值意味着某些页面漏戳后被单独补戳，仍是漂移。
#   C3  本地 assets 引用不得使用 bump.py 无法处理的引号形态（单引号 / 无引号）。
#       stamper 只认双引号；出现其它形态则该引用永远不会被戳，
#       而校验若也照着同样的口径扫描就会一起看不见。故这里放宽扫描、收紧断言。
#   C4  stamper 与本校验的版本格式未漂移（bump.py 仍用 %Y%m%d%H%M = 12 位）。
#
# ── --from-index ─────────────────────────────────────────────────────
# 默认读工作区。加 --from-index 则读**暂存区**，即真正会被提交的那份内容。
# pre-commit 用的是 --from-index：hook 要保证的是「进入提交的内容合规」，
# 而不是「磁盘上当下的内容合规」，两者在部分暂存时并不相同。
#
# 运行：python scripts/check-cache-bust.py [--root <dir>] [--from-index]
# 退出码：0 全过；1 有失败项。
import argparse
import pathlib
import re
import subprocess
import sys
from collections import defaultdict

SKIP_DIRS = {".git", ".claude", "node_modules", "docs"}

# bump.py 用 time.strftime("%Y%m%d%H%M") → 恒为 12 位数字。C4 会核对这一点。
STAMP_FMT = "%Y%m%d%H%M"
STAMP_LEN = 12
VALID_QUERY = re.compile(r"^\?v=\d{%d}$" % STAMP_LEN)

# 宽口径扫描：双引号 / 单引号 / 无引号都要看见（C3 负责对后两者报错）。
REF_ANY = re.compile(
    r"""<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))""",
    re.IGNORECASE,
)
LOCAL_ASSET = re.compile(r"^(?:\.\./)*assets/(?:css|js)/[^?]+(?:\?.*)?$", re.IGNORECASE)


def _vcs(root, *args):
    return subprocess.run(["git", *args], cwd=str(root), capture_output=True,
                          text=True, encoding="utf-8", errors="replace")


def index_sources(root: pathlib.Path):
    """暂存区中的 HTML：(相对路径, 内容)。"""
    r = _vcs(root, "ls-files", "-z", "--", "*.html")
    if r.returncode != 0:
        raise SystemExit("check-cache-bust: cannot read the index:\n" + r.stderr)
    out = []
    for rel in [x for x in r.stdout.split("\0") if x]:
        parts = pathlib.PurePosixPath(rel).parts
        if SKIP_DIRS & set(parts[:-1]):
            continue
        b = _vcs(root, "show", ":" + rel)
        if b.returncode != 0:
            continue  # 已从暂存区删除
        out.append((rel, b.stdout))
    return out


def worktree_sources(root: pathlib.Path):
    out = []
    for p in sorted(root.rglob("*.html")):
        rel = p.relative_to(root)
        if SKIP_DIRS & set(rel.parts[:-1]):
            continue
        out.append((rel.as_posix(), p.read_text(encoding="utf-8", errors="replace")))
    return out


def scan(root: pathlib.Path, from_index: bool = False):
    sources = index_sources(root) if from_index else worktree_sources(root)
    pages = 0
    refs = []  # (page, url, quote)  quote ∈ {'"', "'", ''}
    for relpath, text in sources:
        pages += 1
        for m in REF_ANY.finditer(text):
            dq, sq, nq = m.group(1), m.group(2), m.group(3)
            url = dq if dq is not None else (sq if sq is not None else nq)
            quote = '"' if dq is not None else ("'" if sq is not None else "")
            if url is None:
                continue
            if not LOCAL_ASSET.match(url):
                continue
            refs.append((relpath, url, quote))
    return pages, refs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=None)
    ap.add_argument("--from-index", action="store_true",
                    help="校验暂存区内容（真正会被提交的那份），而不是工作区")
    args = ap.parse_args()
    root = pathlib.Path(args.root).resolve() if args.root else pathlib.Path(__file__).resolve().parent.parent

    pages, refs = scan(root, from_index=args.from_index)
    src_label = "index" if args.from_index else "worktree"
    results = []

    def rec(cid, name, ok, detail=""):
        results.append(ok)
        print("%s %s %s%s" % ("PASS" if ok else "FAIL", cid, name, (" | " + detail) if detail else ""))

    # ── C0 反空过 ────────────────────────────────────────────────────
    rec("C0", "scan is non-empty (not a vacuous pass)", pages > 0 and len(refs) > 0,
        "source=%s pages=%d refs=%d" % (src_label, pages, len(refs)))
    if pages == 0 or not refs:
        print("       0 pages or 0 eligible refs - refusing to declare PASS on an empty set.")
        print("\n=== CACHE-BUST CONTRACT: %d/%d PASSED ===" % (sum(results), len(results)))
        return 1

    # ── C3 引号形态（先于 C1，因为它决定 stamper 能否触及该引用）────
    bad_quote = [(f, u, q) for f, u, q in refs if q != '"']
    rec("C3", "all local asset refs use the double quotes the stamper can handle", not bad_quote,
        "non-double-quoted=%d" % len(bad_quote))
    for f, u, q in bad_quote:
        print("       %-40s %s (quote=%s, stamper cannot reach it)" % (f, u, q or "none"))

    # ── C1 戳记格式合法 ─────────────────────────────────────────────
    bad = []
    for f, u, q in refs:
        i = u.find("?")
        query = u[i:] if i >= 0 else ""
        if not VALID_QUERY.match(query):
            bad.append((f, u, query if query else "(no stamp)"))
    rec("C1", "every ref carries a well-formed stamp ?v=<%d digits>" % STAMP_LEN, not bad,
        "refs=%d invalid=%d" % (len(refs), len(bad)))
    for f, u, why in bad[:60]:
        print("       %-40s %-46s -> %s" % (f, u, why))

    # ── C2 戳记值唯一 ───────────────────────────────────────────────
    stamps = defaultdict(list)
    for f, u, q in refs:
        m = re.search(r"\?v=(\d{%d})$" % STAMP_LEN, u)
        if m:
            stamps[m.group(1)].append(f)
    rec("C2", "stamp value is unique site-wide", len(stamps) <= 1,
        "values=%s" % (sorted(stamps) if stamps else "(none)"))
    if len(stamps) > 1:
        for v in sorted(stamps):
            print("       %s -> %d refs: %s" % (v, len(stamps[v]), ", ".join(sorted(set(stamps[v]))[:4])))

    # ── C4 stamper 与校验未漂移 ─────────────────────────────────────
    if args.from_index:
        b = _vcs(root, "show", ":scripts/bump.py")
        bump_src = b.stdout if b.returncode == 0 else None
    else:
        bump = root / "scripts" / "bump.py"
        bump_src = bump.read_text(encoding="utf-8", errors="replace") if bump.exists() else None

    if bump_src is not None:
        ok = ('strftime("%s")' % STAMP_FMT) in bump_src or ("strftime('%s')" % STAMP_FMT) in bump_src
        rec("C4", "stamper version format is still %s (no drift)" % STAMP_FMT,
            ok, "source=%s" % src_label)
        if not ok:
            print("       bump.py strftime format changed; this checker still expects %d digits." % STAMP_LEN)
            print("       Both must change together, otherwise the checker starts misjudging.")
    else:
        rec("C4", "stamper exists and version format has not drifted", False,
            "scripts/bump.py missing (source=%s)" % src_label)

    passed = sum(1 for r in results if r)
    print("\n=== CACHE-BUST CONTRACT: %d/%d PASSED ===" % (passed, len(results)))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
