#!/usr/bin/env bash
# ============================================================
# G1 的真实 SQL 验证：在一个**本脚本自己新建的一次性库**里装完全部迁移，
# 然后执行 checks.sql。
#
# ⚠ 它**只**会连本机，且**只**会用自己刚建出来的库 —— 库名带时间戳，
#   不接受外部指定库名，跑完默认删掉。它不会、也无法接触任何既有数据。
#
# 前置条件（本会话没有、也不安装）：
#   · 一个本机 PostgreSQL 14+，psql 在 PATH 上
#   · 一个能 CREATE DATABASE 的本机超级用户
# 用法：
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres bash scripts/verify-g1/run.sh
#   KEEP=1 ...   跑完保留这个库以便排查
# ============================================================
set -euo pipefail

command -v psql >/dev/null || { echo "没有 psql —— 这一步做不了，按 NOT_RUN 记。"; exit 2; }

HOST="${PGHOST:-127.0.0.1}"
case "$HOST" in
  127.0.0.1|localhost|::1|/*) ;;
  *) echo "拒绝：PGHOST=$HOST 不是本机。本脚本只在本机的一次性库上跑。"; exit 2;;
esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DB="amas_g1_verify_$(date +%Y%m%d%H%M%S)_$$"

echo "== 新建一次性库 $DB =="
psql -v ON_ERROR_STOP=1 -d postgres -c "create database \"$DB\""
cleanup() {
  if [ "${KEEP:-}" = "1" ]; then echo "== 保留 $DB（KEEP=1）=="; return; fi
  psql -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists \"$DB\"" >/dev/null 2>&1 || true
  echo "== 已删除 $DB =="
}
trap cleanup EXIT

echo "== 垫片 =="
psql -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/scripts/verify-g1/prelude.sql" >/dev/null

echo "== 按序装迁移 =="
for f in "$ROOT"/supabase/migrations/*.sql; do
  printf '   %s\n' "$(basename "$f")"
  psql -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
done

echo "== 执行 checks.sql =="
psql -v ON_ERROR_STOP=1 -d "$DB" -f "$ROOT/scripts/verify-g1/checks.sql"
echo "== 全部断言通过 =="
