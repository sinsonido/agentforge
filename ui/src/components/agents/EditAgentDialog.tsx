import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Settings } from 'lucide-react'
import { api } from '@/lib/api'
import type { AgentStatus } from '@/types/api'

interface EditAgentDialogProps {
  agent: AgentStatus
  onUpdated: () => void
}

export function EditAgentDialog({ agent, onUpdated }: EditAgentDialogProps) {
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await api.updateAgent(agent.id, {
        model: model || undefined,
        systemPrompt: systemPrompt || undefined,
      })
      setOpen(false)
      onUpdated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update agent')
    }
    setLoading(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-7 w-7">
          <Settings className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Agent: {agent.id}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div>
            <label className="text-sm font-medium">Model override</label>
            <input
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={model}
              onChange={e => setModel(e.target.value)}
              placeholder="Leave blank to keep current"
            />
          </div>
          <div>
            <label className="text-sm font-medium">System prompt override</label>
            <textarea
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder="Leave blank to keep current"
              rows={4}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? 'Saving…' : 'Save'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
