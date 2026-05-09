import { OPEN_AI } from '../../globals.js';
import { CancelBatchResponse, ErrorResponse, ProviderConfig } from '../types.js';
import { OpenAIErrorResponseTransform } from './utils.js';

export const OpenAICancelBatchResponseTransform: (
  response: CancelBatchResponse | ErrorResponse,
  responseStatus: number
) => CancelBatchResponse | ErrorResponse = (response, responseStatus) => {
  if (responseStatus !== 200 && 'error' in response) {
    return OpenAIErrorResponseTransform(response, OPEN_AI);
  }

  return response;
};
