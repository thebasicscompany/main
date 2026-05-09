// BUILD-LOOP A.6 verify probe — confirm the Supavisor pooler URL works
// and prove multiplexing.
//
// Reads DATABASE_URL_POOLER from env (Doppler-injected in dev: e.g.
// `doppler run --project backend --config dev -- pnpm tsx scripts/probe-pooler.ts`).
// Falls back to a CLI arg for one-off runs without Doppler.
//
// Default mode: opens 1 connection, runs SELECT now(), closes.
// `--multiplex` mode: opens 50 parallel "Lambda-ish" connections (each
// imitates a cold-start Lambda — fresh client, single SELECT, close) and
// confirms the Supabase pg_stat_activity backend-connection count stays
// well under 50, proving the pooler multiplexes.

import postgres from "postgres";

const argv = process.argv.slice(2);
const multiplex = argv.includes("--multiplex");
const concurrency = Number(
  argv.find((a) => a.startsWith("--n="))?.slice(4) ?? 50,
);
const url =
  argv.find((a) => a.startsWith("--url="))?.slice(6) ??
  process.env.DATABASE_URL_POOLER;

if (!url) {
  console.error(
    "DATABASE_URL_POOLER is not set. Pass --url=<pooler-url> or run via Doppler.",
  );
  process.exit(2);
}

if (!url.includes(".pooler.supabase.com")) {
  console.error(
    "URL doesn't look like a Supavisor pooler URL (expected host like aws-0-us-east-2.pooler.supabase.com).",
  );
  process.exit(2);
}

async function singleProbe(): Promise<void> {
  const sql = postgres(url!, { max: 1, prepare: false, idle_timeout: 5 });
  try {
    const rows = await sql<[{ now: Date }]>`SELECT now()`;
    console.log("OK pooler connect; server time:", rows[0]?.now);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function multiplexProbe(): Promise<void> {
  console.log(
    `Spinning ${concurrency} parallel "Lambda-ish" connections via Supavisor…`,
  );
  const start = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      const sql = postgres(url!, { max: 1, prepare: false, idle_timeout: 5 });
      try {
        await sql`SELECT now()`;
      } finally {
        await sql.end({ timeout: 5 });
      }
    }),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const fail = results.length - ok;
  const elapsedMs = Date.now() - start;
  console.log(
    `Done in ${elapsedMs}ms — ${ok}/${results.length} ok, ${fail} failed.`,
  );

  // Now check backend-connection count. We use a fresh client and query
  // pg_stat_activity. If multiplexing works, total backends should be ≤ ~10.
  const sql = postgres(url!, { max: 1, prepare: false, idle_timeout: 5 });
  try {
    const rows = await sql<[{ n: number }]>`
      SELECT count(*)::int AS n
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND backend_type = 'client backend'
    `;
    const n = rows[0]?.n ?? 0;
    console.log(`pg_stat_activity client backends: ${n}`);
    if (n > 25) {
      console.warn(
        `WARN: ${n} backends — pooler may not be multiplexing as expected.`,
      );
      process.exit(1);
    } else {
      console.log("OK multiplexing — backend count is well under launched concurrency.");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (fail > 0) process.exit(1);
}

(multiplex ? multiplexProbe() : singleProbe()).catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
