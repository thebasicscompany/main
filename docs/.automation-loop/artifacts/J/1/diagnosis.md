# J.1 — Worker pool death root-cause diagnosis

**Date:** 2026-05-14
**Symptom:** Worker pools die ~15–25 minutes into long runs; the LP Mapper run on Jim Joyal hung at exactly that mark and required a manual cancel + re-add. Watcher / Digest / second Mapper attempt all completed because they each ran <5 min.

## Evidence

7 recent stopped basics-worker ECS tasks (cluster `basics-agent`, captured 2026-05-14 16:50Z):

| Task ID | Duration | Stop Code | Exit | Stopped Reason |
|---------|----------|-----------|------|----------------|
| 23d8033f | 15.6 min | EssentialContainerExited | 0 | Essential container exited |
| 2a97b486 | 24.1 min | EssentialContainerExited | 0 | Essential container exited |
| 2aefa861 | 15.6 min | EssentialContainerExited | 0 | Essential container exited |
| 392441fe | 25.2 min | UserInitiated | 137 | autoscaler: idle reap |
| 50bedbde | 16.8 min | UserInitiated | 137 | autoscaler: idle reap |
| 7a39ca44 | 34.6 min | UserInitiated | 137 | autoscaler: idle reap |

Raw data: `task-stop-events.json`.

Two patterns:
1. **EssentialContainerExited + exit 0** — the worker process self-shut-down cleanly. The 15.6 min cluster matches the worker's `IDLE_STOP_MS=15min` default exactly.
2. **UserInitiated + exit 137 + "autoscaler: idle reap"** — the autoscaler's `reapIdlePools()` issued an ECS `StopTask`. Pool was deemed idle even though a run was bound to it.

## Root cause

**`worker/src/main.ts:589` tracks the wrong thing as "inflight."**

```ts
// line 589 — main NOTIFY handler
inflight.push(promise);
promise.finally(() => {
  const i = inflight.indexOf(promise);
  if (i >= 0) inflight.splice(i, 1);
});
```

`promise` here is the **dispatch promise** — it resolves the moment `postPromptAsync()` returns, i.e., as soon as opencode acknowledges receipt of the prompt and starts working. The opencode session itself can run for 30+ minutes after that. `inflight` is empty within seconds of the NOTIFY landing, even when there's an active opencode session grinding on a long pipeline.

The idle-stop watchdog (line 603-610) only checks `inflight`:

```ts
const timer = setInterval(async () => {
  const idle = Date.now() - lastActivity;
  if (inflight.length === 0 && idle >= IDLE_STOP_MS) {
    clearInterval(timer);
    console.log("worker: idle threshold reached", { idleMs: idle });
    resolve();   // ← triggers worker self-shutdown
    return;
  }
  ...
}, HEARTBEAT_MS);
```

`lastActivity` is bumped to `Date.now()` on line 587 right after dispatch setup — it does NOT get refreshed by opencode SSE events as the session does work. So once the dispatch promise resolves and 15 minutes elapse with no NEW NOTIFY landing, the worker exits cleanly. This matches the EssentialContainerExited+exit 0+15.6 min pattern exactly.

There's a separate `inflightSessions` Map (line 561, 786) that tracks **actual opencode sessions** and is keyed by sessionID. It would have been the correct signal — non-empty when a session is in flight, deleted only on terminal `session.idle / session.error / session.deleted` events. The watchdog uses the wrong map.

## Secondary issue: autoscaler reap

The autoscaler reap (`worker/autoscaler/handler.ts:reapIdlePools`) checks:
- `cloud_pools.slots_used = 0` AND
- `NOT EXISTS open binding (ended_at IS NULL)` AND
- `NOT EXISTS recent binding (created_at > now() - REAP_AFTER_MS)`

These checks are correct in principle. The reap fires after the worker already self-shut-down via the bug above: clean shutdown calls `clearPool(sql, POOL_ID)` (line 630) which closes bindings and zeroes slots. So the reaped pools were already corpses. The autoscaler is reacting correctly to bad data; the data is bad because the worker shut itself down with a session still running.

The exit-137 UserInitiated cases at 25.2/16.8/34.6 min are also consistent with the worker first hitting `IDLE_STOP_MS`, attempting graceful shutdown via SIGTERM, opencode subprocess refusing to die in time, then ECS killing the task with SIGKILL.

## Verdict

**Single root cause: the worker watchdog tracks dispatch promises (`inflight`) instead of live opencode sessions (`inflightSessions`).** Fix is one line of logic in the watchdog plus bumping `lastActivity` on SSE events so an active session keeps the worker alive.

J.2 should:
1. Change `if (inflight.length === 0 && ...)` → `if (inflightSessions.size === 0 && inflight.length === 0 && ...)`.
2. Bump `lastActivity = Date.now()` inside `handleOpencodeEvent` so any tool call or message part keeps the watchdog at bay.
3. Leave `IDLE_STOP_MS=15min` for truly-idle reaping (a worker that's done all its work for 15 min should still shut down to free Fargate spend).

The autoscaler does not need changes for J.2; J.3's orphan-redispatch still adds a safety net.
