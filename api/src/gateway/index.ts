/**
 * Managed LLM Gateway — Hono app mounted under /v1/llm/managed by the
 * runtime API (`api/src/app.ts`). See docs/MANAGED-GATEWAY-PLAN.md for
 * derivation history and the modification list in NOTICE.md.
 *
 * Modifications from upstream (see NOTICE.md for source attribution):
 *  - Removed Cloudflare Workers / Wrangler runtime branches (compress,
 *    realtime WebSocket, Redis cache bootstrap). Node-only.
 *  - Removed root '/' greeting.
 *  - Conf path is sibling './conf.json', not '../conf.json'.
 */

import { Hono } from 'hono';
import { prettyJSON } from 'hono/pretty-json';
import { HTTPException } from 'hono/http-exception';

// Middlewares
import { requestValidator } from './middlewares/requestValidator/index.js';
import { hooks } from './middlewares/hooks/index.js';
import { memoryCache } from './middlewares/cache/index.js';
import { logHandler } from './middlewares/log/index.js';

// Handlers
import { proxyHandler } from './handlers/proxyHandler.js';
import { chatCompletionsHandler } from './handlers/chatCompletionsHandler.js';
import { completionsHandler } from './handlers/completionsHandler.js';
import { embeddingsHandler } from './handlers/embeddingsHandler.js';
import { imageGenerationsHandler } from './handlers/imageGenerationsHandler.js';
import { createSpeechHandler } from './handlers/createSpeechHandler.js';
import { createTranscriptionHandler } from './handlers/createTranscriptionHandler.js';
import { createTranslationHandler } from './handlers/createTranslationHandler.js';
import { modelsHandler } from './handlers/modelsHandler.js';
import filesHandler from './handlers/filesHandler.js';
import batchesHandler from './handlers/batchesHandler.js';
import finetuneHandler from './handlers/finetuneHandler.js';
import { messagesHandler } from './handlers/messagesHandler.js';
import { imageEditsHandler } from './handlers/imageEditsHandler.js';
import { messagesCountTokensHandler } from './handlers/messagesCountTokensHandler.js';
import modelResponsesHandler from './handlers/modelResponsesHandler.js';

// utils
import { logger } from './apm/index.js';
// Config
import conf from './conf.json' with { type: 'json' };

const app = new Hono();

app.use('*', prettyJSON());
app.use(logHandler());
app.get('/v1/models', modelsHandler);
app.use('*', hooks);

if (conf.cache === true) {
  app.use('*', memoryCache());
}

app.notFound((c) => c.json({ message: 'Not Found', ok: false }, 404));

app.onError((err, c) => {
  logger.error('Global Error Handler: ', err.message, err.cause, err.stack);
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  c.status(500);
  return c.json({ status: 'failure', message: err.message });
});

app.post('/v1/messages', requestValidator, messagesHandler);
app.post(
  '/v1/messages/count_tokens',
  requestValidator,
  messagesCountTokensHandler
);

app.post('/v1/chat/completions', requestValidator, chatCompletionsHandler);
app.post('/v1/completions', requestValidator, completionsHandler);
app.post('/v1/embeddings', requestValidator, embeddingsHandler);

app.post('/v1/images/generations', requestValidator, imageGenerationsHandler);
app.post('/v1/images/edits', requestValidator, imageEditsHandler);

app.post('/v1/audio/speech', requestValidator, createSpeechHandler);
app.post(
  '/v1/audio/transcriptions',
  requestValidator,
  createTranscriptionHandler
);
app.post('/v1/audio/translations', requestValidator, createTranslationHandler);

app.get('/v1/files', requestValidator, filesHandler('listFiles', 'GET'));
app.get('/v1/files/:id', requestValidator, filesHandler('retrieveFile', 'GET'));
app.get(
  '/v1/files/:id/content',
  requestValidator,
  filesHandler('retrieveFileContent', 'GET')
);
app.post('/v1/files', requestValidator, filesHandler('uploadFile', 'POST'));
app.delete(
  '/v1/files/:id',
  requestValidator,
  filesHandler('deleteFile', 'DELETE')
);

app.post(
  '/v1/batches',
  requestValidator,
  batchesHandler('createBatch', 'POST')
);
app.get(
  '/v1/batches/:id',
  requestValidator,
  batchesHandler('retrieveBatch', 'GET')
);
app.get(
  '/v1/batches/*/output',
  requestValidator,
  batchesHandler('getBatchOutput', 'GET')
);
app.post(
  '/v1/batches/:id/cancel',
  requestValidator,
  batchesHandler('cancelBatch', 'POST')
);
app.get('/v1/batches', requestValidator, batchesHandler('listBatches', 'GET'));

app.post(
  '/v1/responses',
  requestValidator,
  modelResponsesHandler('createModelResponse', 'POST')
);
app.get(
  '/v1/responses/:id',
  requestValidator,
  modelResponsesHandler('getModelResponse', 'GET')
);
app.delete(
  '/v1/responses/:id',
  requestValidator,
  modelResponsesHandler('deleteModelResponse', 'DELETE')
);
app.get(
  '/v1/responses/:id/input_items',
  requestValidator,
  modelResponsesHandler('listResponseInputItems', 'GET')
);

app.all(
  '/v1/fine_tuning/jobs/:jobId?/:cancel?',
  requestValidator,
  finetuneHandler
);

app.post('/v1/prompts/*', requestValidator, (c) => {
  if (c.req.url.endsWith('/v1/chat/completions')) {
    return chatCompletionsHandler(c);
  } else if (c.req.url.endsWith('/v1/completions')) {
    return completionsHandler(c);
  }
  c.status(500);
  return c.json({
    status: 'failure',
    message: 'prompt completions error: Something went wrong',
  });
});

// Native byte-pass-through proxy. Handles native provider bodies/headers
// without OpenAI normalization.
app.post('/v1/proxy/*', proxyHandler);

app.post('/v1/*', requestValidator, proxyHandler);
app.get('/v1/:path{(?!realtime).*}', requestValidator, proxyHandler);
app.delete('/v1/*', requestValidator, proxyHandler);

export default app;
