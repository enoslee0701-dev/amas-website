#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Portal 真实配置的本地发布前检查（离线，只读，不联网、不登录、不部署）。

用法:
    python scripts/check-portal-config.py                 # 检查仓库当前配置
    python scripts/check-portal-config.py --config <path> # 检查指定配置文件（fixture 用）
    python scripts/check-portal-config.py --example       # 打印安全配置样例，不含任何真实值

退出码: 0 = 全部 READY；1 = 存在缺口；2 = 用法或内部错误。

设计约束（来自督工指令，逐条对应代码）：
  * 绝不输出 secret —— anon key 的任何字节都不打印，只打印结构性判定；
    project ref 打印时中段掩码。service_role key 一旦出现在客户端配置里，直接判 BLOCKED。
  * 不自动填写生产配置 —— 本脚本只读，不写任何文件。
  * 不以降级页通过冒充 Portal 就绪 —— 降级渲染只在 INFO 区呈现，
    其结果在数学上无法影响最终判定（见 verdict()：只看 gap 计数）。

为什么不复用已有脚本：仓库内 check-cache-bust.py 只管资源戳号；
docs/operations/RELEASE-READINESS-REPORT.md 是 2026-09-07 的一次性报告快照，
不是可重复执行的命令。故新建本检查，并复用既有约定（ASCII 运行时输出、
反空过哨兵、PASS/FAIL 行格式）。
"""

import argparse
import base64
import json
import os
import re
import sys
import time

READY, MISSING, INVALID, BLOCKED, INFO = "READY", "MISSING", "INVALID", "BLOCKED", "INFO"
GAP_STATES = {MISSING, INVALID, BLOCKED}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG = os.path.join("assets", "js", "supabase-config.js")
AUTH_JS = os.path.join("assets", "js", "portal", "auth.js")
SKIP_DIRS = {".git", ".claude", "node_modules", "docs", "supabase"}

# 占位符识别。区分 MISSING（没填）与 INVALID（填错了）很重要 ——
# 两者给出的下一步动作不同：前者去 dashboard 取值，后者去查为什么取错。
# 首版只做了串首锚定，于是 "https://<project-ref>.supabase.co" 被判成 INVALID。
PLACEHOLDER_HEAD = re.compile(
    r"^(your|<|xxx+|todo|changeme|replace|placeholder|example)", re.I)
# 模板字面量：角括号在合法 URL 与 base64url token 里都不可能出现，
# 因此「任意位置含 < 或 >」是零误报的占位符信号。
PLACEHOLDER_ANY = re.compile(r"[<>]|your[-_ ]?project|yourproject", re.I)


def is_placeholder(value):
    """留空也算占位 —— 配置文件注释明说「留空 = 仅邮件通道，网站正常工作」。"""
    if value is None or not value.strip():
        return True
    return bool(PLACEHOLDER_HEAD.match(value) or PLACEHOLDER_ANY.search(value))


class Report(object):
    def __init__(self):
        self.rows = []

    def add(self, item, status, detail):
        self.rows.append((item, status, detail))

    def gaps(self):
        return [r for r in self.rows if r[1] in GAP_STATES]

    def emit(self):
        width = max(len(r[0]) for r in self.rows) if self.rows else 4
        for item, status, detail in self.rows:
            print("%-*s  %-7s  %s" % (width, item, status, detail))


# ---------------------------------------------------------------- helpers

def read(path):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read()


def mask_ref(ref):
    """project ref 不是 secret，但没有理由整串回显。保留首尾各 4 位。"""
    if not ref:
        return "(none)"
    if len(ref) <= 9:
        return ref[:2] + "***"
    return ref[:4] + "*" * (len(ref) - 8) + ref[-4:]


def parse_config(text):
    """从 window.SUPA = {...} 里取出 url 与 anonKey 的字面量。

    刻意不用 JSON 解析 —— 这是 JS 源文件，允许注释与尾逗号。
    取不到时返回 None，由调用方判定为 INVALID 而不是崩溃。
    """
    out = {}
    for key in ("url", "anonKey"):
        m = re.search(r"""\b%s\s*:\s*(["'])(.*?)\1""" % key, text, re.S)
        out[key] = m.group(2) if m else None
    if not re.search(r"window\.SUPA\s*=", text):
        return None
    return out


def decode_jwt_payload(token):
    """只解 payload，不验签（客户端 anon key 本就公开，此处只看结构与 role）。"""
    parts = token.split(".")
    if len(parts) != 3:
        return None, "expected 3 dot-separated segments, got %d" % len(parts)
    seg = parts[1]
    seg += "=" * (-len(seg) % 4)
    try:
        raw = base64.urlsafe_b64decode(seg.encode("ascii"))
        return json.loads(raw.decode("utf-8")), None
    except Exception as exc:                      # noqa: BLE001 - 任何解码失败都归为格式错误
        return None, "payload is not decodable base64url JSON (%s)" % type(exc).__name__


# ---------------------------------------------------------------- checks

def check_config(rep, config_path):
    """P1-P6：配置文件本身。返回 (url, payload) 供后续检查复用。"""
    if not os.path.isfile(config_path):
        rep.add("P1 config-file", MISSING, "not found: %s" % config_path)
        return None, None
    text = read(config_path)
    cfg = parse_config(text)
    if cfg is None:
        rep.add("P1 config-file", INVALID, "%s does not assign window.SUPA" % config_path)
        return None, None
    shown = config_path
    try:
        rel = os.path.relpath(config_path, ROOT)
        if not rel.startswith(".."):
            shown = rel.replace("\\", "/")
    except ValueError:                            # 跨盘符时 relpath 会抛，退回原路径
        pass
    rep.add("P1 config-file", READY, "parsed %s" % shown)

    # --- P2 url ---
    url = cfg.get("url")
    ref_from_url = None
    if url is None:
        rep.add("P2 supabase-url", INVALID, "key 'url' not found in window.SUPA")
    elif is_placeholder(url):
        rep.add("P2 supabase-url", MISSING,
                "url is empty or a placeholder -> Portal runs in degraded mode")
    elif not url.startswith("https://"):
        rep.add("P2 supabase-url", INVALID, "url must use https, got scheme %r" % url.split(":")[0])
    else:
        host = url[len("https://"):].split("/")[0]
        m = re.match(r"^([a-z0-9]{16,32})\.supabase\.(co|in)$", host)
        if m:
            ref_from_url = m.group(1)
            rep.add("P2 supabase-url", READY, "https://%s.supabase.co" % mask_ref(ref_from_url))
        elif re.match(r"^[a-z0-9.-]+\.[a-z]{2,}$", host):
            rep.add("P2 supabase-url", READY, "custom https host (ref cross-check skipped)")
        else:
            rep.add("P2 supabase-url", INVALID, "host does not look like a hostname")

    # --- P3/P4/P5/P6 anon key ---
    key = cfg.get("anonKey")
    payload = None
    if key is None:
        rep.add("P3 anon-key-shape", INVALID, "key 'anonKey' not found in window.SUPA")
    elif is_placeholder(key):
        rep.add("P3 anon-key-shape", MISSING,
                "anonKey is empty or a placeholder -> Portal runs in degraded mode")
    else:
        payload, err = decode_jwt_payload(key)
        if payload is None:
            rep.add("P3 anon-key-shape", INVALID, err)
        else:
            rep.add("P3 anon-key-shape", READY, "valid JWT structure, len=%d" % len(key))

    if payload is not None:
        role = payload.get("role")
        if role == "service_role":
            rep.add("P4 anon-key-role", BLOCKED,
                    "SERVICE_ROLE KEY IN CLIENT CONFIG - remove it and rotate that key now")
        elif role == "anon":
            rep.add("P4 anon-key-role", READY, "role=anon")
        else:
            rep.add("P4 anon-key-role", INVALID, "role=%r, expected 'anon'" % role)

        exp = payload.get("exp")
        if not isinstance(exp, int):
            rep.add("P5 anon-key-exp", INFO, "no exp claim (non-expiring key)")
        elif exp <= time.time():
            rep.add("P5 anon-key-exp", INVALID,
                    "expired at %s UTC" % time.strftime("%Y-%m-%d", time.gmtime(exp)))
        else:
            rep.add("P5 anon-key-exp", READY,
                    "valid until %s UTC" % time.strftime("%Y-%m-%d", time.gmtime(exp)))

        ref_from_key = payload.get("ref")
        if ref_from_url is None or not ref_from_key:
            rep.add("P6 url-key-pairing", INFO, "cross-check not applicable")
        elif ref_from_key == ref_from_url:
            rep.add("P6 url-key-pairing", READY, "key ref matches url ref")
        else:
            rep.add("P6 url-key-pairing", INVALID,
                    "key belongs to a different project than the url (ref mismatch)")
    return url, payload


# 调用形态有三种，少覆盖一种就会漏判。首版只写了前两种，漏掉 A.callFn(...)
# 形式的 5 个调用点，扫出「2 个被调用函数」并据此报 READY —— 结论碰巧为真，
# 过程是坏的。CALL_SITE 与 LITERAL_CALL 必须成对维护，P7c 负责在它们漂移时喊停。
DIRECT_URL = re.compile(r"/functions/v1/([a-z0-9][a-z0-9_-]{2,})")
LITERAL_CALL = re.compile(r"""(?:callFn|\bfn)\s*\(\s*["']([a-z0-9][a-z0-9_-]{2,})["']""")
CALL_SITE = re.compile(r"""(?:callFn|\bfn)\s*\(""")


def called_edge_functions(root):
    """从客户端代码里收集被真实调用的 Edge Function 名，并量化静态扫描的盲区。

    覆盖的三种形态：
      fetch(SUPA.url + "/functions/v1/<name>")   直接拼 URL
      AmasApi.fn("<name>", ...)                  经 api.js 包装
      A.callFn("<name>", ...)                    直连 auth.js 的包装

    返回 (names, literal_sites, total_sites)。names 只含字面量；
    total - literal 即变量传名的调用点数量，属于本检查查不到的盲区，
    如实登记而不是假装不存在。
    """
    names = set()
    literal_sites = 0
    total_sites = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if not name.endswith((".js", ".html")):
                continue
            text = read(os.path.join(dirpath, name))
            names.update(DIRECT_URL.findall(text))
            lit = LITERAL_CALL.findall(text)
            names.update(lit)
            literal_sites += len(lit)
            total_sites += len(CALL_SITE.findall(text))
    return names, literal_sites, total_sites


def check_edge_functions(rep, root):
    called, literal_sites, total_sites = called_edge_functions(root)
    fn_dir = os.path.join(root, "supabase", "functions")
    if not os.path.isdir(fn_dir):
        rep.add("P7 edge-functions", MISSING, "supabase/functions/ not found")
        return
    declared = set(d for d in os.listdir(fn_dir)
                   if os.path.isfile(os.path.join(fn_dir, d, "index.ts")))
    if not called:
        # 一个字面量都没扫到，几乎一定是扫描器坏了而不是真没有调用 —— 不许空过。
        rep.add("P7 edge-functions", INVALID,
                "no edge function call sites found at all - scanner is probably broken")
        return
    missing = sorted(called - declared)
    if missing:
        rep.add("P7 edge-functions", MISSING,
                "called but not implemented: %s" % ", ".join(missing))
    else:
        rep.add("P7 edge-functions", READY,
                "source present for all %d called functions (DEPLOYMENT STATUS UNKNOWN): %s"
                % (len(called), ", ".join(sorted(called))))
    unused = sorted(declared - called)
    if unused:
        rep.add("P7b unused-functions", INFO,
                "implemented but not called from this repo (may serve the App): %s" % ", ".join(unused))

    # P7c 漂移哨兵：调用点总数与解析出名字的调用点数之差 = 变量传名的盲区。
    # 首版漏了 callFn 形态时，这个差值会立刻变大并暴露扫描器落后于代码。
    dynamic = total_sites - literal_sites
    if dynamic < 0:
        rep.add("P7c scanner-drift", INVALID, "call-site accounting is inconsistent")
    elif dynamic > 0:
        rep.add("P7c scanner-drift", INFO,
                "%d call site(s) pass the function name as a variable - "
                "outside what a static scan can verify" % dynamic)
    else:
        rep.add("P7c scanner-drift", READY,
                "all %d edge function call sites resolved to literal names" % total_sites)


def portal_pages(root):
    """所有加载 portal/auth.js 的页面 —— 即 Portal 的真实运行面。"""
    pages = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if not name.endswith(".html"):
                continue
            path = os.path.join(dirpath, name)
            text = read(path)
            if "portal/auth.js" in text:
                pages.append((os.path.relpath(path, root).replace("\\", "/"), text))
    return pages


def check_runtime_deps(rep, root, pages):
    """P8：配置值正确还不够 —— CONFIGURED 还要求 window.supabase 存在。

    任何一个 Portal 页漏掉 supabase-config.js 或 supabase-js CDN，
    该页在运行时就会静默降级，与配置是否填对无关。
    """
    if not pages:
        rep.add("P8 runtime-deps", INVALID, "no portal pages found - scanner is probably broken")
        return
    bad = []
    for rel, text in pages:
        miss = []
        if "supabase-config.js" not in text:
            miss.append("config")
        if "supabase-js@2" not in text:
            miss.append("supabase-js")
        if miss:
            bad.append("%s(%s)" % (rel, "+".join(miss)))
    if bad:
        rep.add("P8 runtime-deps", MISSING, "pages missing runtime deps: %s" % ", ".join(bad[:8]))
    else:
        rep.add("P8 runtime-deps", READY,
                "all %d portal pages load both supabase-config.js and supabase-js" % len(pages))


def check_deploy_paths(rep, root, pages):
    """P9/P10：子路径部署下的路径解析。

    auth.js 用 siteRoot() 从 location.pathname 里切出站点根，靠一个目录名白名单。
    白名单从 auth.js 源码里现取，而不是在这里抄一份 —— 抄一份就会漂移。
    """
    auth_path = os.path.join(root, AUTH_JS)
    if not os.path.isfile(auth_path):
        rep.add("P9 site-root-markers", MISSING, "%s not found" % AUTH_JS)
        return
    src = read(auth_path)
    m = re.search(r"p\.match\(/\^\(\.\*\?\)\\/\(([a-z|_-]+)\)\\//", src)
    if not m:
        rep.add("P9 site-root-markers", INVALID,
                "could not extract the siteRoot() marker list from auth.js")
        return
    markers = set(m.group(1).split("|"))
    uncovered = sorted({rel.split("/")[0] for rel, _ in pages
                        if "/" in rel and rel.split("/")[0] not in markers})
    if uncovered:
        rep.add("P9 site-root-markers", INVALID,
                "portal pages live under dirs siteRoot() does not recognise: %s "
                "-> ROOT resolves wrong on a subpath deployment" % ", ".join(uncovered))
    else:
        rep.add("P9 site-root-markers", READY,
                "all portal page dirs covered by siteRoot() markers (%d markers)" % len(markers))

    abs_refs = []
    ref_re = re.compile(
        r"""<(?:script|link|img|source|a|iframe|form)\b[^>]*?\b(?:src|href|action)\s*="""
        r"""\s*["'](/(?!/)[^"']*)["']""", re.I)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if not name.endswith(".html"):
                continue
            path = os.path.join(dirpath, name)
            for hit in ref_re.findall(read(path)):
                abs_refs.append("%s -> %s" % (os.path.relpath(path, root).replace("\\", "/"), hit))
    if abs_refs:
        rep.add("P10 subpath-safety", INVALID,
                "root-absolute refs break a subpath deployment: %s" % "; ".join(abs_refs[:5]))
    else:
        rep.add("P10 subpath-safety", READY, "no root-absolute refs in HTML")


def check_degradation(rep, root):
    """INFO 区：降级路径是否完好。

    刻意登记为 INFO 且从不进入 gap 计数 —— 降级页渲染正常
    说明的是「缺配置时不崩溃」，与「Portal 就绪」是两件事，
    绝不允许前者替后者背书。
    """
    auth_path = os.path.join(root, AUTH_JS)
    if not os.path.isfile(auth_path):
        return
    src = read(auth_path)
    has = "renderDisabled" in src and "门户系统尚未启用" in src
    rep.add("I1 degraded-path", INFO,
            "graceful degradation present (NOT evidence of readiness)" if has
            else "degradation notice not found - unconfigured pages may render blank")


# ---------------------------------------------------------------- example

EXAMPLE = """\
Safe configuration example - contains NO real values.

  File: assets/js/supabase-config.js

    window.SUPA = {
      url: "https://<project-ref>.supabase.co",
      anonKey: "<anon public key>"
    };

  Where to get them:
    Supabase dashboard -> Settings -> API
      Project URL     -> url
      anon public key -> anonKey

  Rules:
    * Use the ANON PUBLIC key only. It is the only key meant to reach a browser.
    * NEVER paste the service_role key here. It bypasses RLS. This checker
      reports BLOCKED if it finds one, and that key must then be rotated.
    * Leaving both fields empty is a valid state: the site stays up and the
      Portal renders its "not yet enabled" page. That is degradation, not readiness.
    * This file ships to the browser. Do not put anything secret in it.
"""


# ---------------------------------------------------------------- main

def verdict(rep):
    """最终判定只数 gap。INFO 行（含降级页）在数学上无法影响结果。"""
    gaps = rep.gaps()
    total = len([r for r in rep.rows if r[1] != INFO])
    ready = len([r for r in rep.rows if r[1] == READY])
    print("")
    if gaps:
        print("=== PORTAL CONFIG PREFLIGHT: %d/%d READY, %d GAP(S) -> NOT READY ==="
              % (ready, total, len(gaps)))
        print("")
        print("Gaps to close, in order:")
        for item, status, detail in gaps:
            print("  [%s] %s: %s" % (status, item, detail))
        print("")
        print("A rendering degradation page is NOT Portal readiness. Run with --example")
        print("for a safe configuration template.")
        return 1
    # 措辞必须严格：本检查看的是磁盘上的配置形状与源码存在性，全部离线。
    # 它无法证明 Edge Function 已部署、无法证明 auth/RLS 生效、
    # 无法证明 Portal 可发布。把这三件事写在通过行里，免得 READY 被读成「就绪」。
    print("=== PORTAL CONFIG PREFLIGHT: %d/%d CONFIG-SHAPE READY ===" % (ready, total))
    print("")
    print("Scope of this result - what it does and does not establish:")
    print("  ESTABLISHED : config values are present and well-formed on disk;")
    print("                edge function SOURCE exists; portal pages load their runtime deps;")
    print("                subpath-safe paths.")
    print("  NOT CHECKED : whether those functions are DEPLOYED and reachable;")
    print("                whether auth, RLS or any policy actually works;")
    print("                whether any request to the project succeeds.")
    print("  VERDICT     : configuration-shape ready. LIVE VERIFICATION UNKNOWN.")
    print("                This is NOT Portal release readiness.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Portal release preflight (offline, read-only)")
    ap.add_argument("--config", default=None, help="path to the supabase config js (for fixtures)")
    ap.add_argument("--root", default=ROOT, help="repository root to scan")
    ap.add_argument("--example", action="store_true", help="print a safe config template and exit")
    ap.add_argument("--local", action="store_true",
                    help="check the local-only override (assets/js/supabase-config.local.js) "
                         "instead of the committed config")
    args = ap.parse_args(argv)

    if args.example:
        print(EXAMPLE)
        return 0

    root = os.path.abspath(args.root)
    if args.local:
        # 本地联调旁路：这个文件已 gitignore，永远不会进入发布产物。
        # 检查它是为了在联调前就发现填错（占位符没换、粘成了 service_role 等），
        # 而不是等页面报错才回头找。
        config_path = os.path.join(root, "assets", "js", "supabase-config.local.js")
        if not os.path.isfile(config_path):
            print("=== PORTAL CONFIG CHECK (--local) ===")
            print("  MISSING : assets/js/supabase-config.local.js 不存在。")
            print("            本地联调请先复制模板并填值：")
            print("              cp assets/js/supabase-config.local.example.js \\")
            print("                 assets/js/supabase-config.local.js")
            print("            该文件已列入 .gitignore，不会被提交、不会公开发布。")
            return 1
    else:
        config_path = args.config or os.path.join(root, DEFAULT_CONFIG)

    rep = Report()
    check_config(rep, config_path)
    check_edge_functions(rep, root)
    pages = portal_pages(root)
    check_runtime_deps(rep, root, pages)
    check_deploy_paths(rep, root, pages)
    check_degradation(rep, root)
    rep.emit()
    rc = verdict(rep)
    if args.local:
        print("")
        print("  NOTE: 这是**本地联调专用**配置的检查结果。")
        print("        assets/js/supabase-config.local.js 已 gitignore，不会进入发布产物；")
        print("        它通过**不代表**公开官网已连上任何环境，也不代表 Portal 可发布。")
    return rc


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(2)
