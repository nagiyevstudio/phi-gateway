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

    const systemPrompt = `You are a financial image extraction agent for the PHI expense tracker app.
Analyze the provided image and extract ALL financial transactions or receipt items.

The image can be:
1. A BANKING APP SCREENSHOT or account transaction history (e.g. Leobank, Birbank, ABB, m10, Kaspi, Tinkoff, Apple Pay, etc.) showing multiple payments/expenses.
2. A STORE RECEIPT (e-Kassa, fiscal check, supermarket slip) with line items.
3. A single transaction confirmation, transfer receipt, or invoice.

Available expense categories (use ONLY these UUIDs):
${JSON.stringify(body.categories, null, 2)}

Pre-learned category rules (pattern → category_id):
${JSON.stringify(body.category_rules, null, 2)}

## OUTPUT FORMAT (strict JSON, no markdown, no code blocks):
{
  "merchant": "Store Name or Bank/App Name",
  "date": "YYYY-MM-DD HH:mm:ss",
  "total": 45.60,
  "currency": "AZN",
  "payment_method": "card",
  "items": [
    {
      "raw_name": "Merchant, Service or Item name",
      "quantity": 1,
      "unit_price": 7.50,
      "line_total": 7.50,
      "category_id": "uuid from list or null",
      "date": "YYYY-MM-DD"
    }
  ]
}

## CRITICAL EXTRACTION RULES:

1. **BANK APP SCREENSHOTS (MULTIPLE PAYMENTS)**:
   - If the image displays a banking app screen with multiple transactions:
     - You MUST extract EVERY SINGLE visible transaction as a separate entry in the "items" array!
     - If 5 transactions are visible on screen, you MUST return 5 separate items. NEVER combine or collapse them into one single item!
     - Focus on expense/outgoing transactions (purchases, card payments, bills, service fees).
     - "raw_name": The exact merchant, service, recipient, or payment name written for that transaction (e.g. "Starbucks", "Bolt", "Bravo Supermarket", "Yango Taxi", "Trendyol", "M10").
     - "line_total": The transaction amount as a positive float in MAJOR units (e.g. 7.50, NOT 750).
     - "quantity": 1.
     - "unit_price": Same as line_total.
     - "date": The specific date of this transaction in "YYYY-MM-DD" format if visible on the item line or under a date header (e.g., "18 Сен" -> "${today.slice(0, 4)}-09-18", "Bugün"/"Today" -> "${today}", "Dün"/"Yesterday" -> calculate yesterday). If only time or no date is visible for this item, use null.
     - "category_id": Match to the best category UUID from the available list based on what was bought, or null if uncertain.
     - "merchant": Name of the bank/app (e.g. "Leobank", "Birbank", "Bank App") or "Банк".
     - "total": Sum of all extracted transactions.
     - "payment_method": "card".

2. **STORE RECEIPTS**:
   - Each purchased product/line item is a separate entry in the "items" array.
   - "merchant": The store/shop name at the top of the receipt.
   - "total": Receipt total (Cəmi/Итого).
   - "date": Receipt date & time in "YYYY-MM-DD HH:mm:ss" if visible, or "${today} 12:00:00".
   - "payment_method": "cash" or "card" as indicated on receipt (default "cash").

3. **PRICES & AMOUNTS**:
   - All prices MUST be in MAJOR units as float: 4.16 AZN is 4.16, 12 AZN is 12.00, 0.50 AZN is 0.50. Never use minor units/kopecks/cents.
   - "total": Sum of all items in the array.

4. **CATEGORIES**:
   - Use ONLY UUIDs from the provided categories list.
   - If pre-learned rules match an item, prefer that category.
   - If you are not confident which category matches, set "category_id": null. Do NOT guess randomly. NEVER invent fake category IDs.

5. **EXTRACT ALL**:
   - Do NOT skip any visible transaction or item, even small ones (e.g. 0.10 AZN).

6. **LANGUAGE**:
   - Text may be in Azerbaijani, Russian, English, or Turkish. Parse all correctly.

7. Return ONLY the JSON object, nothing else.`;

    try {
      fastify.log.info(`[Receipt Analyze] Sending image to phi-vision (single request with categories)...`);

      const completion = await resolveAndExecuteCompletion({
        model: 'phi-vision',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Extract all financial transactions or receipt items and assign categories to each item.' },
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
          date: item.date || null,
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
