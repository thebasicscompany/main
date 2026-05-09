import { OPEN_AI } from '../../globals.js';
import { ErrorResponse, ListBatchesResponse, ProviderConfig } from '../types.js';
import { OpenAIErrorResponseTransform } from './utils.js';

export const OpenAIListBatchesResponseTransform: (
  response: ListBatchesResponse | ErrorResponse,
  responseStatus: number
) => ListBatchesResponse | ErrorResponse = (response, responseStatus) => {
  if (responseStatus !== 200 && 'error' in response) {
    return OpenAIErrorResponseTransform(response, OPEN_AI);
  }

  return response;
};
