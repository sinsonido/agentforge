import { CircleCheck, CircleDashed, CircleX, ExternalLink } from 'lucide-react'

/** A task's CI babysitting state (see src/execution/babysit.js). */
export interface Babysit {
  branch: string
  max_rounds: number
  rounds: Array<{
    n: number
    head: string
    ci: 'pending' | 'pass' | 'fail'
    failing: Array<{ name: string; url: string | null }>
    started_at: number
    finished_at: number | null
  }>
  verdict: 'green' | 'red' | 'merged' | 'closed' | 'timeout' | 'stopped' | null
}

/** The task's babysit state when it has one, else null. */
export const babysitOf = (task: object): Babysit | null => (task as { babysit?: Babysit | null }).babysit ?? null

const VERDICT: Record<NonNullable<Babysit['verdict']>, string> = {
  green: 'CI green',
  red: 'CI red, fixing stopped',
  merged: 'Merged outside AgentForge',
  closed: 'PR closed',
  timeout: 'CI timed out',
  stopped: 'Stopped before CI finished',
}

const ICON = {
  pending: <CircleDashed className="h-4 w-4 shrink-0 animate-pulse text-muted-foreground" aria-label="CI running" />,
  pass: <CircleCheck className="h-4 w-4 shrink-0 text-green-600" aria-label="CI passed" />,
  fail: <CircleX className="h-4 w-4 shrink-0 text-red-600" aria-label="CI failed" />,
}

/** CI per pushed head: the published head, then one row per fix round. */
export function CiRounds({ babysit, fixing }: { babysit: Babysit; fixing: boolean }) {
  const fixes = babysit.rounds.length - 1
  return (
    <section data-testid="ci-rounds" className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">CI</h3>
        <span data-testid="ci-verdict" className="text-xs text-muted-foreground">
          {fixing
            ? `Fix round ${fixes + 1} of ${babysit.max_rounds} running`
            : `${babysit.verdict ? VERDICT[babysit.verdict] : 'Watching'} · ${fixes} of ${babysit.max_rounds} fix rounds`}
        </span>
      </div>
      <ol className="space-y-2">
        {babysit.rounds.map((r) => (
          <li key={r.n} data-testid="ci-round" className="flex items-start gap-2 text-sm">
            {ICON[r.ci]}
            <div className="min-w-0 space-y-1">
              <p className="break-words">
                {r.n === 0 ? 'Published' : `Fix round ${r.n}`}{' '}
                <code className="text-xs">{r.head.slice(0, 7)}</code>
              </p>
              {r.failing.length > 0 && (
                <ul className="space-y-1">
                  {r.failing.map((c) => (
                    <li key={c.name} className="text-xs text-red-700 break-words">
                      {c.url ? (
                        <a href={c.url} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center gap-1 hover:underline">
                          {c.name} <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : c.name}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}
