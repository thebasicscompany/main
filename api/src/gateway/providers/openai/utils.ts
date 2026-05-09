import { ErrorResponse } from '../types.js';
import { generateErrorResponse } from '../utils.js';

export const OpenAIErrorResponseTransform: (
  response: ErrorResponse,
  provider: string
) => ErrorResponse = (response, provider) => {
  return generateErrorResponse(
    {
      ...response.error,
    },
    provider
  );
};
