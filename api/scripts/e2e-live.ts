/**
 * Live smoke test: real Anthropic (text + tool_use), Gemini, optional API SSE + managed Anthropic proxy.
 *
 * Usage:
 *   # Providers only (keys from Doppler)
 *   doppler run --project backend --config dev -- pnpm exec tsx scripts/e2e-live.ts
 *
 *   # Include API hops (JWT secret must match the API — origin env or same Doppler config)
 *   E2E_API_BASE_URL=http://127.0.0.1:3001 doppler run --project backend --config dev -- pnpm exec tsx scripts/e2e-live.ts
 *
 *   # Railway / remote (use service env so WORKSPACE_JWT_SECRET matches deployment):
 *   cd api && railway run -- env E2E_API_BASE_URL='https://<your>.up.railway.app' pnpm exec tsx scripts/e2e-live.ts
 *
 * Runner needs ANTHROPIC_API_KEY only for direct Anthropic SDK checks; Gemini uses GEMINI_API_KEY or
 * GOOGLE_GENERATIVE_AI_API_KEY. Remote /v1/llm SSE uses Gemini on the server (no local Gemini required).
 * Managed Anthropic proxy requires ANTHROPIC_* on the server — if unset, we log skip on 503.
 * Set `E2E_SKIP_RUNTIME_CAP_CHECK=true` to skip GET /health capability assertion (not recommended).
 */
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'
import { SignJWT } from 'jose'
import { randomUUID } from 'node:crypto'

const TOOL_NAME = 'submit_ping'
const TOOL_PROOF = 'tool_roundtrip_ok'

async function mintWorkspaceJwt(secret: string): Promise<string> {
  const now = Date.now()
  const payload = {
    workspace_id: randomUUID(),
    account_id: randomUUID(),
    plan: 'enterprise' as const,
    seat_status: 'active',
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 3600e3).toISOString(),
  }
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(secret))
}

async function pingAnthropic(apiKey: string): Promise<void> {
  const model =
    process.env.E2E_ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-20250514'
  const client = new Anthropic({ apiKey })
  const msg = await client.messages.create({
    model,
    max_tokens: 24,
    messages: [{ role: 'user', content: 'Reply with exactly the word pong.' }],
  })
  const block = msg.content.find((b) => b.type === 'text')
  const text = block?.type === 'text' ? block.text : ''
  if (!/\bpong\b/i.test(text)) {
    console.warn('anthropic unexpected body:', text.slice(0, 200))
  }
  console.log('anthropic_ok', { usage: msg.usage })
}

/**
 * Forces a `tool_use` block via `tool_choice` and validates JSON tool input.
 */
async function anthropicToolRoundTrip(apiKey: string): Promise<void> {
  const model =
    process.env.E2E_ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-20250514'
  const client = new Anthropic({ apiKey })
  const tools: Anthropic.Tool[] = [
    {
      name: TOOL_NAME,
      description:
        'Submit a short proof string from the runtime integration test harness.',
      input_schema: {
        type: 'object',
        properties: {
          proof: { type: 'string', description: 'Proof token' },
        },
        required: ['proof'],
      },
    },
  ]

  const msg = await client.messages.create({
    model,
    max_tokens: 512,
    tools,
    tool_choice: {
      type: 'tool',
      name: TOOL_NAME,
      disable_parallel_tool_use: true,
    },
    messages: [
      {
        role: 'user',
        content: `Call ${TOOL_NAME} exactly once with proof exactly "${TOOL_PROOF}" (no surrounding quotes in the field value).`,
      },
    ],
  })

  const tu = msg.content.find((b) => b.type === 'tool_use')
  if (!tu || tu.type !== 'tool_use') {
    throw new Error(
      `anthropic tools: expected tool_use, got ${JSON.stringify(msg.content).slice(0, 400)}`,
    )
  }
  if (tu.name !== TOOL_NAME) {
    throw new Error(`anthropic tools: expected tool ${TOOL_NAME}, got ${tu.name}`)
  }
  const input = tu.input as { proof?: string }
  if (input?.proof !== TOOL_PROOF) {
    throw new Error(`anthropic tools: bad input ${JSON.stringify(input)}`)
  }
  console.log('anthropic_tool_roundtrip_ok', { usage: msg.usage })
}

async function pingGemini(apiKey: string): Promise<void> {
  const genai = new GoogleGenAI({ apiKey })
  const res = await genai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: 'Reply with exactly the word pong.' }] }],
  })
  const text = res.text ?? ''
  if (!/\bpong\b/i.test(text)) {
    console.warn('gemini unexpected body:', text.slice(0, 200))
  }
  console.log('gemini_ok')
}

type ParsedSseEvent = { event: string; data: string }

