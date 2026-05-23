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

interface ExtractedItem {
  raw_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

interface ExtractedReceipt {
  merchant: string;
  date: string;
  total: number;
  currency: string;
  payment_method: 'cash' | 'card';
  items: ExtractedItem[];
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
    const imageSource = 'upload';
    const mimeType = body.mime_type || 'image/jpeg';

    // Check allowed model aliases
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

    // 2. OCR and structured parsing using phi-vision Vision LLM
    const systemPrompt = `You are a precise receipt extraction agent.
Analyze the provided receipt image and extract the receipt details.
Return ONLY a raw JSON object matching the following structure. Do not wrap in markdown block.

Expected JSON output format:
{
  "merchant": "Store Name",
  "date": "YYYY-MM-DD HH:mm:ss",
  "total": 4.16,
  "currency": "AZN",
  "payment_method": "cash", // "cash" or "card"
  "items": [
    {
      "raw_name": "COCA COLA 2L",
      "quantity": 1,
      "unit_price": 1.50,
      "line_total": 1.50
    }
  ]
}

Rules:
1. Ensure currency defaults to "AZN" if not specified.
2. Return total and unit prices in major units (as float numbers, e.g. 4.16).
3. If payment method is not specified, default to "cash".
4. Ensure date format is "YYYY-MM-DD HH:mm:ss". If time is missing, use "YYYY-MM-DD 12:00:00". If the entire date is missing, use today's date: ${new Date().toISOString().slice(0, 10)} 12:00:00.
5. List all purchased receipt items, do not skip any.`;

    try {
      fastify.log.info(`[Receipt Analyze] Sending image to phi-vision...`);
      const completion = await resolveAndExecuteCompletion({
        model: 'phi-vision',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extract receipt details from this image.' },
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
      let parsedReceipt: ExtractedReceipt;
      
      try {
        const cleanContent = content.replace(/```json|```/g, '').trim();
        parsedReceipt = JSON.parse(cleanContent) as ExtractedReceipt;
      } catch (parseErr) {
        fastify.log.error({ content }, `[Receipt Analyze] Failed to parse model output JSON.`);
        throw new Error('Vision model returned invalid receipt JSON.');
      }

      if (!parsedReceipt.items || !Array.isArray(parsedReceipt.items)) {
        parsedReceipt.items = [];
      }

      // 3. Classify items
      const finalItems = [];
      const itemsToClassify: string[] = [];

      for (const item of parsedReceipt.items) {
        const rawName = item.raw_name || 'Unknown item';
        const normalizedName = rawName.toLowerCase().trim();
        
        let categoryId: string | null = null;

        // Apply rules first
        for (const rule of body.category_rules) {
          const rulePattern = rule.pattern.toLowerCase().trim();
          if (normalizedName.includes(rulePattern)) {
            categoryId = rule.category_id;
            break;
          }
        }

        finalItems.push({
          raw_name: rawName,
          normalized_name: normalizedName,
          quantity: typeof item.quantity === 'number' ? item.quantity : 1,
          unit_price: typeof item.unit_price === 'number' ? item.unit_price : (item.line_total || 0),
          line_total: typeof item.line_total === 'number' ? item.line_total : 0,
          category_id: categoryId,
          confidence: 0.8 // default baseline confidence
        });

        if (categoryId === null) {
          itemsToClassify.push(rawName);
        }
      }

      // 4. Batch classify remaining items using phi-classifier if allowed and there are items
      let classifierUsed = false;
      if (itemsToClassify.length > 0 && allowedAliases.includes('phi-classifier')) {
        try {
          fastify.log.info({ count: itemsToClassify.length }, `[Receipt Analyze] Classifying ${itemsToClassify.length} items using phi-classifier...`);
          const classificationResult = await resolveAndExecuteCompletion({
            model: 'phi-classifier',
            messages: [
              {
                role: 'system',
                content: `You are a product classifier. Assign categories from this list: ${JSON.stringify(body.categories)}. Output JSON format: { "map": { "item name": "category_id" } }`
              },
              {
                role: 'user',
                content: `Classify: ${JSON.stringify(itemsToClassify)}`
              }
            ],
            temperature: 0,
            response_format: { type: 'json_object' }
          }, allowedAliases, request);

          const classContent = classificationResult.choices[0]?.message?.content || '{}';
          const cleanClassContent = classContent.replace(/```json|```/g, '').trim();
          const parsedClass: { map?: Record<string, string | null> } = JSON.parse(cleanClassContent);
          const classMap = parsedClass.map || {};

          for (const item of finalItems) {
            if (item.category_id === null && classMap[item.raw_name] !== undefined) {
              item.category_id = classMap[item.raw_name];
            }
          }
          classifierUsed = true;
        } catch (classErr) {
          // Log but don't fail the entire receipt parse if classification fallback fails
          fastify.log.error(classErr, `[Receipt Analyze] Classification sub-task failed, proceeding with null categories.`);
        }
      }

      return {
        success: true,
        data: {
          merchant: parsedReceipt.merchant || 'Unknown Merchant',
          date: parsedReceipt.date || new Date().toISOString().replace('T', ' ').slice(0, 19),
          total: typeof parsedReceipt.total === 'number' ? parsedReceipt.total : 0,
          currency: parsedReceipt.currency || 'AZN',
          payment_method: parsedReceipt.payment_method || 'cash',
          items: finalItems,
          diagnostics: {
            image_source: imageSource,
            ocr_used: true,
            regex_parser_used: false,
            ai_parser_used: true,
            classifier_used: classifierUsed,
            model: 'phi-parser'
          }
        }
      };

    } catch (error: any) {
      fastify.log.error(error, `[Receipt Analyze] Analysis pipeline failed.`);
      const status = error.statusCode || 502;
      const errorCode = error.code || 'receipt_analysis_failed';
      return reply.status(status).send({
        success: false,
        error: {
          code: errorCode,
          message: error.message || 'Receipt analysis pipeline failed.',
          details: error.details || undefined
        }
      });
    }
  });
}
