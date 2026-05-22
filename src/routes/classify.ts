import { FastifyInstance } from 'fastify';
import { authenticateRequest } from '../auth';
import { resolveAndExecuteCompletion } from '../adapters/resolver';

export interface Category {
  id: string;
  name: string;
}

export interface ClassifyRequest {
  items: string[];
  categories: Category[];
}

export async function classifyRoutes(fastify: FastifyInstance) {
  
  // Protect all classify routes
  fastify.addHook('preHandler', authenticateRequest);

  fastify.post('/items/classify', async (request, reply) => {
    const body = request.body as ClassifyRequest;

    if (!body || !Array.isArray(body.items) || !Array.isArray(body.categories)) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'invalid_request',
          message: "Request body must contain 'items' (array of strings) and 'categories' (array of category objects)."
        }
      });
    }

    if (body.items.length === 0) {
      return {
        success: true,
        data: {
          map: {},
          diagnostics: {
            model: 'phi-classifier'
          }
        }
      };
    }

    // Verify client has permission to use phi-classifier
    const allowedAliases = request.client?.allowed_model_aliases || [];
    if (!allowedAliases.includes('phi-classifier')) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'forbidden',
          message: "Client is not allowed to use model alias 'phi-classifier'."
        }
      });
    }

    // Format the system instructions and user payload
    const systemPrompt = `You are a precise product classification system.
Your job is to match a list of purchase receipt items to the most appropriate category ID from the provided categories list.

Categories list:
${JSON.stringify(body.categories, null, 2)}

Rules:
1. Map each item name exactly as provided.
2. Choose only from the provided category IDs.
3. If an item does not fit any category clearly, or is ambiguous (e.g. plastic carrier bag, store fee, discount, or unknown name), return null for that item.
4. Output a single JSON object containing a "map" key that associates each item to its category ID or null. Do not include any explanation or markdown formatting, return raw JSON only.

Example Output format:
{
  "map": {
    "item name 1": "category-id-uuid-1",
    "item name 2": null
  }
}`;

    const userPrompt = `Classify these items:
${JSON.stringify(body.items, null, 2)}`;

    try {
      fastify.log.info({ itemsCount: body.items.length }, `[Classifier] Resolving classifications via phi-classifier...`);
      
      const completion = await resolveAndExecuteCompletion({
        model: 'phi-classifier',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0,
        response_format: { type: 'json_object' }
      }, allowedAliases, request);

      const content = completion.choices[0]?.message?.content || '{}';
      let parsedContent: { map?: Record<string, string | null> } = {};
      
      try {
        // Strip markdown backticks if any were returned by the model
        const cleanContent = content.replace(/```json|```/g, '').trim();
        parsedContent = JSON.parse(cleanContent);
      } catch (parseErr) {
        fastify.log.error({ content }, `[Classifier] Failed to parse model output JSON.`);
        throw new Error('Model returned an invalid JSON response.');
      }

      const map = parsedContent.map || {};
      
      // Ensure all requested items are present in the map (defaulting to null if missing)
      const finalMap: Record<string, string | null> = {};
      for (const item of body.items) {
        finalMap[item] = map[item] !== undefined ? map[item] : null;
      }

      return {
        success: true,
        data: {
          map: finalMap,
          diagnostics: {
            model: 'phi-classifier'
          }
        }
      };
    } catch (error: any) {
      const status = error.statusCode || 500;
      const errorCode = error.code || 'classification_failed';
      
      fastify.log.error(error, `[Classifier] Item classification failed.`);

      return reply.status(status).send({
        success: false,
        error: {
          code: errorCode,
          message: error.message || 'Item classification failed.',
          details: error.details || undefined
        }
      });
    }
  });
}