/** Split complete SSE messages (blank-line delimited); may leave an incomplete tail in `rest`. */
function drainSseBlocks(buffer: string): { events: ParsedSseEvent[]; rest: string } {
  const events: ParsedSseEvent[] = []
  const parts = buffer.split('\n\n')
  const rest = parts.pop() ?? ''
  for (const block of parts) {
    let ev = ''
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) ev = line.slice(6).trimStart()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (ev && dataLines.length > 0) {
      events.push({ event: ev, data: dataLines.join('\n') })
    }
  }
  return { events, rest }
}

/**
 * Ensures we are hitting a runtime image that actually mounts `/v1/llm/managed/*`.
 * Stale Railway deploys answer 404 `{ error: not_found }` for managed proxy.
 */
async function assertRemoteRuntimeCapabilities(baseUrl: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}/health`
  const r = await fetch(url)
  if (!r.ok) {
    throw new Error(`GET /health failed ${r.status}`)
  }
  const j = (await r.json()) as { capabilities?: { llm_managed_proxy?: boolean } }
  if (j.capabilities?.llm_managed_proxy !== true) {
    throw new Error(
      [
        'GET /health missing `capabilities.llm_managed_proxy`.',
        'Redeploy the Basics runtime from the monorepo root (see railway.toml — Root Directory must not be `/api`).',
        'Until then, `/v1/llm/managed/*` returns 404 on stale images.',
      ].join(' '),
    )
  }
  console.log('e2e_live: GET /health — llm_managed_proxy capability present')
}

async function verifyApiLlmSse(baseUrl: string, jwt: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/llm`
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [
        {
          role: 'user',
          content:
            'Reply with one English word only: use exactly the word oranges (lowercase). No punctuation.',
        },
      ],
      model: 'gemini-2.5-flash',
      max_tokens: 64,
    }),
  })

  if (!r.ok) {
    const errBody = await r.text()
    throw new Error(`POST /v1/llm failed ${r.status}: ${errBody.slice(0, 500)}`)
  }

  const reader = r.body?.getReader()
  if (!reader) throw new Error('no response body')

  const dec = new TextDecoder()
  let buf = ''
  let tokenText = ''
  let sawDone = false
  let tokensOut = 0

  const applyEvents = (events: ParsedSseEvent[]) => {
    for (const e of events) {
      if (e.event === 'token') {
        try {
          const j = JSON.parse(e.data) as { text?: string }
          if (typeof j.text === 'string') tokenText += j.text
        } catch {
          /* ignore malformed chunk */
        }
      }
      if (e.event === 'done') {
        sawDone = true
        try {
          const j = JSON.parse(e.data) as { tokens_output?: number }
          if (typeof j.tokens_output === 'number') tokensOut = j.tokens_output
        } catch {
          /* ignore */
        }
      }
      if (e.event === 'error') {
        throw new Error(`/v1/llm SSE error event: ${e.data.slice(0, 500)}`)
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (value) buf += dec.decode(value, { stream: true })
    const drained = drainSseBlocks(buf)
    buf = drained.rest
    applyEvents(drained.events)
    if (done) break
  }

  const tail = drainSseBlocks(buf.endsWith('\n\n') ? buf : `${buf}\n\n`)
  applyEvents(tail.events)

  if (!/\boranges\b/i.test(tokenText)) {
    throw new Error(
      `unexpected streamed assistant text (want "oranges"): ${JSON.stringify(tokenText.slice(0, 200))}`,
    )
  }
  if (!sawDone) {
    throw new Error('SSE missing done event')
  }
  if (tokensOut <= 0) {
    console.warn('api_llm_sse: tokens_output missing or zero (Gemini usage metadata)')
  }
  console.log('api_llm_sse_ok', { streamedLen: tokenText.length, tokens_output: tokensOut })
}

