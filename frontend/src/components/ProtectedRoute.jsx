import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import Loading from './Loading.jsx';

export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <Loading label="Loading your workspace..." full />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return children;
}