# 缓存戳脚本对「不属于这次提交的用户文件」的保护 —— 负向夹具，全部在一次性 fixture 仓库里真跑 git commit。
#
# test-hook-gate.py 的 A6 已经证明：仓库根目录下、纯 ASCII 文件名的未跟踪页面会被拒。
# 这里补的是 A6 没覆盖的形态。每一种都要证明三件事：
#   ① 该文件没有进入 HEAD；
#   ② 该文件一个字节都没被改（没被打戳）—— bump.py 往用户文件里写戳本身就是越界；
#   ③ 提交的去留符合预期：会被当成新页面带进来的（未跟踪、未忽略）→ 拒；
#      git 本来就看不见的（被 .gitignore 忽略、嵌套仓库 / worktree 里的）→ 与本次提交无关，放行。
#
#   U1  子目录里的未跟踪页面
#   U2  非 ASCII 文件名的未跟踪页面（git 默认会把这类路径转义输出）
#   U3  文件名带空格的未跟踪页面（且拒绝信息要给出完整路径）
#   U4  被 .gitignore 忽略的本地页面
#   U5  嵌套 git 仓库（如主检出里的 worktrees/*）里的页面
#   U6  未跟踪、但没有引用本地 assets 的页面（不是打戳候选）
#   U7  主检出目录里挂着的 linked worktree（本项目 amas-web/worktrees/* 就是这种布局）
#
# 运行：python3 scripts/test-bump-untracked-guard.py
# 退出码：0 全过；1 有用例未达预期。
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
GOOD = "202609111133"
REF = '<script src="assets/js/a.js?v=%s"></script>' % GOOD
PAGE = '<!doctype html><html><head>%s</head><body>%s</body></html>\n'


def git(repo, *args, check=False):
    r = subprocess.run(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
                        "-c", "core.autocrlf=false", *args],
                       cwd=str(repo), capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), r.stderr))
    return r


def build(repo: pathlib.Path):
    (repo / "scripts").mkdir(parents=True, exist_ok=True)
    (repo / ".githooks").mkdir(parents=True, exist_ok=True)
    for f in ("bump.py", "check-cache-bust.py"):
        shutil.copy(ROOT / "scripts" / f, repo / "scripts" / f)
    hook = repo / ".githooks" / "pre-commit"
    shutil.copy(ROOT / ".githooks" / "pre-commit", hook)
    os.chmod(hook, 0o755)
    for d in ("assets/js", "assets/css"):
        (repo / d).mkdir(parents=True, exist_ok=True)
    (repo / "assets" / "js" / "a.js").write_text("// a", encoding="utf-8")
    (repo / "index.html").write_bytes((PAGE % (REF, "baseline")).encode("utf-8"))
    git(repo, "init", "-q", check=True)
    git(repo, "config", "core.hooksPath", ".githooks", check=True)
    git(repo, "add", "-A", check=True)
    git(repo, "commit", "-q", "-m", "fixture: baseline", check=True)
    return git(repo, "rev-parse", "HEAD").stdout.strip()


results = []


def rec(cid, name, ok, detail=""):
    results.append(ok)
    print("  %-9s %-4s %-44s %s" % ("PASS" if ok else "**MISS**", cid, name, detail))


def scenario(cid, title, setup, expect_refused, path_in_message=None):
    """setup(repo) 在 baseline 之后制造用户文件，返回该文件相对路径（posix）。"""
    # linked worktree 的 .git 目录里会有 git 事后写入的文件，清理时可能撞上；清不干净不影响判定。
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
        repo = pathlib.Path(td)
        base = build(repo)
        rel = setup(repo)
        user = repo / rel
        before = user.read_bytes()
        (repo / "note.txt").write_text("intended change\n", encoding="utf-8")
        git(repo, "add", "note.txt", check=True)

        c = git(repo, "commit", "-m", "fixture: " + cid)
        out = c.stdout + c.stderr
        head = git(repo, "rev-parse", "HEAD").stdout.strip()
        tree = git(repo, "-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", "HEAD").stdout.splitlines()
        after = user.read_bytes() if user.exists() else None

        print("\n  %s %s" % (cid, title))
        rec(cid + "a", "用户文件没有进入 HEAD", rel not in tree, "HEAD 里有它=%s" % (rel in tree))
        rec(cid + "b", "用户文件一个字节都没被改（没被打戳）", after == before,
            "内容一致=%s" % (after == before))
        if expect_refused:
            rec(cid + "c", "提交被拒（它会被当成新页面带进来）", c.returncode != 0 and head == base,
                "exit=%d HEAD 未前进=%s" % (c.returncode, head == base))
        else:
            rec(cid + "c", "提交照常完成（该文件与本次提交无关，不该挡路）", c.returncode == 0 and head != base,
                "exit=%d HEAD 前进=%s" % (c.returncode, head != base))
        if path_in_message:
            rec(cid + "d", "拒绝信息给出完整路径", path_in_message in out, "输出含 %r=%s" % (path_in_message, path_in_message in out))
        if (c.returncode != 0) != expect_refused:
            print("        | " + "\n        | ".join(out.strip().splitlines()[-8:]))