async function verifyManagedAnthropicTools(
  baseUrl: string,
  jwt: string,
): Promise<'ok' | 'skipped_no_upstream_key' | 'skipped_route_missing'> {
  const model =
    process.env.E2E_ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-20250514'
  const url = `${baseUrl.replace(/\/$/, '')}/v1/llm/managed/anthropic/v1/messages`
  const body = {
    model,
    max_tokens: 512,
    tools: [
      {
        name: TOOL_NAME,
        description:
          'Submit a short proof string from the runtime integration test harness.',
        input_schema: {
          type: 'object',
          properties: { proof: { type: 'string' } },
          required: ['proof'],
        },
      },
    ],
    tool_choice: {
      type: 'tool',
      name: TOOL_NAME,
      disable_parallel_tool_use: true,
    },
    messages: [
      {
        role: 'user',
        content: `Call ${TOOL_NAME} exactly once with proof exactly "${TOOL_PROOF}".`,
      },
    ],
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!r.ok) {
    const errBody = await r.text()
    if (r.status === 503 && errBody.includes('no_credential')) {
      console.log(
        'api_managed_anthropic: skip (503 no_credential — set ANTHROPIC_PLATFORM_KEY or ANTHROPIC_API_KEY on API)',
      )
      return 'skipped_no_upstream_key'
    }
    if (r.status === 404 && /\bnot_found\b/.test(errBody)) {
      console.log(
        'api_managed_anthropic: skip (404 not_found — deploy may predate POST /v1/llm/managed/anthropic/v1/messages)',
      )
      return 'skipped_route_missing'
    }
    throw new Error(`managed anthropic ${r.status}: ${errBody.slice(0, 800)}`)
  }

  const json = (await r.json()) as {
    content?: Array<{ type: string; name?: string; input?: unknown }>
  }
  const tu = json.content?.find((b) => b.type === 'tool_use')
  if (!tu || tu.name !== TOOL_NAME) {
    throw new Error(
      `managed anthropic: expected ${TOOL_NAME} tool_use, got ${JSON.stringify(json).slice(0, 700)}`,
    )
  }
  const input = tu.input as { proof?: string }
  if (input?.proof !== TOOL_PROOF) {
    throw new Error(`managed anthropic: bad tool input ${JSON.stringify(input)}`)
  }
  console.log('api_managed_anthropic_tools_ok')
  return 'ok'
}

async function main(): Promise<void> {
  if (!process.env.E2E_API_BASE_URL?.trim() && process.env.RAILWAY_PUBLIC_DOMAIN?.trim()) {
    process.env.E2E_API_BASE_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim()}`
    console.log(`e2e_live: inferred E2E_API_BASE_URL from RAILWAY_PUBLIC_DOMAIN`)
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim()
  const geminiKey =
    process.env.GEMINI_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()
  const base = process.env.E2E_API_BASE_URL?.trim()
  const jwtSecret = process.env.WORKSPACE_JWT_SECRET?.trim()
  const requireProviders = process.env.E2E_REQUIRE_LOCAL_PROVIDERS === 'true'
  const requireApi = process.env.E2E_REQUIRE_API === 'true'

  let ranAnything = false

  if (!anthropicKey) {
    console.log(
      'e2e_live: skip direct Anthropic SDK (unset ANTHROPIC_API_KEY; set E2E_REQUIRE_LOCAL_PROVIDERS=true to fail)',
    )
    if (requireProviders) throw new Error('ANTHROPIC_API_KEY is required when E2E_REQUIRE_LOCAL_PROVIDERS=true')
  } else {
    console.log('e2e_live: Anthropic text + tools…')
    await pingAnthropic(anthropicKey)
    await anthropicToolRoundTrip(anthropicKey)
    ranAnything = true
  }

  if (!geminiKey) {
    console.log(
      'e2e_live: skip direct Gemini SDK (unset GEMINI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY)',
    )
    if (requireProviders) throw new Error('GEMINI_API_KEY is required when E2E_REQUIRE_LOCAL_PROVIDERS=true')
  } else {
    console.log('e2e_live: Gemini (local SDK ping)…')
    await pingGemini(geminiKey)
    ranAnything = true
  }

  if (requireApi && !(base && jwtSecret && jwtSecret.length >= 8)) {
    throw new Error(
      'E2E_REQUIRE_API=true needs E2E_API_BASE_URL and WORKSPACE_JWT_SECRET matching the deployed API',
    )
  }

  if (base && jwtSecret && jwtSecret.length >= 8) {
    console.log('e2e_live: API', base, '(SSE Gemini + managed Anthropic)…')
    if (process.env.E2E_SKIP_RUNTIME_CAP_CHECK === 'true') {
      console.log('e2e_live: warn — skipping GET /health capability check (E2E_SKIP_RUNTIME_CAP_CHECK)')
    } else {
      await assertRemoteRuntimeCapabilities(base)
    }
    const jwt = await mintWorkspaceJwt(jwtSecret)
    await verifyApiLlmSse(base, jwt)
    await verifyManagedAnthropicTools(base, jwt)
    ranAnything = true
  } else {
    console.log(
      'e2e_live: skip API hops (set E2E_API_BASE_URL + WORKSPACE_JWT_SECRET for /v1/llm + managed proxy)',
    )
  }

  if (!ranAnything) {
    throw new Error(
      'Nothing to run — set ANTHROPIC_API_KEY (+ GEMINI optional) or E2E_API_BASE_URL + WORKSPACE_JWT_SECRET',
    )
  }

  console.log('e2e_live: all checks passed')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
