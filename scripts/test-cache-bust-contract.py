# check-cache-bust.py 的负向/正向用例 —— 在一次性 fixture 目录里验证，不碰真实仓库。
#
# 存在意义：一条永远为真的断言不是断言。本脚本对每一项契约构造一个应当失败的场景，
# 证明它确实会失败；再构造合法场景，证明它确实会通过。
# 另外顺带用实测证明 C1 为什么必须拒绝畸形戳（见 B1）。
#
# 运行：python scripts/test-cache-bust-contract.py
# 退出码：0 全过；1 有用例未达预期。
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
CHECKER = ROOT / "scripts" / "check-cache-bust.py"
BUMP = ROOT / "scripts" / "bump.py"
GOOD = "202609111133"

PAGE = '<!doctype html><html><head>%s</head><body></body></html>'


def make(tmp: pathlib.Path, head: str, with_bump: bool = True, page_name: str = "index.html"):
    (tmp / "scripts").mkdir(parents=True, exist_ok=True)
    if with_bump:
        shutil.copy(BUMP, tmp / "scripts" / "bump.py")
    (tmp / "assets" / "js").mkdir(parents=True, exist_ok=True)
    (tmp / "assets" / "css").mkdir(parents=True, exist_ok=True)
    (tmp / "assets" / "js" / "a.js").write_text("// a", encoding="utf-8")
    (tmp / "assets" / "css" / "a.css").write_text("/* a */", encoding="utf-8")
    if head is not None:
        (tmp / page_name).write_text(PAGE % head, encoding="utf-8")


def run_checker(tmp: pathlib.Path):
    r = subprocess.run([sys.executable, str(CHECKER), "--root", str(tmp)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


CASES = []


def case(cid, name, head, expect_fail_id, with_bump=True, mutate=None):
    CASES.append((cid, name, head, expect_fail_id, with_bump, mutate))


# ── 正向 ─────────────────────────────────────────────────────────────
case("P1", "合法：双引号 + 12 位数字戳",
     '<script src="assets/js/a.js?v=%s"></script><link rel="stylesheet" href="assets/css/a.css?v=%s">' % (GOOD, GOOD),
     None)

# ── C1 负向：畸形戳 ──────────────────────────────────────────────────
case("N1", "空戳 ?v=",            '<script src="assets/js/a.js?v="></script>', "C1")
case("N2", "非数字戳 ?v=abc",      '<script src="assets/js/a.js?v=abc"></script>', "C1")
case("N3", "长度不符 ?v=2026",     '<script src="assets/js/a.js?v=2026"></script>', "C1")
case("N4", "附加参数 ?v=…&x=1",    '<script src="assets/js/a.js?v=%s&x=1"></script>' % GOOD, "C1")
case("N5", "完全无戳",             '<script src="assets/js/a.js"></script>', "C1")
case("N6", "戳后有尾随内容 ?v=…x", '<script src="assets/js/a.js?v=%sx"></script>' % GOOD, "C1")

# ── C3 负向：stamper 摸不到的引号形态 ───────────────────────────────
case("N7", "单引号引用",           "<script src='assets/js/a.js?v=%s'></script>" % GOOD, "C3")
case("N8", "无引号引用",           '<script src=assets/js/a.js?v=%s></script>' % GOOD, "C3")

# ── C2 负向：戳记值不唯一 ───────────────────────────────────────────
case("N9", "两个不同戳记值",
     '<script src="assets/js/a.js?v=%s"></script><link rel="stylesheet" href="assets/css/a.css?v=202501010000">' % GOOD,
     "C2")

# ── C0 负向：空过 ───────────────────────────────────────────────────
case("N10", "目录内无任何 HTML", None, "C0")
case("N11", "有 HTML 但零本地资产引用",
     '<script src="https://cdn.example.com/x.js"></script>', "C0")

# ── C4 负向：stamper 与校验漂移 ─────────────────────────────────────
def drift(tmp: pathlib.Path):
    p = tmp / "scripts" / "bump.py"
    s = p.read_text(encoding="utf-8")
    p.write_text(s.replace('strftime("%Y%m%d%H%M")', 'strftime("%Y%m%d")'), encoding="utf-8")


case("N12", "bump.py 版本格式漂移为 %Y%m%d",
     '<script src="assets/js/a.js?v=%s"></script>' % GOOD, "C4", mutate=drift)

# ── C4 负向：stamper 缺失 ───────────────────────────────────────────
case("N13", "scripts/bump.py 不存在",
     '<script src="assets/js/a.js?v=%s"></script>' % GOOD, "C4", with_bump=False)


def main() -> int:
    bad = []
    print("── 契约用例 ───────────────────────────────────────────────")
    for cid, name, head, expect, with_bump, mutate in CASES:
        with tempfile.TemporaryDirectory() as td:
            tmp = pathlib.Path(td)
            make(tmp, head, with_bump=with_bump)
            if mutate:
                mutate(tmp)
            code, out = run_checker(tmp)
            if expect is None:
                ok = code == 0
                got = "exit=0 全过" if ok else "exit=%d" % code
            else:
                failed_ids = set(re.findall(r"^FAIL (\w+)", out, re.M))
                ok = code != 0 and expect in failed_ids
                got = "exit=%d failed=%s" % (code, sorted(failed_ids) or "[]")
            print("  %-5s %-4s %-34s %s" % ("PASS" if ok else "**MISS**", cid, name, got))
            if not ok:
                bad.append((cid, out))

    # ── B1：实测证明 C1 的严格性不是洁癖 ────────────────────────────
    print("\n── B1 bump.py 对畸形戳的实际行为（C1 严格性的依据）──────────")
    with tempfile.TemporaryDirectory() as td:
        tmp = pathlib.Path(td)
        make(tmp, '<script src="assets/js/a.js?v=abc"></script>')
        before = (tmp / "index.html").read_text(encoding="utf-8")
        subprocess.run([sys.executable, str(tmp / "scripts" / "bump.py")],
                       capture_output=True, text=True, cwd=str(tmp))
        after = (tmp / "index.html").read_text(encoding="utf-8")
        unchanged = before == after
        print("  %-5s B1   畸形戳 ?v=abc 运行 bump.py 后仍未被修正 → 永久盲区  %s"
              % ("PASS" if unchanged else "**MISS**", "（未变更）" if unchanged else "（被改写了）"))
        if not unchanged:
            bad.append(("B1", "expected bump.py to leave malformed stamp untouched"))

    print("\n=== 契约用例: %d/%d PASSED ===" % (len(CASES) + 1 - len(bad), len(CASES) + 1))
    if bad:
        for cid, out in bad[:2]:
            print("\n--- %s 输出 ---\n%s" % (cid, out))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
