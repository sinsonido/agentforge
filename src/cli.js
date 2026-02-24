#!/usr/bin/env node
import { Command } from 'commander';
import { createAgentForge } from './index.js';
import { loadConfig } from './config/loader.js';

const VERSION = '0.1.0';

const BANNER = `
╔══════════════════════════════════════╗
║         AgentForge v${VERSION}          ║
║   Multi-agent orchestration platform ║
╚══════════════════════════════════════╝`;

const program = new Command();

program
  .name('agentforge')
  .version(VERSION)
  .description('Multi-agent orchestration platform with cost control and intelligent model routing')
  .option('-c, --config <path>', 'Path to config file', 'agentforge.yml');

// ─── agentforge start ──────────────────────────────────

program
  .command('start')
  .description('Start the orchestrator and dashboard')
  .option('-p, --port <port>', 'Dashboard port', '4242')
  .option('--host <host>', 'Dashboard bind address', '127.0.0.1')
  .option('--no-dashboard', 'Start without the web dashboard')
  .action(async (opts) => {
    console.log(BANNER);
    const configPath = program.opts().config;

    try {
      const forge = await createAgentForge(configPath);
      const { orchestrator, quotaManager, taskQueue, config } = forge;

      // Start orchestrator loop
      orchestrator.start(500);
      console.log('\n[✓] Orchestrator started');

      // Start dashboard server if enabled
      const port = parseInt(opts.port) || config.server?.port || 4242;
      const host = opts.host || config.server?.host || '127.0.0.1';
      if (opts.dashboard !== false) {
        try {
          const { startServer } = await import('./api/server.js').catch(() => null) || {};
          if (startServer) {
            await startServer(forge, port, host);
            console.log(`[✓] Dashboard: http://${host}:${port}`);
          }
        } catch {
          // Dashboard not yet implemented — skip silently
        }
      }

      console.log('\nPress Ctrl+C to stop.\n');

      // Status line every 30s
      const statusInterval = setInterval(() => {
        const stats = taskQueue.stats();
        const quotaStatuses = quotaManager.getAllStatuses();
        const throttled = Object.values(quotaStatuses).filter(s => s.state !== 'available').length;
        console.log(
          '[status] Tasks: %d queued | %d executing | %d completed | Throttled providers: %d',
          stats.queued, stats.executing, stats.completed, throttled
        );
      }, 30_000);

      process.on('SIGINT', () => {
        console.log('\n[agentforge] Shutting down...');
        clearInterval(statusInterval);
        orchestrator.stop();
        forge.db?.close();
        process.exit(0);
      });

    } catch (err) {
      console.error('[error]', err.message);
      process.exit(1);
    }
  });

// ─── agentforge task ──────────────────────────────────

const taskCmd = program.command('task').description('Manage tasks');

taskCmd
  .command('add <title>')
  .description('Add a new task to the queue')
  .option('-t, --type <type>', 'Task type (implement, review, test, etc.)', 'implement')
  .option('-p, --priority <priority>', 'Priority (critical, high, medium, low)', 'medium')
  .option('-a, --agent <agent>', 'Agent ID to assign')
  .option('--project <project>', 'Project ID')
  .option('--depends-on <ids...>', 'Dependency task IDs')
  .action(async (title, opts) => {
    try {
      const forge = await createAgentForge(program.opts().config);
      const task = forge.taskQueue.add({
        title,
        type: opts.type,
        priority: opts.priority,
        agent_id: opts.agent || null,
        project_id: opts.project || null,
        depends_on: opts.dependsOn || [],
      });
      console.log('[✓] Task created: %s (%s)', task.id, task.title);
    } catch (err) {
      console.error('[error]', err.message);
      process.exit(1);
    }
  });

