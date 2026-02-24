import { Skeleton } from '@/components/ui/skeleton'
import { ProviderCard } from '@/components/providers/ProviderCard'
import { useApi } from '@/hooks/useApi'
import { api } from '@/lib/api'

export default function ProvidersView() {
  const { data, loading } = useApi(() => api.quotas(), [])
  const entries = Object.entries(data?.quotas ?? {})

  if (loading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-52 w-full" />
        ))}
      </div>
    )
  }

  if (!entries.length) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed">
        <p className="text-sm text-muted-foreground">No providers with quota configured.</p>
      </div>
    )
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map(([id, quota]) => (
        <ProviderCard key={id} id={id} quota={quota} />
      ))}
    </div>
  )
}
