#!/usr/bin/env bash
# 执行者唤醒器 v2 —— 放在 <仓库>/scripts/，后台常驻：
#   cd <仓库> && nohup bash scripts/executor-watch.sh >> logs/watch.log 2>&1 &
#
# 干四件事（监工只读它写出来的文件，自己不跑命令）：
#   1. 每 5 分钟把现场写进 logs/status.txt（心跳、提交、队列计数、执行者状态、verify 结果）
#   2. 队列出现 ASSIGNED 且无执行者在跑 → claude -p 启动执行者一次
#   3. 执行者退出后若队列为 REVIEW → 独立跑一次 scripts/verify.sh，结果写 logs/verify-last.txt
#   4. 执行者超过 2 小时 → 杀掉，标 STUCK，写 BLOCKED.md
# 暂停：touch .git/pause（只写状态，不启动执行者）。兼容 macOS 自带 bash 3.2。
set -u
# macOS: 若系统 git 因 Xcode 许可被挡，改用 CommandLineTools 的 git（不需要 sudo）
if [ -x /Library/Developer/CommandLineTools/usr/bin/git ]; then
  export DEVELOPER_DIR="/Library/Developer/CommandLineTools"
fi
REPO="$(cd "$(dirname "$0")/.." && pwd)"
QUEUE="$REPO/QUEUE.md"
LOCK="$REPO/.executor.lock"
STATUS="$REPO/logs/status.txt"
VERIFY_LAST="$REPO/logs/verify-last.txt"
INTERVAL=300
MAX_RUN=7200

cd "$REPO" || exit 1
mkdir -p logs logs/evidence
now() { date '+%F %T %z'; }
sedi() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }
count() { grep -c "^状态: $1\$" "$QUEUE" 2>/dev/null || true; }
executor_running() { [[ -f "$LOCK" ]] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; }

write_status() {
  local exec_state="idle"
  executor_running && exec_state="running pid=$(cat "$LOCK") since=$(date -r "$LOCK" '+%F %T' 2>/dev/null)"
  local paused="no"; [[ -f .git/pause ]] && paused="yes"
  {
    echo "updated: $(now)"
    echo "repo: $REPO"
    echo "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
    echo "head: $(git log -1 --format='%h %ci %s' 2>/dev/null)"
    echo "dirty: $(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    echo "watcher_pid: $$"
    echo "executor: $exec_state"
    echo "paused: $paused"
    echo "queue: ASSIGNED=$(count ASSIGNED) REVIEW=$(count REVIEW) TODO=$(count TODO) DONE=$(count DONE) STUCK=$(count STUCK) NEED_ENOS=$(count NEED_ENOS) RED=$(count RED)"
    if [[ -f "$VERIFY_LAST" ]]; then echo "verify_last: $(head -2 "$VERIFY_LAST" | tr '\n' ' ')"; else echo "verify_last: none"; fi
  } > "$STATUS.tmp" && mv "$STATUS.tmp" "$STATUS"
  git log -20 --format='%h %ci %s' > logs/gitlog.txt 2>/dev/null
}

run_verify() {
  local full=0
  awk '/^### /{r=0} /^状态: REVIEW/{r=1} r&&/VERIFY_FULL=1/{print 1; exit}' "$QUEUE" | grep -q 1 && full=1
  echo "[$(now)] 执行者已退出且队列为 REVIEW，独立跑 verify.sh (VERIFY_FULL=$full)"
  VERIFY_FULL=$full bash scripts/verify.sh > logs/verify-last.log 2>&1
  local rc=$?
  { echo "time: $(now)"; echo "rc: $rc"; echo "---"; tail -30 logs/verify-last.log; } > "$VERIFY_LAST"
  echo "[$(now)] verify rc=$rc"
}

mark_stuck() {
  sedi '1,/^状态: ASSIGNED/s/^状态: ASSIGNED/状态: STUCK/' "$QUEUE"
  printf '## [%s] %s · 执行者超时\n状态: STUCK\n原因: 单次执行超过 2 小时被 watch 脚本终止\n---\n%s' \
    "$(now)" "$(basename "$REPO")" "$(cat BLOCKED.md 2>/dev/null)" > BLOCKED.md
}

echo "[$(now)] watcher 启动 repo=$REPO"
while true; do
  write_status
  if executor_running || [[ -f .git/pause ]]; then sleep "$INTERVAL"; continue; fi
  rm -f "$LOCK"

  if grep -q '^状态: ASSIGNED' "$QUEUE" 2>/dev/null; then
    echo "[$(now)] ASSIGNED 发现，启动执行者"
    (
      claude -p \
        "你是执行者。先读 EXECUTOR.md，再读 QUEUE.md，执行唯一的 ASSIGNED 任务，写好 logs/evidence 证据，按规则改状态后退出。" \
        --permission-mode acceptEdits &
      cmd_pid=$!
      ( sleep "$MAX_RUN"; kill -TERM "$cmd_pid" 2>/dev/null ) &
      watchdog_pid=$!
      wait "$cmd_pid" 2>/dev/null
      rc=$?
      if kill -0 "$watchdog_pid" 2>/dev/null; then
        kill "$watchdog_pid" 2>/dev/null; wait "$watchdog_pid" 2>/dev/null
      else
        rc=124
      fi
      echo "[$(now)] 执行者退出 rc=$rc"
      if [[ $rc -eq 124 ]]; then
        echo "[$(now)] 执行超过 2 小时，标 STUCK"; mark_stuck
      elif grep -q '^状态: REVIEW' "$QUEUE"; then
        run_verify
      fi
      rm -f "$LOCK"
      write_status
    ) &
    echo $! > "$LOCK"
  fi
  sleep "$INTERVAL"
done
