import { Link } from 'react-router-dom';
import { Compass, Home } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="auth-page">
      <div className="auth-card glass-card fade-up center-text">
        <span className="auth-icon"><Compass size={26} /></span>
        <h1>404 — Page not found</h1>
        <p className="muted">The page you're looking for doesn't exist or was moved.</p>
        <Link to="/" className="btn btn-primary">
          <Home size={16} /> Back to Home
        </Link>
      </div>
    </div>
  );
}