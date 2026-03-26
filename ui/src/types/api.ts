export interface Task {
  id: string
  title: string
  type: string
  status: 'queued' | 'executing' | 'completed' | 'failed' | 'waiting_quota' | 'paused_budget'
  priority?: 'critical' | 'high' | 'medium' | 'low'
  agent_id?: string
  project_id?: string
  model_used?: string
  tokens_in?: number
  tokens_out?: number
  cost?: number
  result?: string
  created_at?: number
  assigned_at?: number
  completed_at?: number
}

export interface AgentStatus {
  id: string
  name: string
  state: 'idle' | 'assigned' | 'executing' | 'reviewing' | 'completed' | 'failed' | 'paused'
  currentTaskId?: string
  historyLength: number
}

export interface QuotaStatus {
  state: 'available' | 'throttled' | 'exhausted'
  tokens: { used: number; max: number; pct: number }
  requests: { used: number; max: number }
}

export interface CostData {
  totalCostUSD: number
  byAgent: Record<string, number>
  byModel: Record<string, number>
  transactions: CostTransaction[]
  budgets: Record<string, { budget: number; spent: number }>
}

export interface CostTransaction {
  projectId?: string
  agentId?: string
  model?: string
  tokensIn?: number
  tokensOut?: number
  cost?: number
}

export interface Invitation {
  id: string
  email: string
  role: string
  teamId: string | null
  invitedBy: string
  createdAt: number
  expiresAt: number
  usedAt: number | null
  status: 'pending' | 'accepted' | 'expired' | 'revoked'
}

export interface ApiEvent {
  id: number
  event: string
  data: unknown
  timestamp: number
}

export interface SystemStatus {
  ok: boolean
  orchestrator: { running: boolean }
  tasks: {
    total: number
    queued: number
    executing: number
    completed: number
    failed: number
  }
  quotas: Record<string, QuotaStatus>
  agents: Record<string, AgentStatus>
}
