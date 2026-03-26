import * as React from "react"
import { cn } from "@/lib/utils"

interface SelectContextValue {
  value: string
  onValueChange: (value: string) => void
}

const SelectContext = React.createContext<SelectContextValue>({ value: '', onValueChange: () => {} })

function Select({ value, onValueChange, children }: { value: string; onValueChange: (value: string) => void; children: React.ReactNode }) {
  return (
    <SelectContext.Provider value={{ value, onValueChange }}>
      {children}
    </SelectContext.Provider>
  )
}

function SelectTrigger(_props: { id?: string; className?: string; children?: React.ReactNode }) {
  // Trigger UI is provided by SelectContent's native select; this is a no-op wrapper
  return null
}

function SelectValue(_props: { placeholder?: string }) {
  return null
}

function SelectContent({ className, children }: { className?: string; children: React.ReactNode }) {
  const { value, onValueChange } = React.useContext(SelectContext)
  return (
    <select
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {children}
    </select>
  )
}

function SelectItem({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  return <option value={value} className={className}>{children}</option>
}

export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
