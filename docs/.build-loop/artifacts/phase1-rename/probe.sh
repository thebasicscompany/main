#!/usr/bin/env bash
# E2E probe — Phase 1 cloud_* rename + new api routes verification.
# Usage:
#   doppler run --project backend --config dev -- bash probe.sh
set -e

BASE="${BASE:-https://api.trybasics.ai}"
JWT="$(node docs/.build-loop/artifacts/phase1-rename/sign-jwt.mjs)"
WS="139e7cdc-7060-49c8-a04f-2afffddbd708"

H=(-H "Authorization: Bearer $JWT" -H "Content-Type: application/json")

echo "=== 1. health (anon) ==="
curl -s "$BASE/health"

echo; echo "=== 2. /v1/runtime/health (auth) ==="
curl -s "${H[@]}" "$BASE/v1/runtime/health"

echo; echo "=== 3. POST /v1/runs ==="
RUN=$(curl -sS "${H[@]}" -X POST "$BASE/v1/runs" -d '{"goal":"phase1 e2e probe — say HELLO"}')
echo "$RUN"
RUN_ID=$(echo "$RUN" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).runId||"")}catch{console.log("")}})')
CLOUD_AGENT_ID=$(echo "$RUN" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).cloudAgentId||"")}catch{console.log("")}})')
echo "runId=$RUN_ID  cloudAgentId=$CLOUD_AGENT_ID"

echo; echo "=== 4. GET /v1/runs?cloudAgentId=$CLOUD_AGENT_ID ==="
curl -sS "${H[@]}" "$BASE/v1/runs?cloudAgentId=$CLOUD_AGENT_ID&limit=5" | head -c 800; echo

echo; echo "=== 5. GET /v1/skills ==="
curl -sS "${H[@]}" "$BASE/v1/skills?limit=5" | head -c 800; echo

echo; echo "=== 6. POST /v1/schedules ==="
SCHED_BODY=$(jq -n --arg ca "$CLOUD_AGENT_ID" '{cloudAgentId:$ca, cron:"rate(1 day)", goal:"e2e probe schedule"}')
curl -sS "${H[@]}" -X POST "$BASE/v1/schedules" -d "$SCHED_BODY"

echo; echo "=== 7. GET /v1/schedules/$CLOUD_AGENT_ID ==="
curl -sS "${H[@]}" "$BASE/v1/schedules/$CLOUD_AGENT_ID"

echo; echo "=== 8. DELETE /v1/schedules/$CLOUD_AGENT_ID ==="
curl -sS "${H[@]}" -X DELETE "$BASE/v1/schedules/$CLOUD_AGENT_ID"

echo; echo "=== 9. GET /v1/assistants/ (Arav's existing endpoint smoke) ==="
curl -sS "${H[@]}" "$BASE/v1/assistants" -o /dev/null -w 'http=%{http_code}\n'

echo; echo "DONE"
