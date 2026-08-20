import { FastifyInstance } from 'fastify';
import { authenticateRequest } from '../auth';
import { resolveAndExecuteCompletion } from '../adapters/resolver';

interface Category {
  id: string;
  name: string;
}

interface CategoryRule {
  pattern: string;
  category_id: string;
}

interface AnalyzeRequest {
  image_base64: string;
  mime_type?: string;
  categories: Category[];
  category_rules: CategoryRule[];
}

export async function receiptRoutes(fastify: FastifyInstance) {
  
  fastify.addHook('preHandler', authenticateRequest);

  fastify.post('/receipt/analyze', async (request, reply) => {
    const body = request.body as AnalyzeRequest;

    if (!body || !body.image_base64 || !Array.isArray(body.categories) || !Array.isArray(body.category_rules)) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'invalid_request',
          message: "Request must contain 'image_base64', 'categories' array, and 'category_rules' array."
        }
      });
    }

    const base64Image = body.image_base64;
    const mimeType = body.mime_type || 'image/jpeg';

    const allowedAliases = request.client?.allowed_model_aliases || [];
    if (!allowedAliases.includes('phi-vision')) {
      return reply.status(403).send({
        success: false,
        error: {
          code: 'forbidden',
          message: "Client is not allowed to use model alias 'phi-vision'."
        }
      });
    }

    const today = new Date().toISOString().slice(0, 10);

    const systemPrompt = `You are a precise receipt extraction agent.
Analyze the provided receipt image and extract ALL receipt details.

Available categories (use ONLY from this list):
${JSON.stringify(body.categories, null, 2)}

Pre-learned category rules (item name → category):
${JSON.stringify(body.category_rules, null, 2)}

Return ONLY a valid JSON object. No markdown. No code blocks. No explanation.

Output format:
{
  "merchant": "Store Name",
  "date": "YYYY-MM-DD HH:mm:ss",
  "total": 4.16,
  "currency": "AZN",
  "payment_method": "cash",
  "items": [
    {
      "raw_name": "COCA COLA 2L",
      "quantity": 1,
      "unit_price": 1.50,
      "line_total": 1.50,
      "category_id": "uuid or null"
    }
  ]
}

Priority rules:
1. line_total — MOST IMPORTANT. Price in MAJOR units as float: 4.16 AZN stays 4.16, not 416.
2. category_id — SECOND MOST IMPORTANT. Assign using categories list and rules above. If unsure, use null. Do NOT invent categories.
3. total — receipt total. Sum of all items.
4. date — "YYYY-MM-DD HH:mm:ss". No time = "12:00:00". No date = "${today} 12:00:00".
5. merchant — store name. Default "Unknown" if not visible.
6. Extract ALL items. Do not skip any, even 0.07 AZN for a bag.
7. Currency defaults to "AZN". Payment method defaults to "cash".
8. Bank app screenshots: each transaction is a separate item.
9. Return ONLY the JSON object, nothing else.`;

    try {
      fastify.log.info(`[Receipt Analyze] Sending image to phi-vision (single request with categories)...`);

      const completion = await resolveAndExecuteCompletion({
        model: 'phi-vision',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extract all receipt details and assign categories to each item.' },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`
                }
              }
            ]
          }
        ],
        temperature: 0,
        response_format: { type: 'json_object' }
      }, allowedAliases, request);

      const content = completion.choices[0]?.message?.content || '{}';
      let parsed: any;
      
      try {
        let cleanContent = content.replace(/```json|```/g, '').trim();
        // Remove single-line comments that some models add
        cleanContent = cleanContent.replace(/\/\/.*$/gm, '').trim();
        parsed = JSON.parse(cleanContent);
      } catch (parseErr) {
        fastify.log.error({ content }, `[Receipt Analyze] Failed to parse model output JSON.`);
        throw new Error('Vision model returned invalid receipt JSON.');
      }

      if (!parsed.items || !Array.isArray(parsed.items)) {
        parsed.items = [];
      }

      // Post-process: apply category_rules as fallback for items without category
      const finalItems = parsed.items.map((item: any) => {
        const rawName = item.raw_name || 'Unknown item';
        const normalizedName = rawName.toLowerCase().trim();
        let categoryId = typeof item.category_id === 'string' ? item.category_id : null;

        // Apply rules if model didn't assign a category
        if (!categoryId) {
          for (const rule of body.category_rules) {
            if (normalizedName.includes(rule.pattern.toLowerCase().trim())) {
              categoryId = rule.category_id;
              break;
            }
          }
        }

        return {
          raw_name: rawName,
          normalized_name: normalizedName,
          quantity: typeof item.quantity === 'number' ? item.quantity : 1,
          unit_price: typeof item.unit_price === 'number' ? item.unit_price : (item.line_total || 0),
          line_total: typeof item.line_total === 'number' ? item.line_total : 0,
          category_id: categoryId,
          confidence: typeof item.confidence === 'number' ? item.confidence : 0.8
        };
      });

      return {
        success: true,
        data: {
          merchant: parsed.merchant || 'Unknown Merchant',
          date: parsed.date || new Date().toISOString().replace('T', ' ').slice(0, 19),
          total: typeof parsed.total === 'number' ? parsed.total : 0,
          currency: parsed.currency || 'AZN',
          payment_method: parsed.payment_method || 'cash',
          items: finalItems,
          diagnostics: {
            model: 'phi-vision',
            single_request: true
          }
        }
      };

    } catch (error: any) {
      fastify.log.error(error, `[Receipt Analyze] Analysis failed.`);
      const status = error.statusCode || 502;
      const errorCode = error.code || 'receipt_analysis_failed';
      return reply.status(status).send({
        success: false,
        error: {
          code: errorCode,
          message: error.message || 'Receipt analysis failed.',
          details: error.details || undefined
        }
      });
    }
  });
}
