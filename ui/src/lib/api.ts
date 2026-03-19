const BASE = '/api'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error((err as { error?: string }).error ?? res.statusText)
  }
  return res.json() as Promise<T>
}

export const api = {
  status: () => request<{ ok: boolean; orchestrator: { running: boolean }; tasks: Record<string, number>; quotas: Record<string, import('../types/api').QuotaStatus>; agents: Record<string, unknown> }>('/status'),
  tasks: (status?: string) => request<{ ok: boolean; tasks: import('../types/api').Task[] }>(`/tasks${status ? `?status=${status}` : ''}`),
  createTask: (body: { title: string; type?: string; priority?: string; agent_id?: string }) =>
    request<{ ok: boolean; task: import('../types/api').Task }>('/tasks', { method: 'POST', body: JSON.stringify(body) }),
  updateTaskStatus: (id: string, status: string) =>
    request<{ ok: boolean }>(`/tasks/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
  agents: () => request<{ ok: boolean; agents: import('../types/api').AgentStatus[] }>('/agents'),
  updateAgent: (id: string, patch: { model?: string; systemPrompt?: string }) =>
    request<{ ok: boolean }>(`/agents/${id}`, { method: 'POST', body: JSON.stringify(patch) }),
  quotas: () => request<{ ok: boolean; quotas: Record<string, import('../types/api').QuotaStatus> }>('/quotas'),
  costs: () => request<{ ok: boolean; available: boolean; costs: import('../types/api').CostData | null }>('/costs'),
  events: (limit?: number) => request<{ ok: boolean; events: import('../types/api').ApiEvent[] }>(`/events${limit ? `?limit=${limit}` : ''}`),
  controlStart: () => request<{ ok: boolean }>('/control/start', { method: 'POST' }),
  controlStop: () => request<{ ok: boolean }>('/control/stop', { method: 'POST' }),
  testProvider: (provider: string) =>
    request<{ ok: boolean; error?: string }>('/providers/test', { method: 'POST', body: JSON.stringify({ provider }) }),
}
