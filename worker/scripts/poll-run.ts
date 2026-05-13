// Poll cloud_activity for a runId, emit each new event as a single
// stdout line until run_completed lands or 5 min elapses.
// Used by the A.9 Monitor to watch the integrated smoke without blocking.
import postgres from "postgres";

const RUN_ID = process.env.POLL_RUN_ID;
const DB = process.env.DATABASE_URL_POOLER;
if (!RUN_ID || !DB) {
  console.error("missing POLL_RUN_ID or DATABASE_URL_POOLER");
  process.exit(2);
}

const sql = postgres(DB, { max: 1, prepare: false });
let lastSeen = new Date(0).toISOString();
const deadline = Date.now() + 5 * 60_000;
let done = false;

function compact(s: string, n = 140) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

while (!done && Date.now() < deadline) {
  try {
    const rows = await sql<
      Array<{ activity_type: string; payload: Record<string, unknown>; created_at: Date }>
    >`
      SELECT activity_type, payload, created_at
      FROM public.cloud_activity
      WHERE agent_run_id = ${RUN_ID} AND created_at > ${lastSeen}::timestamptz
      ORDER BY created_at ASC
    `;
    for (const row of rows) {
      lastSeen = new Date(row.created_at).toISOString();
      const t = row.activity_type;
      const p = row.payload;
      if (t === "tool_call_start") {
        console.log(`${t}: ${(p as { tool?: string }).tool ?? "?"}`);
      } else if (t === "tool_call_end") {
        const res = (p as { result?: { code?: string; error?: string } }).result;
        if (res?.code) console.log(`${t}: ERROR ${res.code}: ${compact(String(res.error ?? ""))}`);
        else console.log(`${t}: ok`);
      } else if (t === "output_dispatched") {
        const ch = (p as { channel?: string }).channel;
        const rcpt = (p as { recipient_or_key?: string }).recipient_or_key;
        console.log(`${t}: channel=${ch} ${compact(rcpt ?? "")}`);
      } else if (t === "output_failed") {
        const ch = (p as { channel?: string }).channel;
        const err = (p as { error?: { code?: string; message?: string } }).error;
        console.log(`${t}: channel=${ch} code=${err?.code} ${compact(err?.message ?? "")}`);
      } else if (t === "final_answer") {
        console.log(`${t}: ${compact(String((p as { text?: string }).text ?? ""))}`);
      } else if (t === "run_completed") {
        console.log(`${t}: status=${(p as { status?: string }).status} reason=${(p as { stopReason?: string }).stopReason}`);
        done = true;
      } else if (t === "run_started" || t === "browserbase_session_attached") {
        console.log(`${t}`);
      }
    }
  } catch (e) {
    console.error("poll error:", (e as Error).message);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

await sql.end({ timeout: 5 });
if (!done) console.log("TIMEOUT: no run_completed within 5 min");
