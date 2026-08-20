import { FastifyInstance } from 'fastify';
import { authenticateRequest } from '../auth';
import { resolveAndExecuteCompletion } from '../adapters/resolver';

interface Category {
  id: string;
  name: string;
}

interface VoiceParseRequest {
  input_type: 'audio' | 'text';
  audio_base64?: string;
  mime_type?: string;
  text?: string;
  categories: Category[];
}

const FORMAT_MAP: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/flac': 'flac'
};

export async function voiceRoutes(fastify: FastifyInstance) {
  
  fastify.addHook('preHandler', authenticateRequest);

  fastify.post('/voice/parse', async (request, reply) => {
    const body = request.body as VoiceParseRequest;

    if (!body || !body.input_type || !Array.isArray(body.categories)) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'invalid_request',
          message: "Request must contain 'input_type' and a 'categories' array."
        }
      });
    }

    const allowedAliases = request.client?.allowed_model_aliases || [];

    if (!allowedAliases.includes('phi-parser')) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'forbidden',
          message: "Client is not allowed to use model alias 'phi-parser'."
        }
      });
    }

    // Build user message based on input type
    const userContent: any[] = [];

    if (body.input_type === 'audio') {
      if (!body.audio_base64) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'invalid_request',
            message: "Missing 'audio_base64' when input_type is 'audio'."
          }
        });
      }

      const mimeType = body.mime_type || 'audio/webm';
      const audioFormat = FORMAT_MAP[mimeType] || 'wav';

      userContent.push({
        type: 'input_audio',
        input_audio: {
          data: body.audio_base64,
          format: audioFormat
        }
      });
      userContent.push({
        type: 'text',
        text: 'Listen to this audio. The speaker describes their expenses in natural speech (may be in Azerbaijani, Russian, Turkish, or English). Transcribe and parse all expenses into structured JSON.'
      });

    } else if (body.input_type === 'text') {
      if (!body.text) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'invalid_request',
            message: "Missing 'text' when input_type is 'text'."
          }
        });
      }

      userContent.push({
        type: 'text',
        text: `Parse these expenses: "${body.text}"`
      });

    } else {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'invalid_request',
          message: "Invalid input_type. Must be 'audio' or 'text'."
        }
      });
    }

    const systemPrompt = `You are a financial parsing assistant for the PHI expense tracker.

Your task: analyze the input (text or audio), extract ALL expenses mentioned, and map each to a category.

Categories:
${JSON.stringify(body.categories, null, 2)}

Return ONLY a valid JSON object. No markdown. No code blocks. No explanation. No comments inside JSON.

Output format:
{
  "items": [
    {
      "merchant": "Store or service name",
      "category_id": "uuid from categories or null",
      "amount_minor": 550,
      "description": "Short description",
      "confidence": 0.85
    }
  ]
}

Rules:
1. Return ONLY the JSON object, nothing else before or after.
2. Amounts in MINOR units as integers: 5.50 AZN = 550, 15 AZN = 1500, 0.80 AZN = 80.
3. merchant: store or service name (Yango, Bazarstore, Bolt). Use "Unknown" if not mentioned.
4. category_id: pick UUID from categories list. If none fits, use null.
5. Extract EVERY expense, even small ones.
6. If input is audio: transcribe all spoken expenses. Language may be Azerbaijani, Russian, Turkish, or English.`;

    try {
      const inputDesc = body.input_type === 'audio' ? 'audio' : 'text';
      fastify.log.info(`[Voice Parse] Processing ${inputDesc} input via phi-parser (single request)...`);

      const result = await resolveAndExecuteCompletion({
        model: 'phi-parser',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0,
        response_format: { type: 'json_object' }
      }, allowedAliases, request);

      const content = result.choices[0]?.message?.content || '{}';
      let parsedResponse: { items?: any[] };
      
      try {
        let cleanContent = content.replace(/```json|```/g, '').trim();
        // Remove single-line comments that some models add
        cleanContent = cleanContent.replace(/\/\/.*$/gm, '').trim();
        parsedResponse = JSON.parse(cleanContent);
      } catch (parseErr) {
        fastify.log.error({ content }, `[Voice Parse] Failed to parse model output JSON.`);
        throw new Error('Parser model returned invalid structured JSON.');
      }

      const items = parsedResponse.items || [];
      
      const finalItems = items.map(item => ({
        merchant: item.merchant || 'Unknown',
        category_id: typeof item.category_id === 'string' ? item.category_id : null,
        amount_minor: Math.round(Number(item.amount_minor) || 0),
        description: item.description || '',
        confidence: typeof item.confidence === 'number' ? item.confidence : 0.8
      }));

      return {
        success: true,
        data: {
          items: finalItems,
          diagnostics: {
            input_type: body.input_type,
            model: 'phi-parser',
            single_request: true
          }
        }
      };

    } catch (error: any) {
      fastify.log.error(error, `[Voice Parse] Parsing failed.`);
      const status = error.statusCode || 502;
      const errorCode = error.code || 'voice_parse_failed';
      return reply.status(status).send({
        success: false,
        error: {
          code: errorCode,
          message: error.message || 'Voice parsing failed.',
          details: error.details || undefined
        }
      });
    }
  });
}
