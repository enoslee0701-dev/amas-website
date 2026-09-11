# pre-commit 闸门的端到端验证 —— 全部在一次性 fixture 仓库里真跑 git commit，
# 不碰真实仓库、不碰远端、不碰数据库。
#
# 要证明的事：
#   A1  合法状态下提交成功（闸门不误杀）
#   A2  畸形戳导致提交被中止（闸门拦得住）        + A2b 中止原因可见
#   A3  中止时无关的已暂存内容原样保留
#   A4  stamper 崩溃时提交被中止
#   ── 以下为 Codex 独立复核发现的污染路径，第三轮补上 ──
#   A5  **同文件部分暂存**：已 git add 意图变更后又写未暂存私稿 →
#       提交被拒；私稿未进 HEAD；工作区与暂存区均未被改动（连戳都没打）
#   A6  **未跟踪 HTML**：带本地资产引用的未跟踪页面 →
#       提交被拒；该文件仍未跟踪、未进 HEAD；工作区未被改动
#   A7  **无关的已跟踪 HTML 有未暂存改动** → 提交被拒（旧 hook 会把它一并提交）
#
# A5/A6/A7 的共同要害：hook 会把打戳后的文件自动暂存，因此「打戳」这个动作
# 会把工作区里未暂存的内容送进提交。保护必须发生在任何写入之前。
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
HEAD_OK = '<script src="assets/js/a.js?v=%s"></script>' % GOOD
PAGE = '<!doctype html><html><head>%s</head><body>%s</body></html>\n'


def git(repo, *args, check=False):
    r = subprocess.run(["git", "-c", "user.name=fixture",
                        "-c", "user.email=fixture@example.invalid", *args],
                       cwd=str(repo), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), r.stderr))
    return r


def build(repo: pathlib.Path, body: str = "baseline", break_bump: bool = False):
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
    (repo / "index.html").write_text(PAGE % (HEAD_OK, body), encoding="utf-8")

    git(repo, "init", "-q", check=True)
    git(repo, "config", "core.hooksPath", ".githooks", check=True)


def commit_baseline(repo):
    git(repo, "add", "-A", check=True)
    git(repo, "commit", "-q", "-m", "fixture: baseline", check=True)
    return git(repo, "rev-parse", "HEAD").stdout.strip()


results = []


def rec(cid, name, ok, detail=""):
    results.append(ok)
    print("  %-9s %-4s %-40s %s" % ("PASS" if ok else "**MISS**", cid, name, detail))


print("── pre-commit 闸门端到端（一次性 fixture 仓库）─────────────────")

# ── A1 合法 → 提交成功 ──────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    repo = pathlib.Path(td)
    build(repo)
    git(repo, "add", "-A", check=True)
    c = git(repo, "commit", "-m", "fixture: valid")
    n = git(repo, "rev-list", "--count", "HEAD").stdout.strip() if c.returncode == 0 else "0"
    rec("A1", "合法状态提交成功（闸门不误杀）", c.returncode == 0 and n == "1",
        "exit=%d commits=%s" % (c.returncode, n))
    if c.returncode != 0:
        print((c.stdout + c.stderr)[:500])

# ── A2 / A2b / A3 畸形戳 → 中止，无关暂存内容保留 ───────────────────
with tempfile.TemporaryDirectory() as td:
    repo = pathlib.Path(td)
    build(repo)
    base = commit_baseline(repo)
    (repo / "index.html").write_text(
        PAGE % ('<script src="assets/js/a.js?v=abc"></script>', "baseline"), encoding="utf-8")
    UNRELATED = "keep me exactly as staged\n"
    (repo / "unrelated.txt").write_text(UNRELATED, encoding="utf-8")
    git(repo, "add", "index.html", "unrelated.txt", check=True)

    c = git(repo, "commit", "-m", "fixture: should be blocked")
    after = git(repo, "rev-parse", "HEAD").stdout.strip()
    rec("A2", "畸形戳导致提交被中止", c.returncode != 0 and after == base,
        "exit=%d HEAD 未前进=%s" % (c.returncode, after == base))
    out = c.stdout + c.stderr
    rec("A2b", "中止原因在 hook 输出中可见", "FAIL C1" in out, "输出含 FAIL C1")
    staged_after = git(repo, "diff", "--cached", "--name-only").stdout.split()
    blob = git(repo, "show", ":unrelated.txt").stdout
    rec("A3", "无关已暂存内容原样保留",
        "unrelated.txt" in staged_after and blob == UNRELATED,
        "仍在暂存=%s 内容一致=%s" % ("unrelated.txt" in staged_after, blob == UNRELATED))

# ── A4 stamper 崩溃 → 中止 ──────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    repo = pathlib.Path(td)
    build(repo, break_bump=True)
    git(repo, "add", "-A", check=True)
    c = git(repo, "commit", "-m", "fixture: stamper crash")
    n = git(repo, "rev-list", "--count", "HEAD")
    made = n.stdout.strip() if n.returncode == 0 else "0"
    rec("A4", "stamper 崩溃时提交被中止", c.returncode != 0 and made in ("0", ""),
        "exit=%d commits=%s" % (c.returncode, made or "0"))

