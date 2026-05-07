# Phase 10.5 — EventBridge cron firing deploy notes

This document covers what a deploy round-trip should verify after the
Phase 10.5 changes land. Phase 10.5 adds infra (EventBridge Connection,
API destination, IAM roles) and runtime code (per-workflow rule
management + cron-secret auth on `run-now`). The infra is intentionally
*off* in dev/test: the runtime API treats `EVENTBRIDGE_RULE_PREFIX`
unset as a "no-op mode" so local development never calls AWS.

## What lands in this phase

### Infrastructure (sst.config.ts)
- `RuntimeCronSecret` — sst.Secret holding the shared cron header secret.
- `RuntimeCronConnection` — `aws.cloudwatch.EventConnection`. API_KEY
  auth scheme; key=`X-Cron-Secret`, value=secret above.
- `RuntimeCronApiDestination` — `aws.cloudwatch.EventApiDestination`.
  Targets `${apiService.url}/v1/runtime/workflows/*/run-now`. The `*`
  is substituted at fire time via target HttpParameters.
- `RuntimeCronInvokerRole` — IAM role + policy granting
  `events:InvokeApiDestination` on the destination ARN. Trust policy
  allows `events.amazonaws.com` to assume.
- `RuntimeApiEventBridgePolicy` — inline policy on `apiService.taskRole`
  granting `events:Put/Delete/DescribeRule`,
  `events:Put/Remove/ListTargetsByRule`, `events:ListRules` scoped to
  rules whose name starts with `runtime-workflow-${stage}-*`. Plus
  `iam:PassRole` on the invoker role.

### Runtime code
- `api/src/lib/eventbridge.ts` — `upsertWorkflowSchedule` /
  `deleteWorkflowSchedule` / `validateScheduleExpression`. No-op when
  `EVENTBRIDGE_RULE_PREFIX` is unset.
- `api/src/middleware/cronAuth.ts` — `requireCronOrWorkspaceJwt`.
  Accepts EITHER workspace JWT OR `X-Cron-Secret` header.
- `api/src/routes/workflows.ts` — `/run-now` uses the new auth;
  CRUD lifecycle hooks call upsert/delete on every mutation.
- Schedule validation rejects bare 5-field cron at the route layer
  (returns 400 instead of letting EventBridge PutRule fail at runtime).

## Pre-deploy: set the cron secret

```bash
# Generate a 32-byte random hex secret. Store this somewhere durable
# (Doppler is fine) — re-deploys re-use it; rotation requires
# orchestrating a connection update.
SECRET=$(openssl rand -hex 32)
sst secret set RuntimeCronSecret "$SECRET" --stage production
```

## Deploy round-trip

```bash
sst deploy --stage production
```

This creates the connection, API destination, and IAM role. The first
deploy will surface their ARNs as outputs. Because the destination and
role ARNs are circular w.r.t. `apiService.url` (the destination's
`InvocationEndpoint` references the ALB URL), they're emitted as SST
outputs instead of plumbed back into the service env automatically.

After the first deploy, copy the ARNs into your shell env and re-deploy
to inject them into the API service:

```bash
export EVENTBRIDGE_API_DESTINATION_ARN="$(sst output EventBridgeApiDestinationArn --stage production)"
export EVENTBRIDGE_TARGET_ROLE_ARN="$(sst output EventBridgeTargetRoleArn --stage production)"
sst deploy --stage production
```

The runtime now has every env var it needs:
- `RUNTIME_CRON_SECRET` (from sst.Secret)
- `EVENTBRIDGE_RULE_PREFIX` (deterministic per-stage)
- `EVENTBRIDGE_API_DESTINATION_ARN` (from first-pass output)
- `EVENTBRIDGE_TARGET_ROLE_ARN` (from first-pass output)
- `AWS_REGION` (set in environment block already)

## Post-deploy verification

```bash
# 1. Mint a test JWT (see HANDOFF.md "Real test JWT" section).
TOKEN=...

# 2. Create a workflow with a 2-minute schedule.
WORKFLOW_ID=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Workspace-Token: $TOKEN" \
  -d '{
    "name": "cron smoke",
    "prompt": "navigate to https://example.com",
    "schedule": "cron(0/2 * * * ? *)",
    "check_modules": ["url_contains"]
  }' \
  "$API_URL/v1/runtime/workflows" | jq -r '.id')

# 3. Verify the EventBridge rule was created.
aws events describe-rule \
  --name "runtime-workflow-production-${WORKFLOW_ID}" \
  --region us-east-1

# 4. Wait up to 2 minutes — observe a fired run via /v1/runtime/runs?workflow_id=...
sleep 130
curl -s -H "X-Workspace-Token: $TOKEN" \
  "$API_URL/v1/runtime/runs?workflow_id=$WORKFLOW_ID" | jq '.runs[0]'

# 5. Cleanup. DELETE removes the rule too (idempotent).
curl -s -X DELETE \
  -H "X-Workspace-Token: $TOKEN" \
  "$API_URL/v1/runtime/workflows/$WORKFLOW_ID"

# 6. Confirm the rule is gone.
aws events describe-rule \
  --name "runtime-workflow-production-${WORKFLOW_ID}" \
  --region us-east-1
# Expected: ResourceNotFoundException
```

## Known gotchas

1. **HTTPS requirement.** AWS API destinations require HTTPS. The
   current ALB listener is HTTP-only (custom domain + ACM cert
   temporarily disabled — see HANDOFF.md). The first deploy will
   either error during destination creation OR PutTargets calls will
   fail at fire time with `InvalidParameterValueException`. Workaround:
   keep `EVENTBRIDGE_RULE_PREFIX` unset (no-op mode) until Phase 12
   restores HTTPS, OR temporarily restore the ACM cert + HTTPS
   listener to validate cron firing.

2. **Connection auth header.** EventBridge's API_KEY auth scheme stores
   the secret in an auto-created Secrets Manager secret. The connection
   IAM role auto-grants the destination role `secretsmanager:GetSecretValue`
   on this secret (verified via `aws.cloudwatch.EventConnection`'s
   built-in policy attachment). No manual policy needed.

3. **Rule name length.** EventBridge rule names are capped at 64 chars.
   Our deterministic format `runtime-workflow-{stage}-{uuid}` is
   ~57 chars for `production` — fits, but a longer stage name would
   bust the limit. If you add `staging-eu-west-2` style stages, shorten
   the prefix.

4. **Cron permission scope.** The task role can only manage rules
   matching `runtime-workflow-${stage}-*`. If you ever want to manage
   rules from another tool (CDK, console), use a different prefix or
   they'll fail with AccessDenied.

5. **Schedule validation is permissive.** We check `cron(...)` /
   `rate(...)` syntax shape but don't fully parse cron grammar. A
   malformed-but-shapely schedule like `cron(99 99 99 99 99 99)` will
   pass route validation but fail at PutRule with
   `ValidationException`. Logged + surfaced via the create-failure
   logger but the workflow row is still persisted.

6. **Two-pass deploy.** Because of the circular ARN dependency, the
   first deploy lands the resources but the API service env still has
   empty `EVENTBRIDGE_API_DESTINATION_ARN` / `_ROLE_ARN`. The second
   deploy (with those values exported) populates the env. In no-op
   mode the runtime treats this as "EventBridge disabled" — workflow
   rows can be created with schedules but no rules fire. Better:
   plumb the ARNs through SSM Parameter Store and read at boot — but
   that's a refactor, not blocking for v1.
