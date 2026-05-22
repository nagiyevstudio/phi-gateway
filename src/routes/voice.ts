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
    let transcript = '';
    let transcriptionUsed = false;

    // 1. Transcription Phase
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

      if (!allowedAliases.includes('phi-audio-transcriber')) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'forbidden',
            message: "Client is not allowed to use model alias 'phi-audio-transcriber'."
          }
        });
      }

      const mimeType = body.mime_type || 'audio/webm';
      
      try {
        fastify.log.info({ mimeType }, `[Voice Parse] Transcribing audio with phi-audio-transcriber...`);
        const transcriptionResult = await resolveAndExecuteCompletion({
          model: 'phi-audio-transcriber',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Transcribe this audio precisely. Return ONLY the transcribed text. Do not add any greeting, comments, markdown, or explanation. If there is no speech, return an empty string.'
                },
                {
                  type: 'image_url', // using image_url field since our gemini/openai-compat adapter maps data URLs to inlineData/parts
                  image_url: {
                    url: `data:${mimeType};base64,${body.audio_base64}`
                  }
                }
              ]
            }
          ],
          temperature: 0
        }, allowedAliases, request);

        transcript = transcriptionResult.choices[0]?.message?.content?.trim() || '';
        transcriptionUsed = true;
        fastify.log.info({ transcriptLength: transcript.length }, `[Voice Parse] Audio transcription completed.`);
      } catch (transcribeErr: any) {
        fastify.log.error(transcribeErr, `[Voice Parse] Transcription failed.`);
        return reply.status(502).send({
          success: false,
          error: {
            code: 'transcription_failed',
            message: 'Audio transcription failed.',
            details: transcribeErr.message || String(transcribeErr)
          }
        });
      }
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
      transcript = body.text;
    } else {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'invalid_request',
          message: "Invalid input_type. Must be 'audio' or 'text'."
        }
      });
    }

    if (!transcript.trim()) {
      return {
        success: true,
        data: {
          items: [],
          diagnostics: {
            transcription_used: transcriptionUsed,
            model: 'phi-parser',
            empty_transcript: true
          }
        }
      };
    }

    // 2. Parsers/LLM Extraction Phase
    if (!allowedAliases.includes('phi-parser')) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'forbidden',
          message: "Client is not allowed to use model alias 'phi-parser'."
        }
      });
    }

    const systemPrompt = `You are a financial parsing assistant.
Your task is to analyze the user's transcript describing expenses, extract transaction details, and map each transaction to a category ID from the provided categories list.

Categories list:
${JSON.stringify(body.categories, null, 2)}

You must return a raw JSON object matching the following structure. Do not wrap in markdown block.

Expected JSON output format:
{
  "items": [
    {
      "merchant": "Merchant Name", // store or service name (e.g. "Yango", "Bazarstore", "Bolt"). Use "Unknown" if not mentioned.
      "category_id": "category-id-uuid-or-null", // Select ONLY from provided category IDs. Return null if none fit.
      "amount_minor": 550, // Integer in minor units (e.g. 5.50 AZN -> 550)
      "description": "Short description of expense",
      "confidence": 0.85
    }
  ]
}

Rules:
1. Return only the raw JSON. Do not wrap in markdown or backticks.
2. Convert all amounts to minor units as an integer (e.g. 15 AZN -> 1500, 4.50 AZN -> 450).
3. If no category clearly fits, return null for category_id.`;

    try {
      fastify.log.info({ transcript }, `[Voice Parse] Parsing transcript via phi-parser...`);
      const parsingResult = await resolveAndExecuteCompletion({
        model: 'phi-parser',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Parse these expenses: "${transcript}"` }
        ],
        temperature: 0,
        response_format: { type: 'json_object' }
      }, allowedAliases, request);

      const content = parsingResult.choices[0]?.message?.content || '{}';
      let parsedResponse: { items?: any[] };
      
      try {
        const cleanContent = content.replace(/```json|```/g, '').trim();
        parsedResponse = JSON.parse(cleanContent);
      } catch (parseErr) {
        fastify.log.error({ content }, `[Voice Parse] Failed to parse model output JSON.`);
        throw new Error('Parser model returned invalid structured JSON.');
      }

      const items = parsedResponse.items || [];
      
      // Post-process items to ensure type safety
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
            transcription_used: transcriptionUsed,
            model: 'phi-parser',
            raw_transcript: transcript
          }
        }
      };

    } catch (error: any) {
      fastify.log.error(error, `[Voice Parse] Parsing pipeline failed.`);
      const status = error.statusCode || 502;
      const errorCode = error.code || 'voice_parse_failed';
      return reply.status(status).send({
        success: false,
        error: {
          code: errorCode,
          message: error.message || 'Voice parsing pipeline failed.',
          details: error.details || undefined
        }
      });
    }
  });
}
