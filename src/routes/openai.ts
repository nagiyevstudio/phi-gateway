import { FastifyInstance } from 'fastify';
import { getModelAliases } from '../config';
import { authenticateRequest } from '../auth';
import { resolveAndExecuteCompletion } from '../adapters/resolver';
import { OpenAICompletionRequest } from '../adapters/types';

export async function openAiRoutes(fastify: FastifyInstance) {
  
  // Apply authentication to all /v1 routes
  fastify.addHook('preHandler', authenticateRequest);

  // 1. GET /v1/models
  fastify.get('/models', async (request, reply) => {
    const aliases = getModelAliases();
    const modelList = Object.entries(aliases)
      .filter(([, info]) => info.enabled)
      .map(([id]) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'phi-gateway'
      }));

    // Ensure logitaka-default is always included (even if implicit)
    if (!modelList.some(m => m.id === 'logitaka-default')) {
      modelList.unshift({
        id: 'logitaka-default',
        object: 'model',
        created: 0,
        owned_by: 'phi-gateway'
      });
    }

    return {
      object: 'list',
      data: modelList
    };
  });

  // 2. POST /v1/chat/completions
  fastify.post('/chat/completions', async (request, reply) => {
    const payload = request.body as OpenAICompletionRequest;
    
    if (!payload || !payload.model || !Array.isArray(payload.messages)) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'invalid_request',
          message: "Request body must contain 'model' and a 'messages' array."
        }
      });
    }

    const clientAllowedAliases = request.client?.allowed_model_aliases || [];

    try {
      const result = await resolveAndExecuteCompletion(payload, clientAllowedAliases, request);
      return result;
    } catch (error: any) {
      const status = error.statusCode || 500;
      const errorCode = error.code || 'internal_server_error';
      
      // Log full fallback details if it's a fallback failure
      if (errorCode === 'fallback_chain_failed' && error.details) {
        fastify.log.error({
          requestedModel: payload.model,
          attempts: error.details
        }, `[Resolver] Fallback chain failed completely for alias: ${payload.model}`);
      }

      return reply.status(status).send({
        success: false,
        error: {
          code: errorCode,
          message: error.message || 'An error occurred during chat completions processing.',
          details: error.details || undefined
        }
      });
    }
  });
}
