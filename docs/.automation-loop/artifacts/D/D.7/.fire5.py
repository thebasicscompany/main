#!/usr/bin/env python3
"""D.7 — fire 5 signed Composio webhooks in rapid succession."""
import os, sys, time, json, base64, hmac, hashlib, urllib.request, urllib.error, pathlib

TRIGGER_ID = "ti_d7_debounce_1778673500"
SECRET_PATH = os.environ.get("COMPOSIO_SECRET_FILE", "/tmp/composio_secret.txt")
SECRET = pathlib.Path(SECRET_PATH).read_text().strip().encode()

URL = "https://api.trybasics.ai/webhooks/composio"

results = []
for i in range(5):
    wid = f"wh_d7_fire_{int(time.time()*1000)}_{i}"
    ts = str(int(time.time()))
    payload = {
        "type": "composio.trigger.message",
        "id": wid,
        "metadata": {"trigger_id": TRIGGER_ID, "connected_account_id": "ca_test"},
        "data": {"messageId": f"msg_{i}", "subject": f"debounce fire #{i}"},
    }
    body = json.dumps(payload, separators=(",", ":")).encode()
    sig = base64.b64encode(hmac.new(SECRET, f"{wid}.{ts}.".encode() + body, hashlib.sha256).digest()).decode()
    req = urllib.request.Request(
        URL,
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "webhook-id": wid,
            "webhook-timestamp": ts,
            "webhook-signature": f"v1,{sig}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            results.append({"i": i, "status": resp.status, "body": data})
    except urllib.error.HTTPError as e:
        results.append({"i": i, "status": e.code, "body": e.read().decode()[:200]})

print(json.dumps(results, indent=2))
