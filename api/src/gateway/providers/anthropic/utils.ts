import { ErrorResponse } from '../types.js';
import { generateErrorResponse } from '../utils.js';
import { AnthropicErrorResponse } from './types.js';

export const AnthropicErrorResponseTransform: (
  response: AnthropicErrorResponse,
  provider: string
) => ErrorResponse = (response, provider) => {
  return generateErrorResponse(
    {
      message: response.error?.message,
      type: response.error?.type,
      param: null,
      code: null,
    },
    provider
  );
};
