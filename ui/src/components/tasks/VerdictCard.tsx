import { CircleCheck, CircleDashed, CircleX } from 'lucide-react'

/** A task's verification verdicts by SHA (see src/execution/verify.js). */
export interface Verification {
  head: string | null
  verdicts: Array<{
    sha: string
    lanes: Array<{ name: string; pass: boolean; evidence: string }>
    pass: boolean
    error: string | null
    cost_usd: number
    at: number
  }>
}

/** The task's verification state when it has one, else null. */
export const verificationOf = (task: object): Verification | null =>
  (task as { verification?: Verification | null }).verification ?? null

const short = (sha: string | null) => (sha ?? '').slice(0, 7)

const PASS = <CircleCheck className="h-4 w-4 shrink-0 text-green-600" aria-label="passed" />
const FAIL = <CircleX className="h-4 w-4 shrink-0 text-red-600" aria-label="failed" />

/**
 * The verdict at the PR's current head, lane by lane. The merge is offered only
 * when it passed. Verdicts at older heads are listed as stale.
 */
export function VerdictCard({ verification, verifying }: { verification: Verification; verifying: boolean }) {
  const current = verification.verdicts.find((v) => v.sha === verification.head) ?? null
  const stale = verification.verdicts.filter((v) => v.sha !== verification.head)
  const status = verifying
    ? `Verifying ${short(verification.head)}`
    : current
      ? `${current.pass ? 'Verified' : 'Failed'} at ${short(current.sha)} · $${current.cost_usd.toFixed(2)}`
      : `No verdict at ${short(verification.head)}`

  return (
    <section data-testid="verdict-card" className="space-y-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">Verification</h3>
        <span data-testid="verdict-status" className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          {verifying && <CircleDashed className="h-3 w-3 animate-pulse" aria-hidden />}
          {status}
        </span>
      </div>
      {current && !verifying && (
        <ol className="space-y-2">
          {current.error && (
            <li data-testid="verdict-error" className="flex items-start gap-2 text-sm">
              {FAIL}
              <p className="min-w-0 break-words">Run void: {current.error}</p>
            </li>
          )}
          {current.lanes.map((l) => (
            <li key={l.name} data-testid="verdict-lane" className="flex items-start gap-2 text-sm">
              {l.pass ? PASS : FAIL}
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">{l.name}</p>
                <p className="text-xs text-muted-foreground break-words">{l.evidence}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
      {stale.length > 0 && (
        <p data-testid="verdict-stale" className="text-xs text-muted-foreground break-words">
          Stale: {stale.map((v) => `${short(v.sha)} ${v.pass ? 'passed' : 'failed'}`).join(', ')}. A new head needs its own verdict.
        </p>
      )}
    </section>
  )
}
