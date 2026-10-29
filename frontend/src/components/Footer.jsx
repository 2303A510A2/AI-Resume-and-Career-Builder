import { Link } from 'react-router-dom';
import { Rocket, ShieldCheck } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="footer-brand">
          <span className="brand-icon"><Rocket size={18} /></span>
          <span>AI Resume &amp; Career Builder</span>
        </div>
        <div className="footer-links">
          <Link to="/">Home</Link>
          <Link to="/signup">Get Started</Link>
          <Link to="/login">Login</Link>
          <Link to="/admin/login" className="footer-admin"><ShieldCheck size={14} /> Admin</Link>
        </div>
        <p className="footer-note">
          Your resume and career data stay private and are only used to personalize your AI assistant.
        </p>
      </div>
    </footer>
  );
}