taskCmd
  .command('list')
  .description('List all tasks')
  .option('-s, --status <status>', 'Filter by status')
  .action(async (opts) => {
    try {
      const forge = await createAgentForge(program.opts().config);
      const tasks = opts.status
        ? forge.taskQueue.getByStatus(opts.status)
        : forge.taskQueue.getAll();

      if (!tasks.length) {
        console.log('No tasks found.');
        return;
      }

      console.log('\n%-12s %-10s %-10s %-8s  %s', 'ID', 'STATUS', 'TYPE', 'PRIORITY', 'TITLE');
      console.log('─'.repeat(72));
      for (const t of tasks) {
        console.log('%-12s %-10s %-10s %-8s  %s',
          t.id, t.status, t.type, t.priority, t.title.slice(0, 40)
        );
      }
      console.log();
    } catch (err) {
      console.error('[error]', err.message);
      process.exit(1);
    }
  });

taskCmd
  .command('show <id>')
  .description('Show details of a specific task')
  .action(async (id) => {
    try {
      const forge = await createAgentForge(program.opts().config);
      const task = forge.taskQueue.get(id);
      if (!task) {
        console.error('Task not found: %s', id);
        process.exit(1);
      }
      console.log('\nTask: %s', task.id);
      console.log('─'.repeat(40));
      console.log('Title:    %s', task.title);
      console.log('Status:   %s', task.status);
      console.log('Type:     %s', task.type);
      console.log('Priority: %s', task.priority);
      console.log('Agent:    %s', task.agent_id || '-');
      console.log('Model:    %s', task.model_used || '-');
      console.log('Cost:     $%s', (task.cost || 0).toFixed(4));
      console.log('Tokens:   %d in / %d out', task.tokens_in || 0, task.tokens_out || 0);
      if (task.result) {
        console.log('\nResult:\n%s', String(task.result).slice(0, 500));
      }
      console.log();
    } catch (err) {
      console.error('[error]', err.message);
      process.exit(1);
    }
  });

// ─── agentforge status ──────────────────────────────────

program
  .command('status')
  .description('Show system status (agents, quotas, budget)')
  .action(async () => {
    try {
      const forge = await createAgentForge(program.opts().config);
      const { taskQueue, quotaManager } = forge;

      const stats = taskQueue.stats();
      console.log('\n── Task Queue ──────────────────────────');
      console.log('  Total:     %d', stats.total);
      console.log('  Queued:    %d', stats.queued);
      console.log('  Executing: %d', stats.executing);
      console.log('  Completed: %d', stats.completed);
      console.log('  Failed:    %d', stats.failed);
      console.log('  Waiting:   %d', stats.waiting);

      const quotas = quotaManager.getAllStatuses();
      if (Object.keys(quotas).length) {
        console.log('\n── Quota Status ────────────────────────');
        for (const [id, q] of Object.entries(quotas)) {
          const bar = _bar(q.tokens.pct);
          console.log('  %-14s [%s] %s  req: %d/%s',
            id, bar, q.state,
            q.requests.used,
            q.requests.max === Infinity ? '∞' : q.requests.max
          );
        }
      }

      console.log('\n── Providers ───────────────────────────');
      for (const [id] of forge.providerRegistry.providers) {
        console.log('  %-14s configured', id);
      }
      console.log();
    } catch (err) {
      console.error('[error]', err.message);
      process.exit(1);
    }
  });

// ─── agentforge config check ──────────────────────────────────

program
  .command('config')
  .description('Config utilities')
  .command('check')
  .description('Validate agentforge.yml')
  .action(() => {
    try {
      const configPath = program.opts().config;
      const config = loadConfig(configPath);
      console.log('[✓] Config valid: %s', configPath);
      console.log('  Project: %s ($%s budget)', config.project?.name, config.project?.budget);
      console.log('  Providers: %s', Object.keys(config.providers || {}).filter(k => config.providers[k].enabled !== false).join(', ') || 'none');
      console.log('  Models: %d configured', Object.keys(config.models || {}).length);
      console.log('  Team: %d agents', (config.team || []).length);
      console.log('  Routing rules: %d', (config.routing?.rules || []).length);
    } catch (err) {
      console.error('[✗] Config invalid:', err.message);
      process.exit(1);
    }
  });

// ─── Helpers ──────────────────────────────────────────

function _bar(pct, width = 10) {
  const filled = Math.round((pct || 0) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

program.parse(process.argv);
