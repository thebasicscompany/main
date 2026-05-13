#!/usr/bin/env python3
"""D.5 — synthetic composio webhook e2e (signed).
Builds payload + signature, prints them so the operator can POST via curl.
"""
import os, sys, time, json, base64, hmac, hashlib, pathlib

ROOT = pathlib.Path(__file__).resolve().parent
ids = {}
for line in (ROOT / ".ids").read_text().splitlines():
    if "=" in line:
        k, v = line.split("=", 1); ids[k] = v

trigger_id = ids["TRIGGER_ID"]
webhook_id = ids.get("WEBHOOK_ID") or f"wh_evt_d5_{int(time.time())}"
timestamp = str(int(time.time()))
ids["WEBHOOK_ID"] = webhook_id
ids["TIMESTAMP"] = timestamp

payload = {
    "type": "composio.trigger.message",
    "id": webhook_id,
    "metadata": {"trigger_id": trigger_id, "connected_account_id": "ca_test"},
    "data": {
        "messageId": "msg_test_xyz",
        "subject": "D.5 synthetic test",
        "from": "test@example.com",
        "snippet": "this is a synthetic Composio webhook event for D.5 verification",
    },
}
body = json.dumps(payload, separators=(",", ":"))

secret_path = os.environ.get("COMPOSIO_SECRET_FILE") or "/tmp/composio_secret.txt"
secret = pathlib.Path(secret_path).read_text().strip().encode()
msg = f"{webhook_id}.{timestamp}.{body}".encode()
sig = base64.b64encode(hmac.new(secret, msg, hashlib.sha256).digest()).decode()
signature = f"v1,{sig}"

(ROOT / ".payload.json").write_text(body)
(ROOT / ".sig").write_text(signature)
(ROOT / ".ids").write_text("\n".join(f"{k}={v}" for k, v in ids.items()) + "\n")

print(f"WEBHOOK_ID={webhook_id}")
print(f"TIMESTAMP={timestamp}")
print(f"SIGNATURE_TAIL=...{sig[-8:]}")
print(f"body_len={len(body)}")
