import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { authenticateRequest } from '../auth';
import { getRequestLogs } from '../utils/logger';
import {
  getClients,
  getProviders,
  getModels,
  getModelAliases,
  saveClients,
  saveProvidersAndModels,
  saveModelAliases,
  ClientRecord
} from '../config';
import { callOpenAICompat } from '../adapters/openai-compat';
import { callGemini } from '../adapters/gemini';

// Helper to locate the env file (.env locally or phi-gateway.env on VPS)
function getEnvFilePath(): string {
  const clientsConfigPath = process.env.PHI_GATEWAY_CLIENTS_CONFIG;
  if (clientsConfigPath) {
    const configDir = path.dirname(clientsConfigPath);
    const vpsEnvPath = path.join(configDir, 'phi-gateway.env');
    if (fs.existsSync(vpsEnvPath)) {
      return vpsEnvPath;
    }
  }
  return path.resolve(process.cwd(), '.env');
}

// Helper to hash a key using scrypt
function generateScryptHash(secret: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString('hex'));
    });
  });
}

export const adminRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Use our standard bearer authentication middleware for all administrative API routes
  fastify.addHook('preHandler', authenticateRequest);

  // 1. Get Status and Request Log History
  fastify.get('/api/status', async (request, reply) => {
    const uptime = process.uptime();
    const memory = process.memoryUsage();
    
    const clients = getClients();
    const providers = getProviders();
    const models = getModels();
    const aliases = getModelAliases();

    return {
      success: true,
      data: {
        uptime,
        memory: {
          rss: memory.rss,
          heapTotal: memory.heapTotal,
          heapUsed: memory.heapUsed,
          external: memory.external
        },
        stats: {
          clientsCount: clients.length,
          providersCount: Object.keys(providers).length,
          modelsCount: Object.keys(models).length,
          aliasesCount: Object.keys(aliases).length
        },
        logs: getRequestLogs()
      }
    };
  });

  // 2. Get Configurations (clients, providers, models, aliases, and status of env keys)
  fastify.get('/api/config', async (request, reply) => {
    const providers = getProviders();
    
    // Scan which environment variables are set without sending the raw secrets to client
    const envStatus: Record<string, boolean> = {};
    Object.values(providers).forEach(p => {
      if (p.api_key_env) {
        envStatus[p.api_key_env] = !!process.env[p.api_key_env];
      }
    });

    // Also scan common ones
    const commonKeys = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'MISTRAL_API_KEY', 'DASHSCOPE_API_KEY'];
    commonKeys.forEach(k => {
      envStatus[k] = !!process.env[k];
    });

    return {
      success: true,
      data: {
        clients: getClients(),
        providers,
        models: getModels(),
        aliases: getModelAliases(),
        envStatus
      }
    };
  });

  // 3. Save Configurations (providers, models, aliases)
  fastify.post('/api/config', async (request, reply) => {
    const { providers, models, aliases } = request.body as any;

    try {
      if (providers !== undefined || models !== undefined) {
        const currentProviders = providers !== undefined ? providers : getProviders();
        const currentModels = models !== undefined ? models : getModels();
        saveProvidersAndModels(currentProviders, currentModels);
      }
      if (aliases !== undefined) {
        saveModelAliases(aliases);
      }
      return { success: true, message: 'Configuration saved successfully.' };
    } catch (error: any) {
      reply.status(500);
      return { success: false, error: { code: 'config_write_error', message: error.message } };
    }
  });

  // 4. Save API keys / environment variables
  fastify.post('/api/env', async (request, reply) => {
    const updates = request.body as Record<string, string>;

    try {
      const envPath = getEnvFilePath();
      let content = '';
      if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, 'utf8');
      }

      const lines = content.split('\n');
      for (const [key, val] of Object.entries(updates)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) continue;
        const trimmedVal = val.trim();

        // Update in memory immediately
        process.env[trimmedKey] = trimmedVal;

        // Update or append in file content
        let found = false;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.startsWith(`${trimmedKey}=`) || line.startsWith(`export ${trimmedKey}=`)) {
            const isExport = line.startsWith('export ');
            lines[i] = isExport ? `export ${trimmedKey}=${trimmedVal}` : `${trimmedKey}=${trimmedVal}`;
            found = true;
            break;
          }
        }
        if (!found) {
          lines.push(`${trimmedKey}=${trimmedVal}`);
        }
      }

      fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
      return { success: true, message: 'API keys updated successfully.' };
    } catch (error: any) {
      reply.status(500);
      return { success: false, error: { code: 'env_write_error', message: error.message } };
    }
  });

  // 5. Generate a new Client Token
  fastify.post('/api/clients/generate', async (request, reply) => {
    const { client_id, label, allowed_model_aliases } = request.body as {
      client_id: string;
      label: string;
      allowed_model_aliases: string[];
    };

    if (!client_id || !label || !allowed_model_aliases) {
      reply.status(400);
      return { success: false, error: { code: 'bad_request', message: 'Missing client_id, label or allowed_model_aliases.' } };
    }

    try {
      // Check if client_id already exists
      const clients = getClients();
      if (clients.some(c => c.client_id === client_id)) {
        reply.status(400);
        return { success: false, error: { code: 'client_exists', message: `Client with ID '${client_id}' already exists.` } };
      }

      // Generate secure random token
      const rawToken = `phi_${crypto.randomBytes(32).toString('hex')}`;
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = await generateScryptHash(rawToken, salt);
      const keyHash = `scrypt$${salt}$${hash}`;
      const keyHint = `...${rawToken.slice(-6)}`;

      const newClient: ClientRecord = {
        client_id,
        label,
        enabled: true,
        key_hash: keyHash,
        key_hint: keyHint,
        allowed_model_aliases
      };

      clients.push(newClient);
      saveClients(clients);

      return {
        success: true,
        data: {
          client: newClient,
          raw_token: rawToken // ONLY returned once
        }
      };
    } catch (error: any) {
      reply.status(500);
      return { success: false, error: { code: 'client_generation_failed', message: error.message } };
    }
  });

  // 6. Delete or Toggle Client
  fastify.post('/api/clients/edit', async (request, reply) => {
    const { client_id, enabled, allowed_model_aliases, label } = request.body as {
      client_id: string;
      enabled?: boolean;
      allowed_model_aliases?: string[];
      label?: string;
    };

    try {
      const clients = getClients();
      const clientIndex = clients.findIndex(c => c.client_id === client_id);
      if (clientIndex === -1) {
        reply.status(404);
        return { success: false, error: { code: 'client_not_found', message: 'Client not found.' } };
      }

      if (enabled !== undefined) clients[clientIndex].enabled = enabled;
      if (allowed_model_aliases !== undefined) clients[clientIndex].allowed_model_aliases = allowed_model_aliases;
      if (label !== undefined) clients[clientIndex].label = label;

      saveClients(clients);
      return { success: true, client: clients[clientIndex] };
    } catch (error: any) {
      reply.status(500);
      return { success: false, error: { code: 'client_save_error', message: error.message } };
    }
  });

  // 7. Delete Client
  fastify.post('/api/clients/delete', async (request, reply) => {
    const { client_id } = request.body as { client_id: string };

    try {
      const clients = getClients();
      const filtered = clients.filter(c => c.client_id !== client_id);
      if (filtered.length === clients.length) {
        reply.status(404);
        return { success: false, error: { code: 'client_not_found', message: 'Client not found.' } };
      }

      saveClients(filtered);
      return { success: true, message: 'Client deleted successfully.' };
    } catch (error: any) {
      reply.status(500);
      return { success: false, error: { code: 'client_delete_error', message: error.message } };
    }
  });

  // 8. Test a model by sending a simple prompt
  fastify.post('/api/models/test', async (request, reply) => {
    const { model_key } = request.body as { model_key: string };

    if (!model_key) {
      reply.status(400);
      return { success: false, error: { code: 'bad_request', message: 'Missing model_key.' } };
    }

    const models = getModels();
    const providers = getProviders();
    const modelInfo = models[model_key];

    if (!modelInfo) {
      reply.status(404);
      return { success: false, error: { code: 'model_not_found', message: `Model '${model_key}' not found.` } };
    }

    const providerInfo = providers[modelInfo.provider];
    if (!providerInfo) {
      reply.status(400);
      return { success: false, error: { code: 'provider_not_found', message: `Provider '${modelInfo.provider}' not found.` } };
    }

    if (!providerInfo.enabled) {
      return { success: false, error: { code: 'provider_disabled', message: `Provider '${modelInfo.provider}' is disabled.` } };
    }

    const apiKey = process.env[providerInfo.api_key_env];
    if (!apiKey) {
      return { success: false, error: { code: 'api_key_missing', message: `API key '${providerInfo.api_key_env}' is not set.` } };
    }

    const testPayload = {
      model: modelInfo.api_model_id,
      messages: [
        { role: 'user', content: 'Reply with exactly: "PHI Gateway test OK"' }
      ],
      max_tokens: 50,
      temperature: 0
    };

    const startTime = process.hrtime();

    try {
      let result: any;
      if (modelInfo.provider === 'google') {
        result = await callGemini(
          modelInfo.api_model_id,
          apiKey,
          providerInfo.base_url,
          testPayload as any,
          'admin-test',
          providerInfo.timeout_ms || 30000
        );
      } else {
        result = await callOpenAICompat(
          modelInfo.api_model_id,
          apiKey,
          providerInfo.base_url,
          testPayload as any,
          'admin-test',
          providerInfo.timeout_ms || 30000
        );
      }

      const diff = process.hrtime(startTime);
      const durationMs = Math.round(diff[0] * 1e3 + diff[1] * 1e-6);

      const content = result?.choices?.[0]?.message?.content || result?.content || JSON.stringify(result).slice(0, 200);

      return {
        success: true,
        data: {
          model_key,
          provider: modelInfo.provider,
          api_model_id: modelInfo.api_model_id,
          status: 'ok',
          duration_ms: durationMs,
          response_preview: typeof content === 'string' ? content.slice(0, 300) : JSON.stringify(content).slice(0, 300)
        }
      };
    } catch (error: any) {
      const diff = process.hrtime(startTime);
      const durationMs = Math.round(diff[0] * 1e3 + diff[1] * 1e-6);

      return {
        success: false,
        data: {
          model_key,
          provider: modelInfo.provider,
          api_model_id: modelInfo.api_model_id,
          status: 'error',
          duration_ms: durationMs,
          error_message: error.message || String(error)
        }
      };
    }
  });
};
