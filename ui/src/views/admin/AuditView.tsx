import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { AuditEntry } from '@/types/api'

const PAGE_SIZE = 50

function formatDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString()
}

export default function AuditView() {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [filterUser, setFilterUser] = useState('')
  const [filterAction, setFilterAction] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.getAuditLog({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        user: filterUser || undefined,
        action: filterAction || undefined,
      })
      setEntries(res.entries)
      setCount(res.count)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log')
    } finally {
      setLoading(false)
    }
  }, [page, filterUser, filterAction])

  useEffect(() => {
    void load()
  }, [load])

  // Reset page when filters change
  useEffect(() => {
    setPage(0)
  }, [filterUser, filterAction])

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">Audit Log</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          placeholder="Filter by username"
          value={filterUser}
          onChange={e => setFilterUser(e.target.value)}
          className="rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring w-48"
        />
        <input
          type="text"
          placeholder="Filter by action"
          value={filterAction}
          onChange={e => setFilterAction(e.target.value)}
          className="rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring w-48"
        />
      </div>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}

      {/* Table */}
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Timestamp</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Username</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Action</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">Resource</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground">IP</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                  No audit entries found.
                </td>
              </tr>
            ) : (
              entries.map(entry => (
                <tr key={entry.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                    {formatDate(entry.created_at)}
                  </td>
                  <td className="px-4 py-2 font-medium">{entry.username}</td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center rounded px-1.5 py-0.5 font-mono text-xs bg-muted text-muted-foreground">
                      {entry.action}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{entry.resource ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{entry.ip ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <button
          onClick={() => setPage(p => Math.max(0, p - 1))}
          disabled={page === 0}
          className="rounded border px-3 py-1 hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <span>Page {page + 1} · {count} result{count !== 1 ? 's' : ''}</span>
        <button
          onClick={() => setPage(p => p + 1)}
          disabled={count < PAGE_SIZE}
          className="rounded border px-3 py-1 hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  )
}
