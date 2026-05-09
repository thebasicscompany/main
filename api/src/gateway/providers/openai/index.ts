import { ProviderConfigs } from '../types.js';
import {
  OpenAICompleteConfig,
  OpenAICompleteResponseTransform,
} from './complete.js';
import { OpenAIEmbedConfig, OpenAIEmbedResponseTransform } from './embed.js';
import OpenAIAPIConfig from './api.js';
import {
  OpenAIChatCompleteConfig,
  OpenAIChatCompleteResponseTransform,
} from './chatComplete.js';
import {
  OpenAIImageGenerateConfig,
  OpenAIImageGenerateResponseTransform,
} from './imageGenerate.js';
import {
  OpenAICreateSpeechConfig,
  OpenAICreateSpeechResponseTransform,
} from './createSpeech.js';
import { OpenAICreateTranscriptionResponseTransform } from './createTranscription.js';
import { OpenAICreateTranslationResponseTransform } from './createTranslation.js';
import {
  OpenAIUploadFileResponseTransform,
  OpenAIFileUploadRequestTransform,
} from './uploadFile.js';
import { OpenAIGetFilesResponseTransform } from './listFiles.js';
import { OpenAIDeleteFileResponseTransform } from './deleteFile.js';
import { OpenAIGetFileContentResponseTransform } from './retrieveFileContent.js';
import {
  OpenAICreateBatchConfig,
  OpenAICreateBatchResponseTransform,
} from './createBatch.js';
import { OpenAIRetrieveBatchResponseTransform } from './retrieveBatch.js';
import { OpenAICancelBatchResponseTransform } from './cancelBatch.js';
import { OpenAIListBatchesResponseTransform } from './listBatches.js';
import { OpenAIGetBatchOutputRequestHandler } from './getBatchOutput.js';
import {
  OpenAICreateFinetuneConfig,
  OpenAIFinetuneResponseTransform,
} from './createFinetune.js';
import {
  createModelResponseParams,
  OpenAICreateModelResponseTransformer,
  OpenAIGetModelResponseTransformer,
  OpenAIDeleteModelResponseTransformer,
  OpenAIListInputItemsResponseTransformer,
} from '../open-ai-base/index.js';
import { OPEN_AI } from '../../globals.js';

const OpenAIConfig: ProviderConfigs = {
  complete: OpenAICompleteConfig,
  embed: OpenAIEmbedConfig,
  api: OpenAIAPIConfig,
  chatComplete: OpenAIChatCompleteConfig,
  imageGenerate: OpenAIImageGenerateConfig,
  imageEdit: {},
  createSpeech: OpenAICreateSpeechConfig,
  createTranscription: {},
  createTranslation: {},
  realtime: {},
  createBatch: OpenAICreateBatchConfig,
  createFinetune: OpenAICreateFinetuneConfig,
  cancelBatch: {},
  cancelFinetune: {},
  createModelResponse: createModelResponseParams([]),
  getModelResponse: {},
  deleteModelResponse: {},
  listModelsResponse: {},
  requestHandlers: {
    getBatchOutput: OpenAIGetBatchOutputRequestHandler,
  },
  requestTransforms: {
    uploadFile: OpenAIFileUploadRequestTransform,
  },
  responseTransforms: {
    complete: OpenAICompleteResponseTransform,
    // 'stream-complete': OpenAICompleteResponseTransform,
    chatComplete: OpenAIChatCompleteResponseTransform,
    // 'stream-chatComplete': OpenAIChatCompleteResponseTransform,
    imageGenerate: OpenAIImageGenerateResponseTransform,
    createSpeech: OpenAICreateSpeechResponseTransform,
    createTranscription: OpenAICreateTranscriptionResponseTransform,
    createTranslation: OpenAICreateTranslationResponseTransform,
    realtime: {},
    uploadFile: OpenAIUploadFileResponseTransform,
    listFiles: OpenAIGetFilesResponseTransform,
    retrieveFile: OpenAIGetFilesResponseTransform,
    deleteFile: OpenAIDeleteFileResponseTransform,
    retrieveFileContent: OpenAIGetFileContentResponseTransform,
    createBatch: OpenAICreateBatchResponseTransform,
    retrieveBatch: OpenAIRetrieveBatchResponseTransform,
    cancelBatch: OpenAICancelBatchResponseTransform,
    listBatches: OpenAIListBatchesResponseTransform,
    createFinetune: OpenAIFinetuneResponseTransform,
    retrieveFinetune: OpenAIFinetuneResponseTransform,
    createModelResponse: OpenAICreateModelResponseTransformer(OPEN_AI),
    getModelResponse: OpenAIGetModelResponseTransformer(OPEN_AI),
    deleteModelResponse: OpenAIDeleteModelResponseTransformer(OPEN_AI),
    listModelsResponse: OpenAIListInputItemsResponseTransformer(OPEN_AI),
  },
};

export default OpenAIConfig;
