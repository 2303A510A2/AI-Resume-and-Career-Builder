import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { Inbox, ShieldHalf, Users, ShieldCheck } from 'lucide-react';
import AdminRequests from './AdminRequests.jsx';
import AdminCoAdmins from './AdminCoAdmins.jsx';
import AdminUsers from './AdminUsers.jsx';

// The Main Admin Leader's consolidated control room. It deliberately lives on
// its own route so the dashboard stays focused on the two real statistic cards
// and the user table. Every action rendered here is ALSO authorized server-side;
// a co-admin who opens this URL directly is stopped by the route guard and by
// the backend's requireMainAdmin/requirePermission middlewares.
const TABS = [
  { id: 'requests', label: 'Requests', icon: Inbox },
  { id: 'admins', label: 'Administrators', icon: ShieldHalf },
  { id: 'users', label: 'Regular Users', icon: Users },
];

const pickTab = (value) => (TABS.some((t) => t.id === value) ? value : 'requests');

export default function AdminControls() {
  const location = useLocation();
  const [tab, setTab] = useState(pickTab(location.state?.tab));

  // The notification bell can navigate here with a requested tab even while this
  // page is already mounted; follow that intent instead of keeping the old tab.
  useEffect(() => {
    if (location.state?.tab) setTab(pickTab(location.state.tab));
  }, [location.state?.tab]);

  return (
    <>
      <div className="admin-top">
        <div>
          <h1>Admin Controls</h1>
          <span className="muted small">Requests, administrators and user access — Main Admin Leader only.</span>
        </div>
        <span className="badge crown"><ShieldCheck size={13} /> Main Admin</span>
      </div>

      <div className="inline-note info">
        <ShieldCheck size={16} />
        <span>Approve or reject access requests, manage approved administrators, and block or unblock regular users. The backend enforces every rule on this page.</span>
      </div>

      <div className="admin-tabs" role="tablist" aria-label="Admin controls sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`admin-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'requests' && <AdminRequests embedded />}
      {tab === 'admins' && <AdminCoAdmins embedded />}
      {tab === 'users' && <AdminUsers embedded defaultRole="user" enableEmailBlock />}
    </>
  );
}
