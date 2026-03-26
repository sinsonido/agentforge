import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { WebSocketProvider } from '@/contexts/WebSocketContext'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { Layout } from '@/components/layout/Layout'
import DashboardView from '@/views/DashboardView'
import KanbanView from '@/views/KanbanView'
import AgentsView from '@/views/AgentsView'
import ProvidersView from '@/views/ProvidersView'
import CostsView from '@/views/CostsView'
import LoginView from '@/views/LoginView'

function ProtectedRoute() {
  const { isAuthenticated } = useAuth()
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <Outlet />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <WebSocketProvider>
          <Routes>
            <Route path="/login" element={<LoginView />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<Layout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardView />} />
                <Route path="/kanban" element={<KanbanView />} />
                <Route path="/agents" element={<AgentsView />} />
                <Route path="/providers" element={<ProvidersView />} />
                <Route path="/costs" element={<CostsView />} />
              </Route>
            </Route>
          </Routes>
        </WebSocketProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
