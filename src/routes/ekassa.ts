import { FastifyInstance } from 'fastify';
import { authenticateRequest } from '../auth';

const FISCAL_ID_REGEX = /[A-HJ-NP-Za-km-z1-9]{42,46}/;
const FISCAL_ID_EXACT = /^[A-HJ-NP-Za-km-z1-9]{42,46}$/;

import { ProxyAgent } from 'undici';

let cachedProxyUrl = '';
let cachedProxyAgent: ProxyAgent | undefined = undefined;

function getProxyAgent() {
  const proxyUrl = process.env.EKASSA_PROXY;
  if (!proxyUrl) {
    cachedProxyUrl = '';
    cachedProxyAgent = undefined;
    return undefined;
  }
  if (proxyUrl !== cachedProxyUrl) {
    cachedProxyUrl = proxyUrl;
    cachedProxyAgent = new ProxyAgent(proxyUrl);
  }
  return cachedProxyAgent;
}

export function extractFiscalId(qrUrl: string | undefined, fiscalId: string | undefined): string | null {
  if (fiscalId && FISCAL_ID_EXACT.test(fiscalId.trim())) {
    return fiscalId.trim();
  }
  
  if (qrUrl) {
    // Try to extract from URL doc parameter or raw match
    const urlMatch = qrUrl.match(/[?&]doc=([A-HJ-NP-Za-km-z1-9]{42,46})/);
    if (urlMatch && urlMatch[1]) {
      return urlMatch[1];
    }
    
    // Fallback: search for any sequence matching the fiscal ID pattern in the URL
    const fallbackMatch = qrUrl.match(FISCAL_ID_REGEX);
    if (fallbackMatch) {
      return fallbackMatch[0];
    }
  }

  return null;
}

export async function ekassaRoutes(fastify: FastifyInstance) {
  
  // Protect all e-kassa routes
  fastify.addHook('preHandler', authenticateRequest);

  fastify.post('/ekassa/receipt-image', async (request, reply) => {
    const body = request.body as { qr_url?: string; fiscal_id?: string };

    if (!body || (!body.qr_url && !body.fiscal_id)) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'invalid_request',
          message: "Request must contain at least one of 'qr_url' or 'fiscal_id'."
        }
      });
    }

    const fiscalId = extractFiscalId(body.qr_url, body.fiscal_id);

    if (!fiscalId) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'invalid_fiscal_id',
          message: 'The fiscal ID could not be extracted or is in an invalid format.'
        }
      });
    }

    const downloadUrl = `https://monitoring.e-kassa.gov.az/pks-monitoring/2.0.0/documents/${fiscalId}`;
    const timeoutMs = 15000;
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const fetchOptions: any = {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'image/jpeg,application/json'
        },
        signal: controller.signal
      };

      const proxyAgent = getProxyAgent();
      if (proxyAgent) {
        fetchOptions.dispatcher = proxyAgent;
      }

      const response = await fetch(downloadUrl, fetchOptions);

      clearTimeout(timerId);

      const status = response.status;

      if (status === 209) {
        fastify.log.warn({ fiscalId }, `[e-Kassa] Upstream returned 209: Receipt not found.`);
        return reply.status(502).send({
          success: false,
          error: {
            code: 'ekassa_receipt_not_found',
            message: 'Receipt was not found in e-Kassa.'
          }
        });
      }

      if (status !== 200 && status !== 206) {
        const errBody = await response.text().catch(() => '');
        fastify.log.error({ fiscalId, status, errBody }, `[e-Kassa] Upstream download failed.`);
        return reply.status(502).send({
          success: false,
          error: {
            code: 'ekassa_download_failed',
            message: `e-Kassa returned error status: ${status}`,
            details: { status, response: errBody.slice(0, 500) }
          }
        });
      }

      const buffer = await response.arrayBuffer();
      if (!buffer || buffer.byteLength === 0) {
        fastify.log.error({ fiscalId }, `[e-Kassa] Upstream returned empty body.`);
        return reply.status(502).send({
          success: false,
          error: {
            code: 'ekassa_empty_response',
            message: 'e-Kassa returned an empty response body.'
          }
        });
      }

      const base64Image = Buffer.from(buffer).toString('base64');

      fastify.log.info({ fiscalId, byteLength: buffer.byteLength }, `[e-Kassa] Download successful.`);
      return {
        success: true,
        data: {
          fiscal_id: fiscalId,
          image_base64: base64Image,
          mime_type: 'image/jpeg',
          source_http_status: status
        }
      };
    } catch (err: any) {
      clearTimeout(timerId);
      const isTimeout = err.name === 'AbortError';
      const statusCode = isTimeout ? 504 : 502;
      const errorCode = isTimeout ? 'gateway_timeout' : 'ekassa_download_failed';
      const message = isTimeout ? 'Connection to e-Kassa timed out after 15s.' : (err.message || String(err));
      
      fastify.log.error({ fiscalId, error: message }, `[e-Kassa] Network or timeout error occurred.`);
      
      return reply.status(statusCode).send({
        success: false,
        error: {
          code: errorCode,
          message
        }
      });
    }
  });
}
