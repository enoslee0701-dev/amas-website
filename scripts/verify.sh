#!/usr/bin/env bash
# CSC 验证门槛：任一步失败即退出非零
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "== 1/3 Java 编译 + 测试 =="
if [ -f pom.xml ] || ls */pom.xml >/dev/null 2>&1; then
  for p in $(find . -maxdepth 2 -name pom.xml -not -path '*/node_modules/*'); do
    (cd "$(dirname "$p")" && mvn -q -DskipTests=false test)
  done
fi

echo "== 2/3 单文件 HTML 语法 =="
# 按 script type 分流：JS 查语法、JSON-LD 等查 JSON、未知 type 报错（详见脚本头注释）
node scripts/check-inline-scripts.mjs

echo "== 3/3 回归脚本（如存在） =="
[ -x scripts/regress.sh ] && scripts/regress.sh
[ -f package.json ] && grep -q '"test"' package.json && npm test --silent

echo "VERIFY OK"
