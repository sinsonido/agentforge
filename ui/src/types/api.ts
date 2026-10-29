export type Playbook = 'bug-fix' | 'feature' | 'refactoring' | 'investigation' | 'perf-issue'

interface TaskBase {
  id: string
  title: string
  type: string
  status: 'queued' | 'assigned' | 'executing' | 'completed' | 'failed' | 'waiting_quota' | 'paused_budget' | 'pr-opened' | 'cancelled'
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

export interface TextTask extends TaskBase {
  kind: 'text'
}

export interface CodingTask extends TaskBase {
  kind: 'coding'
  repo: string
  base: string
  instruction: string
  issue: number | null
  playbook: Playbook
  step: string | null
  budget: number | null
  pr_url: string | null
}

export type Task = TextTask | CodingTask

/** One event the coding executor parsed from the harness stream (see createStreamParser). */
export type AgentEvent =
  | { type: 'init'; sessionId: string; model: string; cwd: string; version: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string | null; isError: boolean; output: string }
  | { type: 'harness_task'; op: 'create' | 'update'; taskId: string; subject?: string; status?: string }
  | { type: 'rate_limit'; status: string }
  | { type: 'result'; subtype: string; isError: boolean; costUsd: number | null; numTurns: number; durationMs: number; text: string }

/** A stored transcript entry: `seq` counts up from 1 per task. */
export interface TaskEvent {
  seq: number
  at: number
  event: AgentEvent
}

export interface AgentStatus {
  id: string
  name: string
  role: string
  model: string | null
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
