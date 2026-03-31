import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'
import { WebSocketProvider } from '@/contexts/WebSocketContext'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { Layout } from '@/components/layout/Layout'
import DashboardView from '@/views/DashboardView'
import KanbanView from '@/views/KanbanView'
import AgentsView from '@/views/AgentsView'
import ProvidersView from '@/views/ProvidersView'
import CostsView from '@/views/CostsView'
import LoginView from '@/views/LoginView'
import SetupView from '@/views/SetupView'
import ProfileView from '@/views/ProfileView'

function ProtectedRoute() {
  const { isAuthenticated } = useAuth()
  const location = useLocation()
  if (!isAuthenticated) {
    const redirect = encodeURIComponent(location.pathname + location.search)
    return <Navigate to={`/login?redirect=${redirect}`} replace />
  }
  return <Outlet />
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginView />} />
          <Route path="/setup" element={<SetupView />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<WebSocketProvider><Layout /></WebSocketProvider>}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardView />} />
              <Route path="/kanban" element={<KanbanView />} />
              <Route path="/agents" element={<AgentsView />} />
              <Route path="/providers" element={<ProvidersView />} />
              <Route path="/costs" element={<CostsView />} />
              <Route path="/profile" element={<ProfileView />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
