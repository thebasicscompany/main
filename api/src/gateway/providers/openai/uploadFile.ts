import { OPEN_AI } from '../../globals.js';
import { ErrorResponse } from '../types.js';
import { OpenAIErrorResponseTransform } from './utils.js';

export const OpenAIFileUploadRequestTransform = (requestBody: FormData) => {
  return requestBody;
};

export const OpenAIUploadFileResponseTransform: (
  response: Response | ErrorResponse,
  responseStatus: number
) => Response | ErrorResponse = (response, responseStatus) => {
  if (responseStatus !== 200 && 'error' in response) {
    return OpenAIErrorResponseTransform(response, OPEN_AI);
  }

  return response;
};
