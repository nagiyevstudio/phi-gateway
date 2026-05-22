import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

// Load environment variables from .env if present
dotenv.config();

export interface ClientRecord {
  client_id: string;
  label: string;
  enabled: boolean;
  key_hash: string;
  key_hint: string | null;
  allowed_model_aliases: string[];
}

export interface ClientsConfig {
  schema_version: number;
  clients: ClientRecord[];
}

export interface ProviderInfo {
  enabled: boolean;
  base_url: string;
  api_key_env: string;
  timeout_ms?: number;
}

export interface ModelInfo {
  provider: string;
  api_model_id: string;
  capabilities: string[];
}

export interface ProvidersConfig {
  schema_version: number;
  providers: Record<string, ProviderInfo>;
  models: Record<string, ModelInfo>;
}

export interface AliasInfo {
  enabled: boolean;
  target_model_key: string;
  fallback_model_keys: string[];
  required_capabilities: string[];
}

export interface ModelAliasesConfig {
  schema_version: number;
  model_aliases: Record<string, AliasInfo>;
}

// Config Paths
const projectRoot = path.resolve(__dirname, '..');

const getEnvOrLocalPath = (envVar: string, defaultRelativePath: string): string => {
  const envVal = process.env[envVar];
  if (envVal) {
    return path.isAbsolute(envVal) ? envVal : path.resolve(projectRoot, envVal);
  }
  return path.resolve(projectRoot, defaultRelativePath);
};

export const configPaths = {
  clients: getEnvOrLocalPath('PHI_GATEWAY_CLIENTS_CONFIG', 'config/clients.json'),
  providers: getEnvOrLocalPath('PHI_GATEWAY_PROVIDERS_CONFIG', 'config/providers.json'),
  aliases: getEnvOrLocalPath('PHI_GATEWAY_MODEL_ALIASES_CONFIG', 'config/model-aliases.json'),
  logDir: getEnvOrLocalPath('PHI_GATEWAY_LOG_DIR', 'logs')
};

// Global Config State
let clientsConfig: ClientsConfig = { schema_version: 1, clients: [] };
let providersConfig: ProvidersConfig = { schema_version: 1, providers: {}, models: {} };
let aliasesConfig: ModelAliasesConfig = { schema_version: 1, model_aliases: {} };

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`Config file not found: ${filePath}. Using fallback.`);
      return fallback;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    console.error(`Error reading or parsing config file: ${filePath}`, error);
    return fallback;
  }
}

export function loadAllConfigs(): void {
  console.log(`[Config] Loading configurations from:`);
  console.log(`  - Clients:   ${configPaths.clients}`);
  console.log(`  - Providers: ${configPaths.providers}`);
  console.log(`  - Aliases:   ${configPaths.aliases}`);

  clientsConfig = readJsonFile<ClientsConfig>(configPaths.clients, { schema_version: 1, clients: [] });
  providersConfig = readJsonFile<ProvidersConfig>(configPaths.providers, { schema_version: 1, providers: {}, models: {} });
  aliasesConfig = readJsonFile<ModelAliasesConfig>(configPaths.aliases, { schema_version: 1, model_aliases: {} });

  console.log(`[Config] Loaded ${clientsConfig.clients.length} clients, ${Object.keys(providersConfig.providers).length} providers, ${Object.keys(aliasesConfig.model_aliases).length} aliases.`);
}

// Watch config files and reload dynamically
let watchDebounceTimeout: NodeJS.Timeout | null = null;
export function startWatchingConfigs(): void {
  const watchPaths = [configPaths.clients, configPaths.providers, configPaths.aliases];
  
  watchPaths.forEach(filePath => {
    // Only watch if the folder exists, to avoid watch errors
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Touch file if it doesn't exist to make fs.watch work
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '{}', 'utf8');
    }

    fs.watch(filePath, (event) => {
      if (event === 'change') {
        if (watchDebounceTimeout) clearTimeout(watchDebounceTimeout);
        watchDebounceTimeout = setTimeout(() => {
          console.log(`[Config] Detected change in config files. Reloading...`);
          loadAllConfigs();
        }, 100);
      }
    });
  });
}

// Getters
export function getClients(): ClientRecord[] {
  return clientsConfig.clients;
}

export function getProviders(): Record<string, ProviderInfo> {
  return providersConfig.providers;
}

export function getModels(): Record<string, ModelInfo> {
  return providersConfig.models;
}

export function getModelAliases(): Record<string, AliasInfo> {
  return aliasesConfig.model_aliases;
}

// Setters / Savers
export function writeJsonFile(filePath: string, data: any): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error(`Error writing config file: ${filePath}`, error);
    throw error;
  }
}

export function saveClients(clients: ClientRecord[]): void {
  clientsConfig.clients = clients;
  writeJsonFile(configPaths.clients, clientsConfig);
}

export function saveProvidersAndModels(providers: Record<string, ProviderInfo>, models: Record<string, ModelInfo>): void {
  providersConfig.providers = providers;
  providersConfig.models = models;
  writeJsonFile(configPaths.providers, providersConfig);
}

export function saveModelAliases(aliases: Record<string, AliasInfo>): void {
  aliasesConfig.model_aliases = aliases;
  writeJsonFile(configPaths.aliases, aliasesConfig);
}
