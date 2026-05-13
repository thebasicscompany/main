#!/bin/bash
# D.2 — live curl e2e for automations CRUD.
set -uo pipefail

JWT=$(cat /tmp/jwt.txt)
API="https://api.trybasics.ai"
LOG="docs/.automation-loop/artifacts/D/D.2/e2e-crud.log"

: > "$LOG"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
jq_print() { python -m json.tool 2>/dev/null || cat; }

log "=== 1. POST /v1/automations (create) ==="
CREATE=$(curl -sS -X POST "$API/v1/automations" \
  -H "Authorization: Bearer $JWT" \
  -H "content-type: application/json" \
  -d '{
    "name": "D.2 e2e test",
    "description": "smoke test of CRUD endpoints",
    "goal": "no-op",
    "outputs": [
      { "channel": "email", "to": "dmrknife@gmail.com", "when": "on_complete" }
    ],
    "triggers": [
      { "type": "manual" },
      { "type": "schedule", "cron": "0 9 * * MON-FRI", "timezone": "America/Los_Angeles" }
    ]
  }')
echo "$CREATE" | jq_print | tee -a "$LOG"
AID=$(echo "$CREATE" | python -c 'import sys,json; print(json.load(sys.stdin)["automation"]["id"])')
log "automation_id=$AID"

log "=== 2. GET /v1/automations/:id ==="
curl -sS "$API/v1/automations/$AID" -H "Authorization: Bearer $JWT" | jq_print | tee -a "$LOG"

log "=== 3. GET /v1/automations (list) ==="
curl -sS "$API/v1/automations?limit=5" -H "Authorization: Bearer $JWT" \
  | python -c 'import sys,json; d=json.load(sys.stdin); print("automations_count=",len(d["automations"]),"  ours_in_list=", any(a["id"]=="'$AID'" for a in d["automations"]))' | tee -a "$LOG"

log "=== 4. PUT /v1/automations/:id  (expect v2 + snapshot) ==="
PUT=$(curl -sS -X PUT "$API/v1/automations/$AID" \
  -H "Authorization: Bearer $JWT" \
  -H "content-type: application/json" \
  -d '{"name": "D.2 e2e test (renamed)", "goal": "no-op updated"}')
echo "$PUT" | jq_print | tee -a "$LOG"
PUT_V=$(echo "$PUT" | python -c 'import sys,json; print(json.load(sys.stdin)["automation"]["version"])')
log "post-PUT version=$PUT_V (expected 2)"

log "=== 5. GET /v1/automations/:id/versions  (expect ≥1 snapshot at v1) ==="
curl -sS "$API/v1/automations/$AID/versions" -H "Authorization: Bearer $JWT" | jq_print | tee -a "$LOG"

log "=== 6. DELETE /v1/automations/:id ==="
curl -sS -X DELETE "$API/v1/automations/$AID" -H "Authorization: Bearer $JWT" | jq_print | tee -a "$LOG"

log "=== 7. GET /v1/automations/:id (expect 404 after archive) ==="
curl -sS "$API/v1/automations/$AID" -H "Authorization: Bearer $JWT" -w "\nHTTP %{http_code}\n" | tee -a "$LOG"

log "=== 8. negative: invalid trigger type → 400 ==="
curl -sS -X POST "$API/v1/automations" \
  -H "Authorization: Bearer $JWT" \
  -H "content-type: application/json" \
  -d '{"name":"bad","goal":"x","triggers":[{"type":"cosmic_ray"}]}' \
  -w "\nHTTP %{http_code}\n" | tee -a "$LOG"

log "=== done ==="
echo "AID=$AID" > docs/.automation-loop/artifacts/D/D.2/.aid
