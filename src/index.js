import { loadConfig, buildFromConfig } from './config/loader.js';
import { TaskQueue } from './core/task-queue.js';
import { QuotaManager } from './core/quota-tracker.js';
import { Router } from './routing/router.js';
import { Orchestrator } from './core/orchestrator.js';
import { AgentForgeDB } from './persistence/db.js';
import { ProviderRegistry, OllamaProvider } from './providers/interface.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleProvider } from './providers/google.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import eventBus from './core/event-bus.js';
import { createIntake } from './core/intake.js';
import { run as runExecutor } from './execution/coding-executor.js';
import { executorConfig, runCodingTask } from './execution/coding-runner.js';
import { publish } from './execution/publish.js';

/**
 * Bootstrap AgentForge from config.
 * Returns a running orchestrator instance.
 */
export async function createAgentForge(configPath) {
  console.log('[agentforge] Loading config...');
  const config = loadConfig(configPath);
  const { models, agents, rules } = buildFromConfig(config);

  // Database, then the task queue it restores and writes through to
  const db = new AgentForgeDB(config.database?.path);
  const taskQueue = new TaskQueue({ store: db });

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

  // Coding loop: with an executor and intake repos, labelled issues become coding
  // tasks that run in a container and end in a PR opened from this host.
  let coding = null;
  let intake = null;
  if (config.executor && config.intake?.repos?.length) {
    const { concurrency, options } = executorConfig(config.executor);
    coding = {
      concurrency,
      run: (task, signal) => runCodingTask(task, {
        queue: taskQueue,
        execute: (t, opts) => runExecutor(t, { ...options, ...opts }),
        publish,
        signal,
      }),
    };
    intake = createIntake({ intake: config.intake, queue: taskQueue });
    eventBus.on('task.agent_event', ({ taskId, event }) => console.log('[coding] %s %s', taskId, describeAgentEvent(event)));
    console.log('[agentforge] Coding loop: %s, concurrency %d', config.intake.repos.map(r => r.repo).join(', '), concurrency);
  }

  // Orchestrator
  const orchestrator = new Orchestrator({
    taskQueue,
    router,
    quotaManager,
    providerRegistry,
    agents,
    config,
    coding,
    intake,
  });

  const TASK_EVENTS = ['task.queued', 'task.executing', 'task.completed', 'task.failed'];

  eventBus.on('cost.recorded', ({ projectId, agentId, model, tokensIn, tokensOut, cost }) => {
    db.recordCost(projectId, agentId, model, tokensIn, tokensOut, cost);
  });

  // Log all events to DB
  const ALL_LOG_EVENTS = [...TASK_EVENTS, 'cost.recorded', 'quota.exhausted', 'quota.reset', 'budget.exceeded', 'budget.warning'];
  for (const evt of ALL_LOG_EVENTS) {
    eventBus.on(evt, (data) => db.logEvent(evt, data));
  }

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
    db,
    eventBus,
    config,
    agents,
    models,
  };
}

function describeAgentEvent(event) {
  const clip = (v) => String(v ?? '').replace(/\s+/g, ' ').slice(0, 160);
  switch (event.type) {
    case 'tool_use': return `tool_use ${event.name} ${clip(event.input?.command ?? event.input?.file_path ?? event.input?.subject ?? '')}`;
    case 'tool_result': return `tool_result ${event.name}${event.isError ? ' error' : ''}`;
    case 'text': return `text ${clip(event.text)}`;
    case 'result': return `result ${event.subtype} $${event.costUsd ?? '?'} turns=${event.numTurns}`;
    default: return event.type;
  }
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
