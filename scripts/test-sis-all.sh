#!/usr/bin/env bash
# 学员管理系统一键自测：数据库（一次性 PGlite）→ Edge 入口 → 调用契约 → 页面（本机 stub）。
#   bash scripts/test-sis-all.sh          只跑学员管理系统相关
#   bash scripts/test-sis-all.sh --full   另加既有门户回归 9 套与 verify.sh
# 环境：PGLITE_DIR（见 scripts/run-sql-local.mjs 文件头）；CHROME_PATH 或 CHROME（可选，默认找本机 Chrome）。
# 缺环境的那一项记为 NOT_RUN 并使总结果失败 —— 不把「没跑」当成「通过」。
# 不连任何真实库、不发外网请求、不写远端。
set -u
cd "$(dirname "$0")/.."
[ -z "${CHROME_PATH:-}" ] && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && \
  export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

pass=0; fail=0; notrun=0
row() { printf '  %-8s %-34s %s\n' "$1" "$2" "$3"; }
run() {  # 名称 命令…
  local name="$1"; shift
  local out; out="$("$@" 2>&1)"; local code=$?
  local last; last="$(printf '%s\n' "$out" | grep -E 'PASS|FAIL|通过|不一致|VERIFY|PASSED|NOT_RUN|找不到' | tail -1)"
  if [ $code -eq 0 ]; then pass=$((pass+1)); row PASS "$name" "$last"
  elif [ $code -eq 2 ]; then notrun=$((notrun+1)); row NOT_RUN "$name" "$last"
  else fail=$((fail+1)); row FAIL "$name" "$last"; printf '%s\n' "$out" | grep -E 'FAIL' | head -5 | sed 's/^/           /'
  fi
}

echo "== 数据库（0001–最新迁移装进一次性库）"
run "SQL 全流程闭环 + 一至四期 + 补全 + R-8" node scripts/run-sql-local.mjs \
  supabase/tests/sis0_lifecycle_e2e.sql supabase/tests/sis1_acceptance.sql supabase/tests/sis2_acceptance.sql \
  supabase/tests/sis3_acceptance.sql supabase/tests/portal2b_irreversible_guard.sql
echo "== Edge Function 与调用契约"
run "sis-admin 入口"            node scripts/test-sis-admin-edge.mjs
run "页面 ↔ 数据库函数契约"      node scripts/check-sis-rpc-contract.mjs
echo "== 页面（本机 stub 浏览器）"
run "第一期页面"                node scripts/test-sis-pages.mjs
run "第二至四期页面"            node scripts/test-sis2-pages.mjs
run "补全页面"                  node scripts/test-sis3-pages.mjs
run "官网报名收件箱"            node scripts/test-inbox-page.mjs
run "官网提交先存后台"          node scripts/test-submit-db-first.mjs

if [ "${1:-}" = "--full" ]; then
  echo "== 既有门户回归"
  for t in test-portal-pages test-admin-writes test-admin-read-boundary test-admin-dialog-race test-admin-confirm-race \
           test-admin-keyboard test-admin-keyboard-journey test-portal-degraded test-noconfig-degraded test-aal-unknown; do
    run "$t" node "scripts/$t.mjs"
  done
  run "verify.sh" bash scripts/verify.sh
fi

echo
echo "SIS ALL: ${pass} PASS / ${fail} FAIL / ${notrun} NOT_RUN"
[ $fail -eq 0 ] && [ $notrun -eq 0 ]
