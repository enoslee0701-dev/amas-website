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
for f in $(git ls-files '*.html'); do
  node -e "
    const fs=require('fs');const s=fs.readFileSync('$f','utf8');
    const m=[...s.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
    for(const x of m){ if(/src=/.test(x[0].split('>')[0])) continue; new Function(x[1]); }
  " || { echo "语法错误: $f"; exit 1; }
done

echo "== 3/3 回归脚本（如存在） =="
[ -x scripts/regress.sh ] && scripts/regress.sh
[ -f package.json ] && grep -q '"test"' package.json && npm test --silent

echo "VERIFY OK"
