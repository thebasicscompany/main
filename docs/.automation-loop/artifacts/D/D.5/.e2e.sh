#!/bin/bash
# D.5 — live synthetic Composio webhook e2e.
# Builds a signed POST to /webhooks/composio and verifies the full
# trigger_event_log + cloud_runs + SQS dispatch + worker pickup flow.
set -uo pipefail

JWT=$(cat /tmp/jwt.txt)
API="https://api.trybasics.ai"
WS="139e7cdc-7060-49c8-a04f-2afffddbd708"
LOG="docs/.automation-loop/artifacts/D/D.5/e2e-webhook-flow.log"
SECRET=$(cat /tmp/composio_secret.txt | tr -d '\n')

: > "$LOG"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
jq_print() { python -m json.tool 2>/dev/null || cat; }

# 1. Create automation with a composio_webhook trigger.
log "=== 1. POST /v1/automations (with composio_webhook trigger) ==="
CREATE=$(curl -sS -X POST "$API/v1/automations" \
  -H "Authorization: Bearer $JWT" -H "content-type: application/json" \
  -d '{"name":"D.5 webhook routing e2e","goal":"Echo the inputs you received as a final_answer.","outputs":[],"triggers":[{"type":"composio_webhook","toolkit":"gmail","event":"GMAIL_NEW_GMAIL_MESSAGE"}]}')
echo "$CREATE" | jq_print | tee -a "$LOG"
AID=$(echo "$CREATE" | python -c 'import sys,json; print(json.load(sys.stdin)["automation"]["id"])')
log "AID=$AID"

# 2. Insert a composio_triggers row manually (since Gmail connection is expired,
#    real Composio createTrigger fails; we simulate the trigger registration).
log "=== 2. INSERT composio_triggers row (simulated trigger registration) ==="
TRIGGER_ID="ti_d5_e2e_$(date +%s)"
log "TRIGGER_ID=$TRIGGER_ID"

# 3. Build the signed webhook request.
WEBHOOK_ID="wh_evt_d5_$(date +%s)"
TIMESTAMP=$(date +%s)
PAYLOAD=$(python -c "
import json
print(json.dumps({
  'type':'composio.trigger.message',
  'id': '$WEBHOOK_ID',
  'metadata': { 'trigger_id': '$TRIGGER_ID', 'connected_account_id': 'ca_test' },
  'data': { 'messageId': 'msg_test_xyz', 'subject': 'D.5 synthetic test', 'from': 'test@example.com', 'snippet': 'this is a synthetic Composio webhook event for D.5 verification' },
}))
")
log "payload bytes=${#PAYLOAD}"

# Sign HMAC-SHA256({id}.{ts}.{body}) base64.
SIG_BASE=$(python -c "
import sys, base64, hmac, hashlib
msg = f'$WEBHOOK_ID.$TIMESTAMP.$PAYLOAD'.encode()
secret = '$SECRET'.encode()
print(base64.b64encode(hmac.new(secret, msg, hashlib.sha256).digest()).decode())
")
# Composio sends sig in form 'v1,<base64>'.
SIGNATURE="v1,$SIG_BASE"
log "signature=v1,...${SIG_BASE: -8}"

# Save AID + trigger_id for the MCP step.
echo "AID=$AID" > docs/.automation-loop/artifacts/D/D.5/.ids
echo "TRIGGER_ID=$TRIGGER_ID" >> docs/.automation-loop/artifacts/D/D.5/.ids
echo "WEBHOOK_ID=$WEBHOOK_ID" >> docs/.automation-loop/artifacts/D/D.5/.ids
echo "TIMESTAMP=$TIMESTAMP" >> docs/.automation-loop/artifacts/D/D.5/.ids
echo "$PAYLOAD" > docs/.automation-loop/artifacts/D/D.5/.payload.json
echo "$SIGNATURE" > docs/.automation-loop/artifacts/D/D.5/.sig

log "(now insert the composio_triggers row via MCP, then run the second script .e2e2.sh)"
