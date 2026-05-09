// CLOUD-AGENT-PLAN §10.1 + BUILD-LOOP E.2 — sub-agent runner abstraction.
// The spawn_subagent tool calls SubagentRunner.run() to spawn an inner
// opencode session with a restricted tool set. Production wires this to
// opencode's nested-session API; tests use StubSubagentRunner.

export interface SubagentTranscriptEntry {
  role: "model" | "tool" | "system";
  text: string;
}

export interface SubagentResult {
  /** Final answer the subagent emitted via final_answer (or null on cap-out). */
  finalAnswer: string | null;
  transcript: ReadonlyArray<SubagentTranscriptEntry>;
  /** Why the subagent stopped: 'final_answer' | 'max_turns' | 'error'. */
  stopReason: "final_answer" | "max_turns" | "error";
  turnsUsed: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SubagentSpawn {
  goal: string;
  allowedTools: ReadonlyArray<string>;
  maxTurns: number;
  writable: boolean;
  parentRunId: string;
  workspaceId: string;
}

export interface SubagentRunner {
  run(input: SubagentSpawn): Promise<SubagentResult>;
}

/**
 * Test double — returns a deterministic transcript shape based on the
 * spawn input. Useful for asserting parent-side handling without booting
 * opencode.
 */
export class StubSubagentRunner implements SubagentRunner {
  constructor(private readonly script?: (input: SubagentSpawn) => Promise<SubagentResult>) {}

  async run(input: SubagentSpawn): Promise<SubagentResult> {
    if (this.script) return this.script(input);
    return {
      finalAnswer: `[stub] subagent finished: ${input.goal}`,
      transcript: [
        { role: "system", text: `subagent goal: ${input.goal}` },
        { role: "model", text: "ok, on it." },
        { role: "model", text: "[stub] subagent finished" },
      ],
      stopReason: "final_answer",
      turnsUsed: 2,
      inputTokens: 100,
      outputTokens: 50,
    };
  }
}

/**
 * Validate the parent's requested allowedTools against the registry —
 * returns the intersection. The tool itself enforces the filter (the
 * subagent's opencode session only sees the intersection at boot).
 */
export function intersectTools(
  registry: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>,
): string[] {
  const set = new Set(allowed);
  return registry.filter((name) => set.has(name));
}
