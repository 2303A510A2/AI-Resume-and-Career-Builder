import { Link, useLocation } from 'react-router-dom';
import { Rocket, LogIn, UserPlus, Menu, X } from 'lucide-react';
import { useState } from 'react';

export default function Navbar() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const links = [
    { to: '/', label: 'Home' },
    { to: '/login', label: 'Login' },
    { to: '/signup', label: 'Get Started' },
  ];

  return (
    <nav className="navbar">
      <div className="navbar-inner container">
        <Link to="/" className="brand" onClick={() => setOpen(false)}>
          <span className="brand-icon"><Rocket size={20} /></span>
          <span className="brand-text">AI Resume &amp; Career Builder</span>
        </Link>

        <button
          className="nav-toggle"
          aria-label="Toggle navigation"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>

        <div className={`nav-links ${open ? 'open' : ''}`}>
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              className={`nav-link ${l.to === '/login' ? 'nav-link-plain' : 'nav-link-cta'} ${
                location.pathname === l.to ? 'active' : ''
              }`}
              onClick={() => setOpen(false)}
            >
              {l.to === '/login' ? <LogIn size={16} /> : l.to === '/signup' ? <UserPlus size={16} /> : null}
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}