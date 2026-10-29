import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, FileText, Briefcase, Target, Bot, Mic, Presentation,
  Map, Sparkles, Code2, UserRound, Settings as SettingsIcon, LogOut, Menu, X, Rocket,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import BackendStatus from './BackendStatus.jsx';
import Avatar from './Avatar.jsx';

const NAV_ITEMS = [
  { to: '/dashboard/overview', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/dashboard/resume', label: 'My Resume', icon: FileText },
  { to: '/dashboard/job-description', label: 'Job Description', icon: Briefcase },
  { to: '/dashboard/skill-gap', label: 'Skill Gap', icon: Target },
  { to: '/dashboard/career-assistant', label: 'AI Assistant', icon: Bot },
  { to: '/dashboard/interview', label: 'Interview Preparation', icon: Presentation },
  { to: '/dashboard/mock-interview', label: 'Mock Interview', icon: Mic },
  { to: '/dashboard/roadmap', label: 'Learning Roadmap', icon: Map },
  { to: '/dashboard/resume-improver', label: 'Resume Improver', icon: Sparkles },
  { to: '/dashboard/coding-prep', label: 'Coding Preparation', icon: Code2 },
  { to: '/dashboard/profile', label: 'Profile', icon: UserRound },
  { to: '/dashboard/settings', label: 'Settings', icon: SettingsIcon },
];

export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="dash-shell">
      {/* Mobile top bar */}
      <header className="dash-topbar">
        <button className="nav-toggle" aria-label="Open menu" onClick={() => setOpen(true)}>
          <Menu size={22} />
        </button>
        <span className="topbar-brand">
          <Rocket size={18} /> AI Career Builder
        </span>
        <span className="topbar-health"><BackendStatus /></span>
        <NavLink to="/dashboard/settings" aria-label="Open settings" className="topbar-avatar-link">
          <Avatar user={user} className="topbar-avatar" />
        </NavLink>
      </header>

      {/* Sidebar / drawer */}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-head">
          <div className="brand">
            <span className="brand-icon"><Rocket size={20} /></span>
            <span className="brand-text">AI Career Builder</span>
          </div>
          <button className="nav-toggle sidebar-close" aria-label="Close menu" onClick={() => setOpen(false)}>
            <X size={20} />
          </button>
        </div>

        <NavLink to="/dashboard/settings" className="sidebar-user" title="Open settings" onClick={() => setOpen(false)}>
          <Avatar user={user} className="sidebar-avatar" />
          <div className="sidebar-user-info">
            <strong>{user?.name}</strong>
            <span className="muted small">{user?.email}</span>
          </div>
        </NavLink>

        <nav className="sidebar-nav" aria-label="Dashboard navigation">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `side-link ${isActive ? 'active' : ''}`}
              onClick={() => setOpen(false)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="side-link logout" onClick={handleLogout}>
            <LogOut size={18} />
            <span>Logout</span>
          </button>
        </div>
      </aside>

      {open && <div className="scrim" onClick={() => setOpen(false)} />}

      <main className="dash-main">
        <Outlet />
      </main>
    </div>
  );
}