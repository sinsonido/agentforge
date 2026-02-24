/**
 * AgentForge Dashboard — Single-Page Application
 * GitHub issues #35 #36 #37 #38 #39
 */

// ─────────────────────────────────────────────────────────────────────────────
// API client
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = '/api';

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(API_BASE + path, opts);
  const data = await res.json().catch(() => ({ ok: false, error: 'Invalid JSON' }));
  if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const get  = (path)        => api('GET',  path);
const post = (path, body)  => api('POST', path, body);

// ─────────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────────

function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────────────────────

function openModal(html) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal">${html}</div>`;
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
  return backdrop;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function fmtUSD(n) {
  if (n == null) return '—';
  return '$' + Number(n).toFixed(4);
}

function timeAgo(ts) {
  if (!ts) return '—';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60)   return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
}

function badgeClass(status) {
  const map = {
    queued: 'badge-queued', executing: 'badge-executing',
    completed: 'badge-completed', failed: 'badge-failed',
    idle: 'badge-idle', running: 'badge-running',
    ok: 'badge-ok', warn: 'badge-warn', error: 'badge-error',
  };
  return map[status] || 'badge-queued';
}

function badge(status) {
  return `<span class="badge ${badgeClass(status)}">${status}</span>`;
}

function priorityDot(p = 'medium') {
  const cls = { high: 'priority-high', medium: 'priority-medium', low: 'priority-low' }[p] || 'priority-medium';
  return `<div class="priority-dot ${cls}" title="Priority: ${p}"></div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket — real-time event feed
// ─────────────────────────────────────────────────────────────────────────────

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
let ws = null;
let wsReconnectTimer = null;
const eventLog = [];        // in-memory log for dashboard feed
const WS_LISTENERS = [];    // view-specific listeners

function wsConnect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setWsStatus('connected');
    clearTimeout(wsReconnectTimer);
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const entry = { ...msg, receivedAt: Date.now() };
    eventLog.unshift(entry);
    if (eventLog.length > 500) eventLog.length = 500;
    WS_LISTENERS.forEach(fn => fn(entry));
  };

  ws.onclose = () => {
    setWsStatus('error');
    wsReconnectTimer = setTimeout(wsConnect, 3000);
  };

  ws.onerror = () => {
    setWsStatus('error');
  };
}

function setWsStatus(state) {
  const el = document.getElementById('ws-status');
  const txt = document.getElementById('ws-status-text');
  if (!el || !txt) return;
  el.className = state;
  txt.textContent = state === 'connected' ? 'Live' : state === 'error' ? 'Reconnecting…' : 'Connecting…';
}

function onWsMessage(fn) {
  WS_LISTENERS.push(fn);
  return () => {
    const i = WS_LISTENERS.indexOf(fn);
    if (i >= 0) WS_LISTENERS.splice(i, 1);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Client-side router
// ─────────────────────────────────────────────────────────────────────────────

const VIEWS = {
  dashboard: renderDashboard,
  kanban:    renderKanban,
  agents:    renderAgents,
  providers: renderProviders,
  costs:     renderCosts,
};

const VIEW_TITLES = {
  dashboard: 'Dashboard',
  kanban:    'Kanban Board',
  agents:    'Agents',
  providers: 'Providers',
  costs:     'Costs',
};

let currentView = null;
let currentCleanup = null;

function navigate(view) {
  if (!VIEWS[view]) return;

  // Update nav items
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.getElementById(`nav-${view}`);
  if (navEl) navEl.classList.add('active');

  // Update topbar
  document.getElementById('topbar-title').textContent = VIEW_TITLES[view] || view;
  document.getElementById('topbar-actions').innerHTML = '';

  // Cleanup previous view
  if (currentCleanup) { currentCleanup(); currentCleanup = null; }

  // Render new view
  currentView = view;
  const viewEl = document.getElementById('view');
  viewEl.innerHTML = `<div class="empty-state"><div class="spinner"></div><span>Loading…</span></div>`;
  VIEWS[view]().catch(err => {
    viewEl.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠</div><span>${err.message}</span></div>`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// View: Dashboard (#35)
// ─────────────────────────────────────────────────────────────────────────────

async function renderDashboard() {
  const viewEl = document.getElementById('view');

  // Fetch initial data
  const [statusData, costsData] = await Promise.all([
    get('/status'),
    get('/costs').catch(() => ({ available: false, costs: null })),
  ]);

  const { tasks, quotas = {}, orchestrator = {}, agents = {} } = statusData;
  const agentCount = Object.keys(agents).length;
  const runningCount = Object.values(agents).filter(a => a.status === 'executing').length;

  // Total spend
  let totalSpend = 0;
  if (costsData.available && costsData.costs) {
    const c = costsData.costs;
    totalSpend = (c.totalCostUSD ?? 0);
  }

  viewEl.innerHTML = `
    <!-- Orchestrator control bar -->
    <div class="orch-bar">
      <div class="orch-indicator ${orchestrator.running ? 'running' : ''}" id="orch-dot"></div>
      <div class="orch-status">
        Orchestrator is <strong id="orch-state">${orchestrator.running ? 'running' : 'stopped'}</strong>
      </div>
      <button class="btn btn-sm ${orchestrator.running ? 'btn-danger' : 'btn-success'}" id="orch-btn">
        ${orchestrator.running ? 'Stop' : 'Start'}
      </button>
    </div>

    <!-- KPI cards -->
    <div class="kpi-grid">
      <div class="kpi-card" style="--accent:var(--primary)">
        <div class="kpi-label">Total Tasks</div>
        <div class="kpi-value" id="kpi-total">${fmt(tasks?.total ?? 0)}</div>
        <div class="kpi-sub" id="kpi-queued">${fmt(tasks?.queued ?? 0)} queued</div>
      </div>
      <div class="kpi-card" style="--accent:var(--info)">
        <div class="kpi-label">Executing</div>
        <div class="kpi-value" id="kpi-exec">${fmt(tasks?.executing ?? 0)}</div>
        <div class="kpi-sub">active tasks</div>
      </div>
      <div class="kpi-card" style="--accent:var(--success)">
        <div class="kpi-label">Completed</div>
        <div class="kpi-value" id="kpi-done">${fmt(tasks?.completed ?? 0)}</div>
        <div class="kpi-sub" id="kpi-failed">${fmt(tasks?.failed ?? 0)} failed</div>
      </div>
      <div class="kpi-card" style="--accent:var(--warning)">
        <div class="kpi-label">Agents</div>
        <div class="kpi-value" id="kpi-agents">${fmt(agentCount)}</div>
        <div class="kpi-sub" id="kpi-running">${fmt(runningCount)} running</div>
      </div>
      <div class="kpi-card" style="--accent:var(--success)">
        <div class="kpi-label">Daily Spend</div>
        <div class="kpi-value" id="kpi-spend" style="font-size:22px">${fmtUSD(totalSpend)}</div>
        <div class="kpi-sub">today</div>
      </div>
    </div>

    <!-- Quotas + Activity feed -->
    <div class="grid-2 mb-6">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Provider Quotas</div>
          <button class="btn btn-ghost btn-sm" id="refresh-quotas-btn">↻</button>
        </div>
        <div id="quota-list">${renderQuotaList(quotas)}</div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Live Activity</div>
          <span class="badge badge-executing" id="feed-count">0 events</span>
        </div>
        <div class="feed" id="activity-feed">
          ${renderFeedItems(eventLog.slice(0, 30))}
        </div>
      </div>
    </div>

    <!-- Recent tasks -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">Recent Tasks</div>
        <button class="btn btn-ghost btn-sm" onclick="navigate('kanban')">View all →</button>
      </div>
      <div id="recent-tasks-wrap" class="table-wrap">
        ${await renderRecentTasksTable()}
      </div>
    </div>
  `;

  // Orchestrator toggle
  const orchBtn = document.getElementById('orch-btn');
  let orchRunning = orchestrator.running;
  orchBtn.addEventListener('click', async () => {
    orchBtn.disabled = true;
    try {
      if (orchRunning) {
        await post('/control/stop');
        toast('Orchestrator stopped', 'info');
        orchRunning = false;
      } else {
        await post('/control/start');
        toast('Orchestrator started', 'success');
        orchRunning = true;
      }
      document.getElementById('orch-state').textContent = orchRunning ? 'running' : 'stopped';
      document.getElementById('orch-dot').className = `orch-indicator ${orchRunning ? 'running' : ''}`;
      orchBtn.className = `btn btn-sm ${orchRunning ? 'btn-danger' : 'btn-success'}`;
      orchBtn.textContent = orchRunning ? 'Stop' : 'Start';
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      orchBtn.disabled = false;
    }
  });

  // Refresh quotas
  document.getElementById('refresh-quotas-btn').addEventListener('click', async () => {
    const d = await get('/quotas').catch(() => ({ quotas: {} }));
    document.getElementById('quota-list').innerHTML = renderQuotaList(d.quotas);
  });

  // Live feed — push WS events
  const off = onWsMessage(entry => {
    const feed = document.getElementById('activity-feed');
    if (!feed) return;
    const item = document.createElement('div');
    item.className = 'feed-item';
    item.innerHTML = feedItemHTML(entry);
    feed.prepend(item);
    // Keep max 50 items
    while (feed.children.length > 50) feed.lastChild.remove();
    const cnt = document.getElementById('feed-count');
    if (cnt) cnt.textContent = `${feed.children.length} events`;
  });

  currentCleanup = off;
}

function renderQuotaList(quotas) {
  const entries = Object.entries(quotas);
  if (!entries.length) {
    return `<div class="text-muted text-sm" style="padding:8px 0">No quota data yet</div>`;
  }
  return entries.map(([id, q]) => {
    const pct = Math.round((q.tokensUsed ?? 0) / Math.max(q.tokensLimit ?? 1, 1) * 100);
    const fillClass = pct > 90 ? 'danger' : pct > 70 ? 'warn' : '';
    return `
      <div class="progress-row">
        <div class="progress-label" title="${id}">${id}</div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill ${fillClass}" style="width:${Math.min(pct,100)}%"></div>
        </div>
        <div class="progress-pct">${pct}%</div>
      </div>`;
  }).join('');
}

function feedItemHTML(entry) {
  return `
    <div class="feed-dot"></div>
    <div class="feed-time">${fmtTime(entry.receivedAt)}</div>
    <div class="feed-msg">${entry.event ?? entry.type ?? 'event'}</div>
    <div class="feed-event-type">${entry.event?.split('.')[0] ?? '—'}</div>`;
}

function renderFeedItems(items) {
  if (!items.length) return '<div class="text-muted text-sm" style="padding:8px 0">Waiting for events…</div>';
  return items.map(e => `<div class="feed-item">${feedItemHTML(e)}</div>`).join('');
}

async function renderRecentTasksTable() {
  const data = await get('/tasks').catch(() => ({ tasks: [] }));
  const tasks = (data.tasks ?? []).slice(0, 8);
  if (!tasks.length) return '<div class="empty-state" style="padding:24px"><div class="empty-icon">📋</div><span>No tasks yet</span></div>';

  return `<table>
    <thead><tr>
      <th>Title</th><th>Status</th><th>Agent</th><th>Priority</th><th>Created</th>
    </tr></thead>
    <tbody>
    ${tasks.map(t => `<tr>
      <td>${t.title ?? '—'}</td>
      <td>${badge(t.status)}</td>
      <td class="text-muted">${t.agent_id ?? '—'}</td>
      <td>${priorityDot(t.priority)}</td>
      <td class="text-muted">${timeAgo(t.created_at)}</td>
    </tr>`).join('')}
    </tbody>
  </table>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// View: Kanban (#36)
// ─────────────────────────────────────────────────────────────────────────────

const KANBAN_COLS = [
  { id: 'queued',     label: 'Queued' },
  { id: 'executing',  label: 'Executing' },
  { id: 'completed',  label: 'Completed' },
  { id: 'failed',     label: 'Failed' },
];

async function renderKanban() {
  const viewEl = document.getElementById('view');
  const topbarActions = document.getElementById('topbar-actions');

  // Add task button in topbar
  topbarActions.innerHTML = `<button class="btn btn-primary btn-sm" id="add-task-btn">+ New task</button>`;

  const data = await get('/tasks');
  const tasks = data.tasks ?? [];

  // Group by status
  const grouped = {};
  KANBAN_COLS.forEach(c => { grouped[c.id] = []; });
  tasks.forEach(t => {
    const col = grouped[t.status];
    if (col) col.push(t);
    else {
      if (!grouped._other) grouped._other = [];
      grouped._other.push(t);
    }
  });

  viewEl.innerHTML = `<div class="kanban-board">` +
    KANBAN_COLS.map(col => `
      <div class="kanban-col" data-col="${col.id}">
        <div class="kanban-col-header">
          <div class="kanban-col-title">${col.label}</div>
          <div class="kanban-col-count" id="col-count-${col.id}">${grouped[col.id].length}</div>
        </div>
        <div class="kanban-cards" id="col-${col.id}"
          ondragover="event.preventDefault();this.classList.add('drag-over')"
          ondragleave="this.classList.remove('drag-over')"
          ondrop="kanbanDrop(event,'${col.id}')">
          ${grouped[col.id].map(kanbanCardHTML).join('')}
        </div>
        ${col.id === 'queued' ? `<button class="kanban-add-btn" onclick="kanbanAddTask()">+ Add task</button>` : ''}
      </div>`).join('') +
  `</div>`;

  document.getElementById('add-task-btn')?.addEventListener('click', kanbanAddTask);

  // WS auto-refresh for kanban
  const off = onWsMessage(() => {
    // Debounced re-fetch
    clearTimeout(kanbanRefreshTimer);
    kanbanRefreshTimer = setTimeout(refreshKanban, 800);
  });
  currentCleanup = off;
}

let kanbanRefreshTimer = null;
let _draggingTaskId = null;
let _draggingEl = null;

function kanbanCardHTML(task) {
  return `
    <div class="kanban-card" draggable="true"
      data-id="${task.id}"
      ondragstart="kanbanDragStart(event,'${task.id}')"
      ondragend="kanbanDragEnd(event)">
      <div class="kanban-card-title">${task.title ?? 'Untitled'}</div>
      <div class="kanban-card-meta">
        <span class="kanban-card-agent">${task.agent_id ?? 'unassigned'}</span>
        ${priorityDot(task.priority)}
      </div>
    </div>`;
}

// Expose drag handlers globally (needed for inline ondragstart etc.)
window.kanbanDragStart = (e, id) => {
  _draggingTaskId = id;
  _draggingEl = e.currentTarget;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
};

window.kanbanDragEnd = (e) => {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  _draggingTaskId = null;
  _draggingEl = null;
};

window.kanbanDrop = async (e, toStatus) => {
  e.preventDefault();
  const col = e.currentTarget;
  col.classList.remove('drag-over');
  if (!_draggingTaskId) return;

  // Optimistic UI: move card immediately
  const card = document.querySelector(`.kanban-card[data-id="${_draggingTaskId}"]`);
  const fromCol = card?.closest('.kanban-cards');
  if (card) col.appendChild(card);
  updateColCount(fromCol);
  updateColCount(col);

  try {
    await post(`/tasks/${_draggingTaskId}/status`, { status: toStatus });
  } catch (err) {
    // Revert on failure
    if (card && fromCol) fromCol.appendChild(card);
    updateColCount(fromCol);
    updateColCount(col);
    toast(`Failed to move task: ${err.message}`, 'error');
  }
};

function updateColCount(colEl) {
  if (!colEl) return;
  const count = colEl.querySelectorAll('.kanban-card').length;
  const header = colEl.closest('.kanban-col')?.querySelector('.kanban-col-count');
  if (header) header.textContent = count;
}

async function refreshKanban() {
  if (currentView !== 'kanban') return;
  const data = await get('/tasks').catch(() => ({ tasks: [] }));
  const tasks = data.tasks ?? [];
  const grouped = {};
  KANBAN_COLS.forEach(c => { grouped[c.id] = []; });
  tasks.forEach(t => { if (grouped[t.status]) grouped[t.status].push(t); });

  KANBAN_COLS.forEach(col => {
    const el = document.getElementById(`col-${col.id}`);
    if (!el) return;
    el.innerHTML = grouped[col.id].map(kanbanCardHTML).join('');
    const cnt = document.getElementById(`col-count-${col.id}`);
    if (cnt) cnt.textContent = grouped[col.id].length;
  });
}

window.kanbanAddTask = () => {
  const backdrop = openModal(`
    <div class="modal-title">New Task</div>
    <div class="form-group">
      <label>Title *</label>
      <input id="m-title" type="text" placeholder="Describe the task…" />
    </div>
    <div class="form-row">
      <div class="form-group">
        <label>Type</label>
        <select id="m-type">
          <option value="feature">feature</option>
          <option value="bug">bug</option>
          <option value="research">research</option>
          <option value="refactor">refactor</option>
          <option value="test">test</option>
        </select>
      </div>
      <div class="form-group">
        <label>Priority</label>
        <select id="m-priority">
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="low">low</option>
        </select>
      </div>
    </div>
    <div class="form-group">
      <label>Agent ID</label>
      <input id="m-agent" type="text" placeholder="e.g. architect" />
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
      <button class="btn btn-primary" id="m-save-btn">Create task</button>
    </div>
  `);

  backdrop.querySelector('#m-title').focus();
  backdrop.querySelector('#m-save-btn').addEventListener('click', async () => {
    const title = backdrop.querySelector('#m-title').value.trim();
    if (!title) { toast('Title is required', 'error'); return; }
    const type     = backdrop.querySelector('#m-type').value;
    const priority = backdrop.querySelector('#m-priority').value;
    const agent_id = backdrop.querySelector('#m-agent').value.trim() || undefined;

    try {
      await post('/tasks', { title, type, priority, agent_id });
      toast('Task created', 'success');
      backdrop.remove();
      refreshKanban();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// View: Agents (#37)
// ─────────────────────────────────────────────────────────────────────────────

async function renderAgents() {
  const viewEl = document.getElementById('view');
  const data = await get('/agents');
  const agents = data.agents ?? [];

  if (!agents.length) {
    viewEl.innerHTML = `<div class="empty-state"><div class="empty-icon">◉</div><span>No agents registered yet.<br>Start the orchestrator or add agents to agentforge.yml</span></div>`;
    return;
  }

  viewEl.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
      ${agents.map(agentCardHTML).join('')}
    </div>`;

  // WS refresh
  const off = onWsMessage(entry => {
    if (entry.event?.startsWith('agent.')) {
      clearTimeout(agentRefreshTimer);
      agentRefreshTimer = setTimeout(refreshAgents, 1000);
    }
  });
  currentCleanup = off;
}

let agentRefreshTimer = null;

async function refreshAgents() {
  if (currentView !== 'agents') return;
  const data = await get('/agents').catch(() => ({ agents: [] }));
  const agents = data.agents ?? [];
  const viewEl = document.getElementById('view');
  if (agents.length) {
    viewEl.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
        ${agents.map(agentCardHTML).join('')}
      </div>`;
  }
}

function agentCardHTML(agent) {
  return `
    <div class="agent-card">
      <div class="agent-card-header">
        <div>
          <div class="agent-name">${agent.agentId ?? agent.id ?? 'unknown'}</div>
          <div class="agent-model">${agent.model ?? '—'}</div>
        </div>
        ${badge(agent.status ?? 'idle')}
      </div>
      <div class="agent-stats">
        <div class="agent-stat">
          <div class="agent-stat-label">Tasks done</div>
          <div class="agent-stat-value">${fmt(agent.tasksCompleted ?? 0)}</div>
        </div>
        <div class="agent-stat">
          <div class="agent-stat-label">Tokens in</div>
          <div class="agent-stat-value">${fmt(agent.tokensIn ?? 0)}</div>
        </div>
        <div class="agent-stat">
          <div class="agent-stat-label">Tokens out</div>
          <div class="agent-stat-value">${fmt(agent.tokensOut ?? 0)}</div>
        </div>
      </div>
      ${agent.currentTask ? `<div class="text-sm text-muted">Current: ${agent.currentTask}</div>` : ''}
      ${agent.systemPrompt ? `<div class="code-block">${escHtml(agent.systemPrompt.slice(0, 200))}${agent.systemPrompt.length > 200 ? '…' : ''}</div>` : ''}
      <div style="display:flex;gap:8px;margin-top:4px">
        <button class="btn btn-ghost btn-sm" onclick="agentEditModal(${JSON.stringify(JSON.stringify(agent))})">Edit</button>
      </div>
    </div>`;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

window.agentEditModal = (agentJson) => {
  const agent = JSON.parse(agentJson);
  const backdrop = openModal(`
    <div class="modal-title">Edit Agent — ${agent.agentId ?? agent.id}</div>
    <div class="form-group">
      <label>Model</label>
      <input id="ea-model" type="text" value="${agent.model ?? ''}" placeholder="e.g. claude-opus-4-6" />
    </div>
    <div class="form-group">
      <label>System Prompt</label>
      <textarea id="ea-prompt" rows="8">${escHtml(agent.systemPrompt ?? '')}</textarea>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="this.closest('.modal-backdrop').remove()">Cancel</button>
      <button class="btn btn-primary" id="ea-save-btn">Save</button>
    </div>
  `);

  backdrop.querySelector('#ea-save-btn').addEventListener('click', async () => {
    const model  = backdrop.querySelector('#ea-model').value.trim();
    const prompt = backdrop.querySelector('#ea-prompt').value;
    try {
      await post(`/agents/${agent.agentId ?? agent.id}`, { model, systemPrompt: prompt });
      toast('Agent updated', 'success');
      backdrop.remove();
      refreshAgents();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// View: Providers (#38)
// ─────────────────────────────────────────────────────────────────────────────

async function renderProviders() {
  const viewEl = document.getElementById('view');
  const data = await get('/quotas');
  const quotas = data.quotas ?? {};

  const entries = Object.entries(quotas);
  if (!entries.length) {
    viewEl.innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><span>No provider quota data yet.<br>Providers will appear once a task has been executed.</span></div>`;
    return;
  }

  viewEl.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px">
      ${entries.map(([id, q]) => providerCardHTML(id, q)).join('')}
    </div>`;
}

function providerCardHTML(id, q) {
  const used  = q.tokensUsed  ?? 0;
  const limit = q.tokensLimit ?? 0;
  const pct   = limit ? Math.round(used / limit * 100) : 0;
  const fillCls = pct > 90 ? 'danger' : pct > 70 ? 'warn' : '';

  const reqUsed  = q.requestsUsed  ?? 0;
  const reqLimit = q.requestsLimit ?? 0;
  const reqPct   = reqLimit ? Math.round(reqUsed / reqLimit * 100) : 0;
  const reqCls   = reqPct > 90 ? 'danger' : reqPct > 70 ? 'warn' : '';

  const state = q.state ?? 'ok';

  return `
    <div class="provider-card">
      <div class="provider-header">
        <div class="provider-name">${id}</div>
        <div style="display:flex;gap:8px;align-items:center">
          ${badge(state)}
          <button class="btn btn-ghost btn-sm" onclick="testProvider('${id}',this)">Test</button>
        </div>
      </div>
      <div class="test-result" id="test-${id}"></div>
      <div class="provider-quota-section">
        ${limit ? `
          <div class="progress-row">
            <div class="progress-label">Tokens</div>
            <div class="progress-bar-wrap">
              <div class="progress-bar-fill ${fillCls}" style="width:${Math.min(pct,100)}%"></div>
            </div>
            <div class="progress-pct">${pct}%</div>
          </div>` : ''}
        ${reqLimit ? `
          <div class="progress-row">
            <div class="progress-label">Requests</div>
            <div class="progress-bar-wrap">
              <div class="progress-bar-fill ${reqCls}" style="width:${Math.min(reqPct,100)}%"></div>
            </div>
            <div class="progress-pct">${reqPct}%</div>
          </div>` : ''}
        ${!limit && !reqLimit ? '<div class="text-muted text-sm">No quota limits configured</div>' : ''}
      </div>
      <div style="margin-top:10px;font-size:11px;color:var(--text2)">
        Window resets: ${q.windowResetAt ? new Date(q.windowResetAt).toLocaleTimeString() : '—'}
        &nbsp;·&nbsp;
        Requests used: ${fmt(reqUsed)}${reqLimit ? ' / ' + fmt(reqLimit) : ''}
      </div>
    </div>`;
}

window.testProvider = async (id, btn) => {
  btn.disabled = true;
  btn.textContent = '…';
  const resultEl = document.getElementById(`test-${id}`);
  try {
    await post('/providers/test', { provider: id });
    resultEl.className = 'test-result ok';
    resultEl.textContent = '✓ Connection successful';
  } catch (err) {
    resultEl.className = 'test-result fail';
    resultEl.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test';
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// View: Costs (#39)
// ─────────────────────────────────────────────────────────────────────────────

async function renderCosts() {
  const viewEl = document.getElementById('view');
  const data = await get('/costs');

  if (!data.available || !data.costs) {
    viewEl.innerHTML = `<div class="empty-state"><div class="empty-icon">◈</div><span>Cost tracking is not active.<br>Configure budget limits in agentforge.yml to enable it.</span></div>`;
    return;
  }

  const c = data.costs;
  const totalSpend   = c.totalCostUSD   ?? 0;
  const totalTokensIn  = c.totalTokensIn  ?? 0;
  const totalTokensOut = c.totalTokensOut ?? 0;
  const transactions   = c.transactions  ?? [];
  const byAgent        = c.byAgent       ?? {};
  const byModel        = c.byModel       ?? {};
  const budgets        = c.budgets       ?? {};

  viewEl.innerHTML = `
    <!-- KPI row -->
    <div class="kpi-grid mb-6">
      <div class="kpi-card" style="--accent:var(--success)">
        <div class="kpi-label">Total Spend</div>
        <div class="kpi-value" style="font-size:22px">${fmtUSD(totalSpend)}</div>
      </div>
      <div class="kpi-card" style="--accent:var(--info)">
        <div class="kpi-label">Tokens In</div>
        <div class="kpi-value" style="font-size:22px">${fmt(totalTokensIn)}</div>
      </div>
      <div class="kpi-card" style="--accent:var(--primary)">
        <div class="kpi-label">Tokens Out</div>
        <div class="kpi-value" style="font-size:22px">${fmt(totalTokensOut)}</div>
      </div>
    </div>

    <div class="grid-2 mb-6">
      <!-- Budget bars -->
      <div class="card">
        <div class="card-header"><div class="card-title">Project Budgets</div></div>
        <div id="budget-list">${renderBudgets(budgets)}</div>
      </div>

      <!-- By agent -->
      <div class="card">
        <div class="card-header"><div class="card-title">Spend by Agent</div></div>
        ${renderCostTable(byAgent, 'Agent')}
      </div>
    </div>

    <!-- By model -->
    <div class="card mb-6">
      <div class="card-header"><div class="card-title">Spend by Model</div></div>
      ${renderCostTable(byModel, 'Model')}
    </div>

    <!-- Transaction log -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">Transaction Log</div>
        <span class="text-muted text-sm">${transactions.length} records</span>
      </div>
      <div style="max-height:340px;overflow-y:auto">
        ${renderTransactions(transactions)}
      </div>
    </div>`;
}

function renderBudgets(budgets) {
  const entries = Object.entries(budgets);
  if (!entries.length) return '<div class="text-muted text-sm">No budgets configured</div>';
  return entries.map(([name, b]) => {
    const spend = b.spentUSD ?? 0;
    const limit = b.limitUSD ?? 0;
    const pct   = limit ? Math.round(spend / limit * 100) : 0;
    const cls   = pct > 90 ? 'danger' : pct > 70 ? 'warn' : '';
    return `
      <div class="budget-item">
        <div class="budget-header">
          <div class="budget-name">${name}</div>
          <div class="budget-amounts">${fmtUSD(spend)} / ${fmtUSD(limit)}</div>
        </div>
        <div class="budget-bar-wrap">
          <div class="budget-bar-fill ${cls}" style="width:${Math.min(pct,100)}%"></div>
        </div>
      </div>`;
  }).join('');
}

function renderCostTable(byKey, label) {
  const entries = Object.entries(byKey);
  if (!entries.length) return '<div class="text-muted text-sm" style="padding:8px 0">No data</div>';
  return `<table>
    <thead><tr><th>${label}</th><th>Tokens In</th><th>Tokens Out</th><th>Cost</th></tr></thead>
    <tbody>
    ${entries.map(([k, v]) => `<tr>
      <td class="font-mono">${k}</td>
      <td>${fmt(v.tokensIn)}</td>
      <td>${fmt(v.tokensOut)}</td>
      <td style="color:var(--success)">${fmtUSD(v.costUSD)}</td>
    </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderTransactions(txs) {
  if (!txs.length) return '<div class="empty-state" style="padding:24px"><div class="empty-icon">📄</div><span>No transactions recorded yet</span></div>';
  return txs.slice(0, 100).map(tx => `
    <div class="tx-row">
      <div class="tx-agent">${tx.agentId ?? '—'}</div>
      <div class="tx-model">${tx.model ?? '—'}</div>
      <div class="tx-tokens">↑${fmt(tx.tokensIn)} ↓${fmt(tx.tokensOut)}</div>
      <div class="tx-cost">${fmtUSD(tx.costUSD)}</div>
      <div class="tx-time">${fmtTime(tx.timestamp)}</div>
    </div>`).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Additional API endpoints wired from UI (need to exist or return 404 gracefully)
// POST /api/tasks/:id/status   — move kanban card
// POST /api/agents/:id         — update agent config
// POST /api/providers/test     — test provider connection
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────────────

wsConnect();
navigate('dashboard');
