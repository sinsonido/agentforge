import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

const DEFAULT_CONFIG = {
  project: { name: 'AgentForge Project', budget: 100, currency: 'USD' },
  providers: {},
  models: {},
  routing: { rules: [], fallback_strategy: 'same_tier_then_downgrade', cost_optimization: true },
  team: [],
  git: { enabled: false },
  alerts: { budget_warning_pct: 0.80, budget_pause_pct: 0.95 },
  server: { port: 4242, host: 'localhost' },
};

/**
 * Load and validate agentforge.yml configuration.
 * Resolves ${ENV_VAR} references to environment variables.
 */
export function loadConfig(configPath = 'agentforge.yml') {
  const fullPath = resolve(process.cwd(), configPath);

  if (!existsSync(fullPath)) {
    console.warn('[config] %s not found. Using defaults.', fullPath);
    return DEFAULT_CONFIG;
  }

  let raw = readFileSync(fullPath, 'utf-8');

  // Resolve env vars: ${VAR_NAME}
  raw = raw.replace(/\$\{(\w+)\}/g, (_, varName) => {
    return process.env[varName] || '';
  });

  const config = yaml.load(raw);
  return mergeDeep(DEFAULT_CONFIG, config || {});
}

/**
 * Build the runtime objects from config.
 * Returns { models, agents, providers, rules } ready for the engine.
 */
export function buildFromConfig(config) {
  // Build models registry
  const models = {};
  if (config.models) {
    for (const [id, m] of Object.entries(config.models)) {
      models[id] = { ...m };
    }
  }

  // Build agents map
  const agents = {};
  if (config.team) {
    for (const a of config.team) {
      const id = a.name.toLowerCase().replace(/\s+/g, '-');
      agents[id] = {
        id,
        name: a.name,
        role: a.role || '',
        model: a.model || null,
        fallback_models: a.fallback_models || [],
        system_prompt: a.system_prompt || '',
        system_prompt_file: a.system_prompt_file || null,
        tools: a.tools || [],
        require_review: a.require_review || false,
        reviewer: a.reviewer || null,
        max_cost_per_task: a.max_cost_per_task || null,
        max_tokens_per_task: a.max_tokens_per_task || null,
        allow_tier_downgrade: a.allow_tier_downgrade ?? true,
      };

      // Load system prompt from file if specified
      if (agents[id].system_prompt_file) {
        const promptPath = resolve(process.cwd(), agents[id].system_prompt_file);
        if (existsSync(promptPath)) {
          agents[id].system_prompt = readFileSync(promptPath, 'utf-8');
        }
      }
    }
  }

  return { models, agents, rules: config.routing?.rules || [] };
}

function mergeDeep(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export default loadConfig;
