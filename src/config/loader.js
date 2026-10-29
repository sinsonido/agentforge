import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { PLAYBOOKS } from '../core/task-model.js';
import { parseAutonomy } from '../core/autonomy.js';

const DEFAULT_CONFIG = {
  project: { name: 'AgentForge Project', budget: 100 },
  providers: {},
  models: {},
  routing: { rules: [] },
  team: [],
  alerts: { budget_warning_pct: 0.80, budget_pause_pct: 0.95 },
  server: { port: 4242, host: 'localhost' },
  intake: { repos: [], label: 'agentforge', interval_seconds: 60, default_playbook: 'feature' },
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

  const config = mergeDeep(DEFAULT_CONFIG, yaml.load(raw) || {});
  validateModelReferences(config);
  validateIntake(config.intake);
  config.autonomy = validateAutonomy(config.autonomy);
  return config;
}

/**
 * The `autonomy:` block as a full policy, every action with its rule.
 * Throws when it names an unknown action or a rule the action does not take.
 * @returns {import('../core/autonomy.js').Policy}
 */
export function validateAutonomy(raw) {
  const parsed = parseAutonomy(raw);
  if (!parsed.ok) throw new Error(`Invalid autonomy configuration: ${parsed.error}`);
  return parsed.value;
}

/**
 * Throw when a model referenced by the team or routing rules is not in `models`,
 * or a model names a provider missing from `providers`.
 * A disabled provider still counts as configured.
 */
export function validateModelReferences(config) {
  const models = config.models || {};
  const providers = config.providers || {};
  const errors = [];

  for (const [id, m] of Object.entries(models)) {
    if (!m?.provider) {
      errors.push(`model "${id}" has no provider`);
    } else if (!providers[m.provider]) {
      errors.push(`model "${id}" uses provider "${m.provider}", which is not under providers:`);
    }
  }

  const refs = [];
  for (const a of config.team || []) {
    if (a.model) refs.push([a.model, `team "${a.name}" model`]);
    for (const fb of a.fallback_models || []) refs.push([fb, `team "${a.name}" fallback_models`]);
  }
  (config.routing?.rules || []).forEach((rule, i) => {
    if (rule.force) refs.push([rule.force, `routing rule #${i + 1} force`]);
    if (rule.prefer) refs.push([rule.prefer, `routing rule #${i + 1} prefer`]);
    for (const fb of rule.fallback || []) refs.push([fb, `routing rule #${i + 1} fallback`]);
  });

  for (const [id, where] of refs) {
    if (!models[id]) errors.push(`${where} references "${id}", which is not under models:`);
  }

  if (errors.length) {
    throw new Error(`Invalid model configuration:\n  - ${errors.join('\n  - ')}`);
  }
}

/**
 * Throw when the `intake:` block cannot drive the GitHub issue poller.
 * Each repo needs an "owner/name" slug and the base branch its PRs target.
 * `setup_command` and `test_command` are optional; when given they must be non-empty strings.
 */
export function validateIntake(intake) {
  if (!intake || typeof intake !== 'object') throw new Error('Invalid intake configuration: intake must be a mapping');
  const errors = [];
  if (!Array.isArray(intake.repos)) {
    errors.push('repos must be a list');
  } else {
    intake.repos.forEach((r, i) => {
      if (!/^[\w.-]+\/[\w.-]+$/.test(r?.repo ?? '')) errors.push(`repos[${i}].repo must be "owner/name"`);
      if (typeof r?.base !== 'string' || !r.base.trim()) errors.push(`repos[${i}].base is required`);
      for (const f of ['setup_command', 'test_command']) {
        if (r?.[f] != null && (typeof r[f] !== 'string' || !r[f].trim())) errors.push(`repos[${i}].${f} must be a non-empty string`);
      }
    });
  }
  if (typeof intake.label !== 'string' || !intake.label.trim()) errors.push('label must be a non-empty string');
  if (!(typeof intake.interval_seconds === 'number' && intake.interval_seconds > 0)) {
    errors.push('interval_seconds must be a positive number');
  }
  if (!PLAYBOOKS.includes(intake.default_playbook)) {
    errors.push(`default_playbook must be one of: ${PLAYBOOKS.join(', ')}`);
  }
  if (errors.length) {
    throw new Error(`Invalid intake configuration:\n  - ${errors.join('\n  - ')}`);
  }
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
        max_tokens_per_task: a.max_tokens_per_task || null,
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
