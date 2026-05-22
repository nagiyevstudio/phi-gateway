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
};
