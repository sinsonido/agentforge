import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { WebSocketProvider } from '@/contexts/WebSocketContext'
import { Layout } from '@/components/layout/Layout'
import DashboardView from '@/views/DashboardView'
import KanbanView from '@/views/KanbanView'
import AgentsView from '@/views/AgentsView'
import ProvidersView from '@/views/ProvidersView'
import CostsView from '@/views/CostsView'
import UsersView from '@/views/admin/UsersView'

export default function App() {
  return (
    <BrowserRouter>
      <WebSocketProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<DashboardView />} />
            <Route path="/kanban" element={<KanbanView />} />
            <Route path="/agents" element={<AgentsView />} />
            <Route path="/providers" element={<ProvidersView />} />
            <Route path="/costs" element={<CostsView />} />
            <Route path="/admin/users" element={<UsersView />} />
          </Route>
        </Routes>
      </WebSocketProvider>
    </BrowserRouter>
  )
}
