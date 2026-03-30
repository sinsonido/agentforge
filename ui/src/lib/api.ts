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
  status: () => request<import('../types/api').SystemStatus>('/status'),
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

  // ── Teams ──────────────────────────────────────────────────────────────
  listTeams: () =>
    request<{ ok: boolean; teams: import('../types/api').Team[] }>('/teams'),
  createTeam: (body: { name: string; description?: string }) =>
    request<{ ok: boolean; team: import('../types/api').Team }>('/teams', { method: 'POST', body: JSON.stringify(body) }),
  getTeam: (id: string) =>
    request<{ ok: boolean; team: import('../types/api').Team }>(`/teams/${id}`),
  updateTeam: (id: string, body: { name?: string; description?: string }) =>
    request<{ ok: boolean; team: import('../types/api').Team }>(`/teams/${id}`, { method: 'PUT', body: JSON.stringify(body) }),
  deleteTeam: (id: string) =>
    request<{ ok: boolean }>(`/teams/${id}`, { method: 'DELETE' }),
  addTeamMember: (teamId: string, userId: string, role?: 'owner' | 'member') =>
    request<{ ok: boolean }>(`/teams/${teamId}/members`, { method: 'POST', body: JSON.stringify({ userId, role }) }),
  removeTeamMember: (teamId: string, userId: string) =>
    request<{ ok: boolean }>(`/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),
  setTeamMemberRole: (teamId: string, userId: string, role: 'owner' | 'member') =>
    request<{ ok: boolean }>(`/teams/${teamId}/members/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  addTeamProject: (teamId: string, projectId: string) =>
    request<{ ok: boolean }>(`/teams/${teamId}/projects`, { method: 'POST', body: JSON.stringify({ projectId }) }),
  removeTeamProject: (teamId: string, projectId: string) =>
    request<{ ok: boolean }>(`/teams/${teamId}/projects/${projectId}`, { method: 'DELETE' }),
}
