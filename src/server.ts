import fastify from 'fastify';
import multipart from '@fastify/multipart';
import fs from 'node:fs';
import path from 'node:path';
import { loadAllConfigs, startWatchingConfigs } from './config';
import { authenticateRequest } from './auth';
import { openAiRoutes } from './routes/openai';
import { ekassaRoutes } from './routes/ekassa';
import { classifyRoutes } from './routes/classify';
import { receiptRoutes } from './routes/receipt';
import { voiceRoutes } from './routes/voice';
import { adminRoutes } from './routes/admin';
import { addRequestLog } from './utils/logger';

const server = fastify({
  logger: {
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    transport: process.env.NODE_ENV !== 'production' ? {
      target: 'pino-pretty',
      options: {
        translateTime: 'HH:MM:ss Z',
        ignore: 'pid,hostname',
      }
    } : undefined
  }
});

// Register routes
server.register(openAiRoutes, { prefix: '/v1' });
server.register(ekassaRoutes, { prefix: '/phi' });
server.register(classifyRoutes, { prefix: '/phi' });
server.register(receiptRoutes, { prefix: '/phi' });
server.register(voiceRoutes, { prefix: '/phi' });
server.register(adminRoutes, { prefix: '/admin' });

// Register fastify multipart
server.register(multipart, {
  limits: {
    fileSize: 25 * 1024 * 1024, // 25 MB max file size (for audio uploads)
  }
});

// Simple request latency tracker and logger
server.addHook('onRequest', async (request) => {
  request.raw.statusCode = 0; // reset/init
  (request as any).startTime = process.hrtime();
});

server.addHook('onResponse', async (request, reply) => {
  const startTime = (request as any).startTime;
  if (!startTime) return;
  
  const diff = process.hrtime(startTime);
  const durationMs = (diff[0] * 1e3 + diff[1] * 1e-6).toFixed(2);
  const clientId = request.client?.client_id || 'anonymous';
  
  // Safely avoid logging raw tokens in URL if any, or bodies
  server.log.info({
    method: request.method,
    url: request.url,
    status: reply.statusCode,
    clientId,
    durationMs,
    ip: request.ip
  }, `[Request] ${request.method} ${request.url} - ${reply.statusCode} (${durationMs}ms) [Client: ${clientId}]`);

  // Add request to the circular in-memory buffer for admin dashboard
  if (request.url.startsWith('/v1') || request.url.startsWith('/phi')) {
    addRequestLog({
      timestamp: new Date().toISOString(),
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      clientId,
      clientLabel: request.client?.label || 'Anonymous',
      durationMs,
      ip: request.ip,
      modelAlias: request.modelAlias,
      upstreamModelKey: request.upstreamModelKey,
      error: reply.statusCode >= 400 ? 'Request failed' : undefined
    });
  }
});

// Route to serve the admin dashboard HTML page
server.get('/admin', async (request, reply) => {
  return serveAdminHtml(reply);
});

server.get('/admin/', async (request, reply) => {
  return serveAdminHtml(reply);
});

function serveAdminHtml(reply: any) {
  const possiblePaths = [
    path.join(process.cwd(), 'src', 'public', 'admin.html'),
    path.join(process.cwd(), 'public', 'admin.html'),
    path.join(__dirname, 'public', 'admin.html'),
    path.join(__dirname, '..', 'src', 'public', 'admin.html'),
  ];

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      reply.type('text/html');
      return fs.createReadStream(filePath);
    }
  }

  reply.status(404);
  return 'Admin dashboard page (admin.html) not found.';
}

// 1. Unauthenticated Health Endpoint
server.get('/health', async () => {
  return {
    ok: true,
    service: 'phi-gateway'
  };
});

// A dummy authenticated test endpoint to verify Phase 1 auth
server.get('/auth-test', { preHandler: authenticateRequest }, async (request) => {
  return {
    authenticated: true,
    client: {
      client_id: request.client?.client_id,
      label: request.client?.label,
      allowed_model_aliases: request.client?.allowed_model_aliases
    }
  };
});

// Error Handler
server.setErrorHandler((error: any, request, reply) => {
  const status = error.statusCode || 500;
  server.log.error(error, `[Error] ${request.method} ${request.url} failed with status ${status}`);
  
  reply.status(status).send({
    success: false,
    error: {
      code: error.code || 'internal_server_error',
      message: error.message || 'An unexpected error occurred.'
    }
  });
});

async function main() {
  try {
    // Load config files
    loadAllConfigs();
    startWatchingConfigs();

    const port = Number(process.env.PORT) || 3200;
    const host = '0.0.0.0';

    await server.listen({ port, host });
    console.log(`\n================================================================`);
    console.log(`🚀 PHI Gateway Server listening at http://localhost:${port}`);
    console.log(`================================================================\n`);
  } catch (error) {
    server.log.error(error);
    process.exit(1);
  }
}

// Only run main if file executed directly
if (require.main === module) {
  main();
}

export { server };