# ── A5 同文件部分暂存（Codex 复现场景）──────────────────────────────
with tempfile.TemporaryDirectory() as td:
    repo = pathlib.Path(td)
    build(repo)
    base = commit_baseline(repo)

    intended = PAGE % (HEAD_OK, "staged intended")
    (repo / "index.html").write_text(intended, encoding="utf-8")
    git(repo, "add", "index.html", check=True)
    draft = PAGE % (HEAD_OK, "staged intended</p><p>UNSTAGED_PRIVATE_DRAFT")
    (repo / "index.html").write_text(draft, encoding="utf-8")

    idx_before = git(repo, "show", ":index.html").stdout
    wt_before = (repo / "index.html").read_text(encoding="utf-8")

    c = git(repo, "commit", "-m", "fixture: partial stage")
    head_now = git(repo, "rev-parse", "HEAD").stdout.strip()
    committed = git(repo, "show", "HEAD:index.html").stdout
    idx_after = git(repo, "show", ":index.html").stdout
    wt_after = (repo / "index.html").read_text(encoding="utf-8")

    rec("A5", "同文件部分暂存 → 提交被拒", c.returncode != 0 and head_now == base,
        "exit=%d HEAD 未前进=%s" % (c.returncode, head_now == base))
    rec("A5b", "私稿未进入任何提交", "UNSTAGED_PRIVATE_DRAFT" not in committed,
        "HEAD:index.html 不含私稿=%s" % ("UNSTAGED_PRIVATE_DRAFT" not in committed))
    rec("A5c", "暂存区未被改动（连戳都没打）", idx_after == idx_before,
        "index 一致=%s" % (idx_after == idx_before))
    rec("A5d", "工作区未被改动", wt_after == wt_before,
        "worktree 一致=%s" % (wt_after == wt_before))
    rec("A5e", "拒绝原因含确切路径", "index.html" in (c.stdout + c.stderr),
        "输出含 index.html")

# ── A6 未跟踪 HTML ──────────────────────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    repo = pathlib.Path(td)
    build(repo)
    base = commit_baseline(repo)

    (repo / "note.txt").write_text("intended\n", encoding="utf-8")
    git(repo, "add", "note.txt", check=True)
    untracked = PAGE % (HEAD_OK, "UNTRACKED_SCRATCH_PAGE")
    (repo / "scratch.html").write_text(untracked, encoding="utf-8")
    wt_before = (repo / "scratch.html").read_text(encoding="utf-8")

    c = git(repo, "commit", "-m", "fixture: untracked html")
    head_now = git(repo, "rev-parse", "HEAD").stdout.strip()
    ls = git(repo, "ls-files", "--", "scratch.html").stdout.strip()
    others = git(repo, "ls-files", "--others", "--exclude-standard", "--", "scratch.html").stdout.strip()
    wt_after = (repo / "scratch.html").read_text(encoding="utf-8")

    rec("A6", "未跟踪 HTML → 提交被拒", c.returncode != 0 and head_now == base,
        "exit=%d HEAD 未前进=%s" % (c.returncode, head_now == base))
    rec("A6b", "该文件仍未跟踪、未被暂存", ls == "" and others == "scratch.html",
        "ls-files=%r others=%r" % (ls, others))
    rec("A6c", "未跟踪文件未被改动（未打戳）", wt_after == wt_before,
        "内容一致=%s" % (wt_after == wt_before))
    rec("A6d", "拒绝原因含确切路径", "scratch.html" in (c.stdout + c.stderr),
        "输出含 scratch.html")

# ── A7 无关已跟踪 HTML 有未暂存改动 ────────────────────────────────
with tempfile.TemporaryDirectory() as td:
    repo = pathlib.Path(td)
    build(repo)
    (repo / "other.html").write_text(PAGE % (HEAD_OK, "other baseline"), encoding="utf-8")
    base = commit_baseline(repo)

    (repo / "note.txt").write_text("intended\n", encoding="utf-8")
    git(repo, "add", "note.txt", check=True)
    (repo / "other.html").write_text(PAGE % (HEAD_OK, "OTHER_UNSTAGED_EDIT"), encoding="utf-8")

    c = git(repo, "commit", "-m", "fixture: unrelated dirty html")
    head_now = git(repo, "rev-parse", "HEAD").stdout.strip()
    rec("A7", "无关已跟踪 HTML 有未暂存改动 → 提交被拒",
        c.returncode != 0 and head_now == base,
        "exit=%d HEAD 未前进=%s" % (c.returncode, head_now == base))
    rec("A7b", "拒绝原因含确切路径", "other.html" in (c.stdout + c.stderr),
        "输出含 other.html")

passed = sum(1 for r in results if r)
print("\n=== HOOK 闸门: %d/%d PASSED ===" % (passed, len(results)))
sys.exit(0 if passed == len(results) else 1)