def u1(repo):
    (repo / "portal" / "draft").mkdir(parents=True)
    (repo / "portal" / "draft" / "index.html").write_text(PAGE % ('<script src="../../assets/js/a.js?v=%s"></script>' % GOOD, "U1"), encoding="utf-8")
    return "portal/draft/index.html"


def u2(repo):
    (repo / "草稿页.html").write_text(PAGE % (REF, "U2"), encoding="utf-8")
    return "草稿页.html"


def u3(repo):
    (repo / "my draft.html").write_text(PAGE % (REF, "U3"), encoding="utf-8")
    return "my draft.html"


def u4(repo):
    (repo / ".gitignore").write_text("local/\n", encoding="utf-8")
    git(repo, "add", ".gitignore", check=True)
    (repo / "local").mkdir()
    (repo / "local" / "preview.html").write_text(PAGE % ('<script src="../assets/js/a.js?v=%s"></script>' % GOOD, "U4"), encoding="utf-8")
    return "local/preview.html"


def u5(repo):
    nested = repo / "worktrees" / "other-session"
    nested.mkdir(parents=True)
    (nested / "index.html").write_text(PAGE % ('<script src="assets/js/a.js?v=%s"></script>' % GOOD, "U5 nested"), encoding="utf-8")
    git(nested, "init", "-q", check=True)
    return "worktrees/other-session/index.html"


def u7(repo):
    # 与本项目布局一致：主检出目录里挂着 linked worktree（worktrees/<name>，里面是 .git **文件**）
    git(repo, "worktree", "add", "-q", "-b", "side", "worktrees/side-session", check=True)
    # 检出来的页面带的是 baseline 那一分钟打的戳；本次提交若也在同一分钟，bump 写出的值相同、
    # 看起来「没被改」，用例就空过了。先换成一个明确过时的戳，保证只要被当成候选就一定会被改写。
    wt_page = repo / "worktrees" / "side-session" / "index.html"
    wt_page.write_text(PAGE % ('<script src="assets/js/a.js?v=202001010000"></script>', "U7 side session"), encoding="utf-8")
    return "worktrees/side-session/index.html"


def u6(repo):
    (repo / "plain.html").write_text(PAGE % ("", "U6 no local assets"), encoding="utf-8")
    return "plain.html"


print("── 缓存戳脚本：用户文件保护（一次性 fixture 仓库，真跑 git commit）─────────")
scenario("U1", "子目录里的未跟踪页面", u1, expect_refused=True, path_in_message="portal/draft/index.html")
scenario("U2", "非 ASCII 文件名的未跟踪页面", u2, expect_refused=True)
scenario("U3", "文件名带空格的未跟踪页面", u3, expect_refused=True, path_in_message="my draft.html")
scenario("U4", "被 .gitignore 忽略的本地页面", u4, expect_refused=False)
scenario("U5", "嵌套 git 仓库（worktree）里的页面", u5, expect_refused=False)
scenario("U6", "未跟踪、没有引用本地 assets 的页面", u6, expect_refused=False)
scenario("U7", "主检出里挂着的 linked worktree（git worktree add）里的页面", u7, expect_refused=False)

passed = sum(1 for r in results if r)
print("\n=== 用户文件保护: %d/%d PASSED ===" % (passed, len(results)))
sys.exit(0 if passed == len(results) else 1)
