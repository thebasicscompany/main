import { MessagesResponse } from '../../types/messagesResponse.js';
import { getMessagesConfig } from '../anthropic-base/messages.js';
import { AnthropicErrorResponse } from './types.js';
import { ErrorResponse } from '../types.js';
import { AnthropicErrorResponseTransform } from './utils.js';
import { generateInvalidProviderResponseError } from '../utils.js';
import { ANTHROPIC } from '../../globals.js';

export const AnthropicMessagesConfig = getMessagesConfig({});

export const AnthropicMessagesResponseTransform = (
  response: MessagesResponse | AnthropicErrorResponse,
  responseStatus: number
): MessagesResponse | ErrorResponse => {
  if (responseStatus !== 200 && 'error' in response) {
    return AnthropicErrorResponseTransform(response, ANTHROPIC);
  }

  if ('model' in response) return response;

  return generateInvalidProviderResponseError(response, ANTHROPIC);
};
