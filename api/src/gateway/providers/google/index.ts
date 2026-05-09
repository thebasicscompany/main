import { ProviderConfigs } from '../types.js';
import GoogleApiConfig from './api.js';
import {
  GoogleChatCompleteConfig,
  GoogleChatCompleteResponseTransform,
  GoogleChatCompleteStreamChunkTransform,
} from './chatComplete.js';
import { GoogleEmbedConfig, GoogleEmbedResponseTransform } from './embed.js';

const GoogleConfig: ProviderConfigs = {
  api: GoogleApiConfig,
  chatComplete: GoogleChatCompleteConfig,
  embed: GoogleEmbedConfig,
  responseTransforms: {
    chatComplete: GoogleChatCompleteResponseTransform,
    'stream-chatComplete': GoogleChatCompleteStreamChunkTransform,
    embed: GoogleEmbedResponseTransform,
  },
};

export default GoogleConfig;
