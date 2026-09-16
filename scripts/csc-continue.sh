#!/usr/bin/env bash
set -euo pipefail

# Stop 钩子：队列还有 GREEN/YELLOW 时阻止 Claude 停机并继续取下一条。
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$root"

queue=""
for candidate in CSC_AUTONOMOUS_QUEUE.md docs/CSC_AUTONOMOUS_QUEUE.md; do
  if [[ -f "$candidate" ]]; then
    queue="$candidate"
    break
  fi
done
[[ -z "$queue" ]] && exit 0

if grep -Eq '^[[:space:]]*-[[:space:]]*\[[[:space:]]\][[:space:]]+T-[0-9]+[[:space:]]*\|[[:space:]]*(GREEN|YELLOW)([[:space:]]*\||[[:space:]]*$)' "$queue"; then
  printf '%s\n' '{"decision":"block","reason":"队列仍有未完成的 GREEN/YELLOW 任务。按 CLAUDE.md 工作循环取下一条继续，不要写总结。"}'
fi
exit 0
