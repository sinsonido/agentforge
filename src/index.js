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
import { decideApproval, executorConfig, runCodingTask } from './execution/coding-runner.js';
import { merge, publish, pushFix } from './execution/publish.js';
import { BABYSIT_DEFAULTS, ghCiReader } from './execution/babysit.js';

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
    const babysit = config.babysit ?? BABYSIT_DEFAULTS;
    const host = {
      queue: taskQueue, publish, merge, pushFix, policy: config.autonomy,
      execute: (t, opts) => runExecutor(t, {
        ...options, ...opts,
        instance: process.env.AGENTFORGE_INSTANCE,
        recordEvent: (id, event) => db.appendTaskEvent(id, event),
      }),
      babysit: { ci: ghCiReader({ checks: babysit.checks }), maxRounds: babysit.max_rounds, timeoutMs: babysit.timeout_minutes * 60_000 },
    };
    coding = {
      concurrency,
      run: (task, signal) => runCodingTask(task, { ...host, signal }),
      decide: (task, choice) => decideApproval(task, choice, host),
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

  const TASK_EVENTS = ['task.queued', 'task.executing', 'task.needs_approval', 'task.ci_watch', 'task.fixing', 'task.completed', 'task.failed'];

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

/**
 * On SIGINT or SIGTERM: stop the orchestrator, wait for its running coding tasks
 * to stop their containers and end cancelled, then close the database and exit.
 */
export function exitOnSignals(forge, cleanup = () => {}) {
  let stopping = false;
  const onSignal = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log('\n[agentforge] %s: shutting down...', signal);
    cleanup();
    await forge.orchestrator.stop();
    forge.db?.close();
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// Run directly
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const forge = await createAgentForge();
  forge.orchestrator.start();
  exitOnSignals(forge);
}
