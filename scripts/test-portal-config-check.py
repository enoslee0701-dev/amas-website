#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check-portal-config.py 的契约测试（离线，不联网、不登录、不写任何文件）。

用法: python scripts/test-portal-config-check.py

每个 fixture 断言的是**逐项状态**而不是只看退出码 —— 只看退出码的话，
「因为 url 错而挂」和「因为 role 错而挂」无法区分，检查器退化成一个布尔值。

另有 5 条哨兵（S1-S5），针对这类脚本最容易出的几种空过：
  S1 fixture 语料非空
  S2 没有 fixture 被漏测（目录与期望表必须一一对应）
  S3 检查器既能通过也能失败（全过或全挂的检查器都是坏的）
  S4 输出里不含任何 key 字节（「不输出 secret」是可执行断言，不是承诺）
  S5 降级页在数学上无法把判定顶成 READY
"""

import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHECKER = os.path.join(HERE, "check-portal-config.py")
FIXTURES = os.path.join(HERE, "fixtures", "portal-config")

# fixture -> (期望退出码, {项目前缀: 期望状态})
# 只列出该 fixture 想证明的项；其余项不做断言，避免把仓库现状焊死进测试。
EXPECT = {
    "valid.js": (0, {
        "P1": "READY", "P2": "READY", "P3": "READY",
        "P4": "READY", "P5": "READY", "P6": "READY",
    }),
    "missing.js": (1, {"P1": "READY", "P2": "MISSING", "P3": "MISSING"}),
    # 两种占位形态都要判 MISSING（没填）而不是 INVALID（填错）——
    # 给用户的下一步动作不同：前者去 dashboard 取值，后者去查为什么取错。
    "placeholder.js": (1, {"P2": "MISSING", "P3": "MISSING"}),
    "placeholder-inline.js": (1, {"P2": "MISSING", "P3": "MISSING"}),
    "no-window-supa.js": (1, {"P1": "INVALID"}),
    "bad-scheme.js": (1, {"P2": "INVALID"}),
    "bad-host.js": (1, {"P2": "INVALID"}),
    "malformed-key.js": (1, {"P3": "INVALID"}),
    "undecodable-key.js": (1, {"P3": "INVALID"}),
    "service-role.js": (1, {"P3": "READY", "P4": "BLOCKED"}),
    "wrong-role.js": (1, {"P4": "INVALID"}),
    "expired.js": (1, {"P4": "READY", "P5": "INVALID"}),
    "ref-mismatch.js": (1, {"P4": "READY", "P6": "INVALID"}),
}

ROW = re.compile(r"^(P\d+[a-z]?|I\d+)\s+\S+\s{2,}(READY|MISSING|INVALID|BLOCKED|INFO)\s{2,}(.*)$")

results = []


def ok(name, detail):
    results.append((True, name, detail))


def bad(name, detail):
    results.append((False, name, detail))


def check(cond, name, detail):
    (ok if cond else bad)(name, detail)


def run(config):
    proc = subprocess.run(
        [sys.executable, CHECKER, "--config", config, "--root", ROOT],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    text = proc.stdout.decode("utf-8", "replace")
    rows = {}
    for line in text.splitlines():
        m = ROW.match(line.strip())
        if m:
            rows[m.group(1)] = m.group(2)
    return proc.returncode, rows, text


def read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def fixture_key(path):
    """取出 fixture 里的 anonKey 字面量，用于 S4 的泄漏断言。"""
    m = re.search(r"""anonKey\s*:\s*(["'])(.*?)\1""", read(path), re.S)
    return m.group(2) if m else ""


def main():
    if not os.path.isdir(FIXTURES):
        print("FAIL fixtures directory missing: %s" % FIXTURES)
        return 2
    present = sorted(f for f in os.listdir(FIXTURES) if f.endswith(".js"))

    # --- S1 语料非空 ---
    check(len(present) >= 10, "S1 fixture corpus is non-empty", "fixtures=%d" % len(present))

    # --- S2 目录与期望表一一对应 ---
    orphan = sorted(set(present) - set(EXPECT))
    ghost = sorted(set(EXPECT) - set(present))
    check(not orphan and not ghost, "S2 every fixture is exercised, every expectation has a fixture",
          "unexercised=%s missing=%s" % (orphan or "none", ghost or "none"))

    exits = {}
    leaks = []
    info_states = set()

    for name in present:
        if name not in EXPECT:
            continue
        path = os.path.join(FIXTURES, name)
        want_exit, want_rows = EXPECT[name]
        code, rows, text = run(path)
        exits[name] = code

        check(code == want_exit, "%s exit code" % name, "got=%d want=%d" % (code, want_exit))
        for item, want in sorted(want_rows.items()):
            got = rows.get(item, "<absent>")
            check(got == want, "%s %s" % (name, item), "got=%s want=%s" % (got, want))

        if "I1" in rows:
            info_states.add(rows["I1"])

        # --- S4 素材：输出里不得出现 key 的任何可辨识片段 ---
        key = fixture_key(path)
        if len(key) >= 16:
            for probe in (key, key[:24], key.split(".")[1][:20] if "." in key else ""):
                if probe and probe in text:
                    leaks.append("%s leaked %d chars" % (name, len(probe)))
                    break

    # --- S3 既能过也能挂 ---
    check(0 in exits.values() and 1 in exits.values(),
          "S3 checker can both pass and fail (not a constant)",
          "exit0=%d exit1=%d" % (list(exits.values()).count(0), list(exits.values()).count(1)))

    # --- S4 无泄漏 ---
    check(not leaks, "S4 no key material appears in checker output",
          "leaks=%s" % (", ".join(leaks) if leaks else "none"))

    # --- S5 降级页不能把判定顶成 READY ---
    # missing.js 就是仓库当前的降级状态：降级路径完好（I1 存在），但判定必须是 NOT READY。
    code_missing, rows_missing, text_missing = run(os.path.join(FIXTURES, "missing.js"))
    check(rows_missing.get("I1") == "INFO" and code_missing == 1
          and "NOT READY" in text_missing,
          "S5 a healthy degradation path cannot pass as Portal readiness",
          "I1=%s exit=%d verdict=%s" % (rows_missing.get("I1"), code_missing,
                                        "NOT READY" if "NOT READY" in text_missing else "READY"))
    check(info_states <= {"INFO"}, "S5b degradation row is always INFO, never a graded item",
          "observed=%s" % (sorted(info_states) or "none"))

    passed = 0
    for good, name, detail in results:
        print("%s %s | %s" % ("PASS" if good else "FAIL", name, detail))
        if good:
            passed += 1
    print("")
    print("=== PORTAL CONFIG CHECK CONTRACT: %d/%d PASSED ===" % (passed, len(results)))
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
