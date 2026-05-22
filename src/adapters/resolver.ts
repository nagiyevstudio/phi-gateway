import { getProviders, getModels, getModelAliases } from '../config';
import { callOpenAICompat } from './openai-compat';
import { callGemini } from './gemini';
import { OpenAICompletionRequest, OpenAICompletionResponse } from './types';

export interface ResolveErrorDetails {
  modelKey: string;
  error: string;
  durationMs: number;
}

export class FallbackChainError extends Error {
  public details: ResolveErrorDetails[];
  
  constructor(message: string, details: ResolveErrorDetails[]) {
    super(message);
    this.name = 'FallbackChainError';
    this.details = details;
  }
}

export async function resolveAndExecuteCompletion(
  payload: OpenAICompletionRequest,
  clientAllowedAliases: string[],
  request?: any
): Promise<OpenAICompletionResponse> {
  const requestedModel = payload.model;
  if (request) {
    request.modelAlias = requestedModel;
  }

  // 1. Authorization check: Is the client allowed to use this model alias?
  if (!clientAllowedAliases.includes(requestedModel)) {
    const error = new Error(`Client is not allowed to use model alias '${requestedModel}'`);
    (error as any).statusCode = 403;
    (error as any).code = 'forbidden';
    throw error;
  }

  // 2. Resolve the model alias configuration
  const aliases = getModelAliases();
  let aliasInfo = aliases[requestedModel];

  // Fallback for backward compatibility / defaults if not explicitly configured in model-aliases.json
  if (!aliasInfo) {
    if (requestedModel === 'logitaka-default') {
      // Create a default routing for logitaka-default if it's missing in config
      aliasInfo = {
        enabled: true,
        target_model_key: 'openrouter_claude_sonnet', // safe default target
        fallback_model_keys: ['openai_gpt54_nano'],
        required_capabilities: ['text_input', 'text_output']
      };
    } else {
      const error = new Error(`Model alias '${requestedModel}' is not configured on this gateway.`);
      (error as any).statusCode = 400;
      (error as any).code = 'invalid_model_alias';
      throw error;
    }
  }

  if (!aliasInfo.enabled) {
    const error = new Error(`Model alias '${requestedModel}' is currently disabled.`);
    (error as any).statusCode = 503;
    (error as any).code = 'model_alias_disabled';
    throw error;
  }

  // 3. Assemble the fallback chain: [target, fallback1, fallback2, ...]
  const fallbackChain = [aliasInfo.target_model_key, ...aliasInfo.fallback_model_keys];
  const attemptedModels: ResolveErrorDetails[] = [];

  const models = getModels();
  const providers = getProviders();

  // 4. Try executing along the fallback chain
  for (const modelKey of fallbackChain) {
    const modelInfo = models[modelKey];
    if (!modelInfo) {
      console.warn(`[Resolver] Model key '${modelKey}' in fallback chain for '${requestedModel}' is not defined in providers config. Skipping.`);
      attemptedModels.push({
        modelKey,
        error: 'Model key not defined in providers config',
        durationMs: 0
      });
      continue;
    }

    const providerInfo = providers[modelInfo.provider];
    if (!providerInfo) {
      console.warn(`[Resolver] Provider '${modelInfo.provider}' for model '${modelKey}' is not defined. Skipping.`);
      attemptedModels.push({
        modelKey,
        error: `Provider '${modelInfo.provider}' not defined`,
        durationMs: 0
      });
      continue;
    }

    if (!providerInfo.enabled) {
      console.log(`[Resolver] Provider '${modelInfo.provider}' is disabled. Skipping model '${modelKey}'.`);
      attemptedModels.push({
        modelKey,
        error: `Provider '${modelInfo.provider}' is disabled`,
        durationMs: 0
      });
      continue;
    }

    // Resolve API key from environment
    const apiKey = process.env[providerInfo.api_key_env];
    if (!apiKey) {
      console.error(`[Resolver] API key environment variable '${providerInfo.api_key_env}' is not set for provider '${modelInfo.provider}'. Skipping model '${modelKey}'.`);
      attemptedModels.push({
        modelKey,
        error: `API key environment variable '${providerInfo.api_key_env}' not set`,
        durationMs: 0
      });
      continue;
    }

    const timeoutMs = providerInfo.timeout_ms || 60000;
    const startTime = process.hrtime();

    try {
      console.log(`[Resolver] Attempting model alias '${requestedModel}' -> model key '${modelKey}' (provider: ${modelInfo.provider}, model ID: ${modelInfo.api_model_id})...`);
      
      let result: OpenAICompletionResponse;
      if (modelInfo.provider === 'google') {
        result = await callGemini(
          modelInfo.api_model_id,
          apiKey,
          providerInfo.base_url,
          payload,
          requestedModel,
          timeoutMs
        );
      } else {
        result = await callOpenAICompat(
          modelInfo.api_model_id,
          apiKey,
          providerInfo.base_url,
          payload,
          requestedModel,
          timeoutMs
        );
      }

      const diff = process.hrtime(startTime);
      const durationMs = diff[0] * 1e3 + diff[1] * 1e-6;
      console.log(`[Resolver] Success with model '${modelKey}' in ${durationMs.toFixed(2)}ms`);
      if (request) {
        request.upstreamModelKey = modelKey;
      }
      return result;
    } catch (err: any) {
      const diff = process.hrtime(startTime);
      const durationMs = diff[0] * 1e3 + diff[1] * 1e-6;
      const errorMsg = err.message || String(err);
      
      console.error(`[Resolver] Failed model '${modelKey}' in ${durationMs.toFixed(2)}ms. Error: ${errorMsg}`);
      
      attemptedModels.push({
        modelKey,
        error: errorMsg,
        durationMs
      });
    }
  }

  // 5. If everything in the chain fails
  const error = new FallbackChainError(
    `All models in the fallback chain for '${requestedModel}' failed.`,
    attemptedModels
  );
  (error as any).statusCode = 502;
  (error as any).code = 'fallback_chain_failed';
  throw error;
}
