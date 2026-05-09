// Pruned registry. Only providers actually shipped through the Managed
// LLM Gateway are registered. Reintroduce others by restoring their dirs
// (under vendor/) and adding the entry here.
import { ProviderConfigs } from './types.js';
import AnthropicConfig from './anthropic/index.js';
import OpenAIConfig from './openai/index.js';
import GoogleConfig from './google/index.js';

const Providers: { [key: string]: ProviderConfigs } = {
  anthropic: AnthropicConfig,
  openai: OpenAIConfig,
  google: GoogleConfig,
};

export default Providers;
