import { loadConfig, buildFromConfig } from './config/loader.js';
import { TaskQueue } from './core/task-queue.js';
import { QuotaManager } from './core/quota-tracker.js';
import { Router } from './routing/router.js';
import { Orchestrator } from './core/orchestrator.js';
import { ProviderRegistry, OllamaProvider } from './providers/interface.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleProvider } from './providers/google.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import eventBus from './core/event-bus.js';

/**
 * Bootstrap AgentForge from config.
 * Returns a running orchestrator instance.
 */
export async function createAgentForge(configPath) {
  console.log('[agentforge] Loading config...');
  const config = loadConfig(configPath);
  const { models, agents, rules } = buildFromConfig(config);

  // Task queue
  const taskQueue = new TaskQueue();

  // Quota manager
  const quotaManager = new QuotaManager();
  for (const [id, provConfig] of Object.entries(config.providers || {})) {
    if (provConfig.enabled !== false && provConfig.quota) {
      quotaManager.addProvider(id, provConfig.quota);
    }
  }

  // Provider registry
  const providerRegistry = new ProviderRegistry();

  // Register Ollama (local, always try)
  if (config.providers?.ollama?.enabled !== false) {
    const ollama = new OllamaProvider(config.providers?.ollama || {});
    providerRegistry.register(ollama);
    const ok = await ollama.healthCheck();
    console.log('[agentforge] Ollama: %s', ok ? 'connected ✓' : 'not available');
  }

  // Register Anthropic
  if (config.providers?.anthropic?.enabled !== false && config.providers?.anthropic?.api_key) {
    providerRegistry.register(new AnthropicProvider(config.providers.anthropic));
    console.log('[agentforge] Anthropic: configured ✓');
  }

  // Register Google (Gemini)
  if (config.providers?.google?.enabled !== false && config.providers?.google?.api_key) {
    providerRegistry.register(new GoogleProvider(config.providers.google));
    console.log('[agentforge] Google (Gemini): configured ✓');
  }

  // Register DeepSeek
  if (config.providers?.deepseek?.enabled !== false && config.providers?.deepseek?.api_key) {
    providerRegistry.register(new DeepSeekProvider(config.providers.deepseek));
    console.log('[agentforge] DeepSeek: configured ✓');
  }

  // Register OpenRouter
  if (config.providers?.openrouter?.enabled !== false && config.providers?.openrouter?.api_key) {
    providerRegistry.register(new OpenRouterProvider(config.providers.openrouter));
    console.log('[agentforge] OpenRouter: configured ✓');
  }

  // Router
  const router = new Router({ rules, models, agents, quotaManager });

  // Orchestrator
  const orchestrator = new Orchestrator({
    taskQueue,
    router,
    quotaManager,
    providerRegistry,
    agents,
    config,
  });

  console.log('[agentforge] Ready.');
  console.log('[agentforge] Models: %d | Agents: %d | Rules: %d',
    Object.keys(models).length,
    Object.keys(agents).length,
    rules.length,
  );

  return {
    orchestrator,
    taskQueue,
    router,
    quotaManager,
    providerRegistry,
    eventBus,
    config,
    agents,
    models,
  };
}

// Run directly
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const forge = await createAgentForge();
  forge.orchestrator.start();

  process.on('SIGINT', () => {
    forge.orchestrator.stop();
    process.exit(0);
  });
}
