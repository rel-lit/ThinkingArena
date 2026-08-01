#!/usr/bin/env bash
# 一次性试跑验证脚本（验证后删除）：CLI 子进程 + inbox 投喂 3 条 whisper。
# 投喂纪律（F2 不缓冲）：gate_input_received 确认上一条被消费后再投下一条；
# 若撞上 gate_waiting 落盘与泵注册等待的间隙被 no_waiting_gate 拒收，则重投。
set -u
cd /d/RLDemos/ThinkingArena
RUN_DIR=$(mktemp -d /tmp/isekai-demo-XXXX)
echo "run_dir=$RUN_DIR"
node cli/run.ts --bundle bundles/isekai-mvp --run-dir "$RUN_DIR" --mock-llm bundles/isekai-mvp/mock-llm.script.json --poll-interval-ms 50 > "$RUN_DIR/stdout.json" 2> "$RUN_DIR/stderr.log" &
CLI_PID=$!
count_of() { local C; C=$(grep -c "\"type\":\"$1\"" "$RUN_DIR/script.jsonl" 2>/dev/null || true); echo "${C:-0}"; }
for i in 1 2 3; do
  fed=0
  for n in $(seq 1 600); do
    if [ "$(count_of gate_input_received)" -ge "$i" ]; then fed=1; break; fi
    if [ "$(count_of gate_waiting)" -ge "$i" ]; then
      echo "{\"kind\":\"whisper\",\"text\":\"试跑注入第 $i 条\",\"targets\":[\"protagonist\"],\"mode\":\"steering\"}" >> "$RUN_DIR/director_inbox.jsonl"
      sleep 0.5 # 等一轮泵消费；被拒则下一轮重投
    else
      sleep 0.1
    fi
  done
  if [ "$fed" != "1" ]; then echo "gate $i never consumed"; kill $CLI_PID 2>/dev/null; exit 1; fi
done
wait $CLI_PID
echo "cli_exit=$?"
cat "$RUN_DIR/stdout.json"
echo "--- stderr ---"
cat "$RUN_DIR/stderr.log"
echo "--- 事件类型计数 ---"
grep -o '"type":"[a-z_]*"' "$RUN_DIR/script.jsonl" | sort | uniq -c | sort -rn
