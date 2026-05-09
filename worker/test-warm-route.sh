#!/usr/bin/env bash
# G.5 atomic warm-route test. Run from the repo root.
set -euo pipefail

WS=139e7cdc-7060-49c8-a04f-2afffddbd708
ACC=aa9dd140-def8-4e8e-9955-4acc04e11fea
QURL=https://sqs.us-east-1.amazonaws.com/635649352555/basics-runs.fifo
REGION=us-east-1

R1=00000000-0000-4f3b-aaaa-0000000a0060
R2=00000000-0000-4f3b-aaaa-0000000a0061

now() { date +%s; }

send() {
  local rid=$1 url=$2
  local body
  body=$(printf '{"runId":"%s","workspaceId":"%s","accountId":"%s","goal":"Use goto_url to open %s, then call final_answer with text DONE."}' \
    "$rid" "$WS" "$ACC" "$url")
  aws sqs send-message --queue-url "$QURL" --message-body "$body" \
    --message-group-id "$WS:default" \
    --message-deduplication-id "warmtest-$rid-$(now)" \
    --region "$REGION" >/dev/null
}

# Wait until the run has a row in agent_activity with type=run_completed.
# Polls Postgres via the local psql or via curl-to-Supabase; for ease,
# we shell out to the supabase mcp from the bash side via aws cli is wrong.
# Instead, just inspect via psql if available, else sleep + caller polls.
echo "T0=$(now)  cold-start dispatch r1"
T0=$(now)
send "$R1" "https://example.com"
echo "$T0" > /tmp/warmtest-t0.txt
echo "$R1" > /tmp/warmtest-r1.txt
echo "$R2" > /tmp/warmtest-r2.txt
echo "Sent r1 at T0; poll agent_activity via supabase MCP for run_completed."
