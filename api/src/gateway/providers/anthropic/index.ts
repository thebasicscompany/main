import { ANTHROPIC } from '../../globals.js';
import { ProviderConfigs } from '../types.js';
import AnthropicAPIConfig from './api.js';
import {
  AnthropicChatCompleteConfig,
  getAnthropicChatCompleteResponseTransform,
  getAnthropicStreamChunkTransform,
} from './chatComplete.js';
import {
  AnthropicCompleteConfig,
  AnthropicCompleteResponseTransform,
  AnthropicCompleteStreamChunkTransform,
} from './complete.js';
import {
  AnthropicMessagesConfig,
  AnthropicMessagesResponseTransform,
} from './messages.js';

const AnthropicConfig: ProviderConfigs = {
  complete: AnthropicCompleteConfig,
  chatComplete: AnthropicChatCompleteConfig,
  messages: AnthropicMessagesConfig,
  messagesCountTokens: AnthropicMessagesConfig,
  api: AnthropicAPIConfig,
  responseTransforms: {
    'stream-complete': AnthropicCompleteStreamChunkTransform,
    complete: AnthropicCompleteResponseTransform,
    chatComplete: getAnthropicChatCompleteResponseTransform(ANTHROPIC),
    'stream-chatComplete': getAnthropicStreamChunkTransform(ANTHROPIC),
    messages: AnthropicMessagesResponseTransform,
  },
};

export default AnthropicConfig;
