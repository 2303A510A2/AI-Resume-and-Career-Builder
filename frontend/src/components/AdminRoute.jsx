import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import Loading from './Loading.jsx';

export default function AdminRoute({ children }) {
  const { admin, loading } = useAuth();

  if (loading) return <Loading label="Checking admin session..." full />;
  if (!admin) return <Navigate to="/admin/login" replace />;
  return children;
}