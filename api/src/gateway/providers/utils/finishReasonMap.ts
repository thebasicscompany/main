// Pruned: maps for dropped providers (bedrock, google-vertex-ai, deepseek,
// mistral-ai, together-ai, cohere) removed. Restore upstream entries by
// putting their type files back and adding the rows.
import { ANTHROPIC_STOP_REASON } from '../anthropic/types.js';
import { FINISH_REASON, PROVIDER_FINISH_REASON } from '../types.js';
import { GOOGLE_GENERATE_CONTENT_FINISH_REASON } from '../google/types.js';

// TODO: rename this to OpenAIFinishReasonMap
export const finishReasonMap = new Map<PROVIDER_FINISH_REASON, FINISH_REASON>([
  // https://docs.anthropic.com/en/api/messages#response-stop-reason
  [ANTHROPIC_STOP_REASON.stop_sequence, FINISH_REASON.stop],
  [ANTHROPIC_STOP_REASON.end_turn, FINISH_REASON.stop],
  [ANTHROPIC_STOP_REASON.pause_turn, FINISH_REASON.stop],
  [ANTHROPIC_STOP_REASON.tool_use, FINISH_REASON.tool_calls],
  [ANTHROPIC_STOP_REASON.max_tokens, FINISH_REASON.length],
  // https://ai.google.dev/api/generate-content#FinishReason
  [
    GOOGLE_GENERATE_CONTENT_FINISH_REASON.FINISH_REASON_UNSPECIFIED,
    FINISH_REASON.stop,
  ],
  [GOOGLE_GENERATE_CONTENT_FINISH_REASON.STOP, FINISH_REASON.stop],
  [GOOGLE_GENERATE_CONTENT_FINISH_REASON.MAX_TOKENS, FINISH_REASON.length],
  [GOOGLE_GENERATE_CONTENT_FINISH_REASON.SAFETY, FINISH_REASON.content_filter],
  [GOOGLE_GENERATE_CONTENT_FINISH_REASON.RECITATION, FINISH_REASON.stop],
  [
    GOOGLE_GENERATE_CONTENT_FINISH_REASON.LANGUAGE,
    FINISH_REASON.content_filter,
  ],
  [GOOGLE_GENERATE_CONTENT_FINISH_REASON.OTHER, FINISH_REASON.stop],
  [
    GOOGLE_GENERATE_CONTENT_FINISH_REASON.BLOCKLIST,
    FINISH_REASON.content_filter,
  ],
  [
    GOOGLE_GENERATE_CONTENT_FINISH_REASON.PROHIBITED_CONTENT,
    FINISH_REASON.content_filter,
  ],
  [GOOGLE_GENERATE_CONTENT_FINISH_REASON.SPII, FINISH_REASON.content_filter],
  [
    GOOGLE_GENERATE_CONTENT_FINISH_REASON.MALFORMED_FUNCTION_CALL,
    FINISH_REASON.stop,
  ],
  [
    GOOGLE_GENERATE_CONTENT_FINISH_REASON.IMAGE_SAFETY,
    FINISH_REASON.content_filter,
  ],
]);

export const AnthropicFinishReasonMap = new Map<
  PROVIDER_FINISH_REASON,
  ANTHROPIC_STOP_REASON
>([]);
