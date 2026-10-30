import type { RepoSpend as RepoSpendData, SpendPhase } from '@/types/api'

const WINDOW: Record<RepoSpendData['window'], string> = { day: 'last 24 h', week: 'last 7 days', month: 'last 30 days' }

function Cell({ spent, limit }: { spent: number; limit: number | null }) {
  const over = limit != null && spent >= limit
  return (
    <span className={over ? 'font-medium text-red-600' : undefined}>
      ${spent.toFixed(2)}{limit != null && <span className="text-muted-foreground"> / ${limit.toFixed(2)}</span>}
    </span>
  )
}

/** Build and verification spend per repository in its rolling budget window. */
export function RepoSpend({ repos, byPhase }: { repos: Record<string, RepoSpendData>; byPhase: Record<SpendPhase, number> }) {
  const entries = Object.entries(repos)
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        All time: build ${byPhase.build.toFixed(2)} · verify ${byPhase.verify.toFixed(2)}
      </p>
      {entries.length === 0 && <p className="text-sm text-muted-foreground">No repository has spent anything yet.</p>}
      <ul className="space-y-2">
        {entries.map(([repo, r]) => (
          <li key={repo} data-testid="repo-spend" className="space-y-1 border-b pb-2 text-sm last:border-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="font-medium break-all">{repo}</span>
              <span className="text-xs text-muted-foreground">{WINDOW[r.window]}</span>
            </div>
            <div className="flex flex-wrap gap-x-4 text-xs tabular-nums">
              <span>Build <Cell {...r.build} /></span>
              <span>Verify <Cell {...r.verify} /></span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
