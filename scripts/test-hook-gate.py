# pre-commit 闸门的端到端验证 —— 全部在一次性 fixture 仓库里真跑 git commit，
# 不碰真实仓库、不碰远端、不碰数据库。
#
# 要证明的四件事：
#   A1  合法状态下提交成功（闸门不误杀）
#   A2  畸形戳导致提交被中止（闸门真的拦得住）
#   A3  中止时**无关的已暂存内容原样保留**（闸门不造成附带损害）
#   A4  stamper 崩溃时提交被中止（原版 hook 在这里会静默放行）
#
# 运行：python scripts/test-hook-gate.py
# 退出码：0 全过；1 有用例未达预期。
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
GOOD = "202609111133"
PAGE = '<!doctype html><html><head>%s</head><body></body></html>'


def git(repo, *args, check=False):
    r = subprocess.run(["git", *args], cwd=str(repo), capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), r.stderr))
    return r


def build(repo: pathlib.Path, head_html: str, break_bump: bool = False):
    (repo / "scripts").mkdir(parents=True, exist_ok=True)
    (repo / ".githooks").mkdir(parents=True, exist_ok=True)
    for f in ("bump.py", "check-cache-bust.py"):
        shutil.copy(ROOT / "scripts" / f, repo / "scripts" / f)
    if break_bump:
        (repo / "scripts" / "bump.py").write_text(
            "import sys\nsys.stderr.write('simulated stamper crash\\n')\nsys.exit(3)\n",
            encoding="utf-8")
    hook = repo / ".githooks" / "pre-commit"
    shutil.copy(ROOT / ".githooks" / "pre-commit", hook)
    os.chmod(hook, 0o755)
    for d in ("assets/js", "assets/css"):
        (repo / d).mkdir(parents=True, exist_ok=True)
    (repo / "assets" / "js" / "a.js").write_text("// a", encoding="utf-8")
    (repo / "assets" / "css" / "a.css").write_text("/* a */", encoding="utf-8")
    (repo / "index.html").write_text(PAGE % head_html, encoding="utf-8")

    git(repo, "init", "-q", check=True)
    git(repo, "config", "user.email", "fixture@example.invalid", check=True)
    git(repo, "config", "user.name", "fixture", check=True)
    git(repo, "config", "core.hooksPath", ".githooks", check=True)


results = []


def rec(cid, name, ok, detail=""):
    results.append(ok)
    print("  %-9s %-4s %-42s %s" % ("PASS" if ok else "**MISS**", cid, name, detail))


print("── pre-commit 闸门端到端（一次性 fixture 仓库）─────────────────")

# ── A1 合法 → 提交成功 ──────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    repo = pathlib.Path(td)
    build(repo, '<script src="assets/js/a.js?v=%s"></script>' % GOOD)
    git(repo, "add", "-A", check=True)
    c = git(repo, "commit", "-m", "fixture: valid")
    n = git(repo, "rev-list", "--count", "HEAD").stdout.strip() if c.returncode == 0 else "0"
    rec("A1", "合法状态提交成功（闸门不误杀）", c.returncode == 0 and n == "1",
        "exit=%d commits=%s" % (c.returncode, n))
    if c.returncode != 0:
        print((c.stdout + c.stderr)[:400])

# ── A2 / A3 畸形戳 → 中止，且无关暂存内容保留 ───────────────────────
with tempfile.TemporaryDirectory() as td:
    repo = pathlib.Path(td)
    build(repo, '<script src="assets/js/a.js?v=%s"></script>' % GOOD)
    git(repo, "add", "-A", check=True)
    git(repo, "commit", "-q", "-m", "fixture: base", check=True)
    base = git(repo, "rev-parse", "HEAD").stdout.strip()

    # 引入畸形戳（B1 已证 bump.py 不会修正它）
    (repo / "index.html").write_text(PAGE % '<script src="assets/js/a.js?v=abc"></script>',
                                     encoding="utf-8")
    # 同时暂存一份与本缺陷无关的内容
    UNRELATED = "keep me exactly as staged\n"
    (repo / "unrelated.txt").write_text(UNRELATED, encoding="utf-8")
    git(repo, "add", "index.html", "unrelated.txt", check=True)
    staged_before = git(repo, "diff", "--cached", "--name-only").stdout.split()

    c = git(repo, "commit", "-m", "fixture: should be blocked")
    after = git(repo, "rev-parse", "HEAD").stdout.strip()
    blocked = c.returncode != 0 and after == base
    rec("A2", "畸形戳导致提交被中止", blocked,
        "exit=%d HEAD 未前进=%s" % (c.returncode, after == base))
    if not blocked:
        print((c.stdout + c.stderr)[:400])

    staged_after = git(repo, "diff", "--cached", "--name-only").stdout.split()
    blob = git(repo, "show", ":unrelated.txt").stdout
    survived = ("unrelated.txt" in staged_after) and blob == UNRELATED
    rec("A3", "无关已暂存内容原样保留", survived,
        "仍在暂存=%s 内容一致=%s" % ("unrelated.txt" in staged_after, blob == UNRELATED))
    if not survived:
        print("    staged_before=%s staged_after=%s" % (staged_before, staged_after))

    fail_shown = "FAIL C1" in (c.stdout + c.stderr)
    rec("A2b", "中止原因在 hook 输出中可见", fail_shown, "输出含 FAIL C1=%s" % fail_shown)

# ── A4 stamper 崩溃 → 中止 ──────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    repo = pathlib.Path(td)
    build(repo, '<script src="assets/js/a.js?v=%s"></script>' % GOOD, break_bump=True)
    git(repo, "add", "-A", check=True)
    c = git(repo, "commit", "-m", "fixture: stamper crash")
    n = git(repo, "rev-list", "--count", "HEAD")
    made = n.stdout.strip() if n.returncode == 0 else "0"
    ok = c.returncode != 0 and made in ("0", "")
    rec("A4", "stamper 崩溃时提交被中止", ok,
        "exit=%d commits=%s" % (c.returncode, made or "0"))
    if not ok:
        print((c.stdout + c.stderr)[:400])

passed = sum(1 for r in results if r)
print("\n=== HOOK 闸门: %d/%d PASSED ===" % (passed, len(results)))
sys.exit(0 if passed == len(results) else 1)
