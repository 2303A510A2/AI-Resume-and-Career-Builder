import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Settings as SettingsIcon, LogOut, Menu,
  ShieldCheck, Bell, ScrollText, UserRound, ChevronDown, ShieldAlert,
} from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import AdminChangePassword from './AdminChangePassword.jsx';
import { adminMe, listAdminNotifications, readAllAdminNotifications } from '../../services/adminService';

// Permission-aware navigation. Every entry here is ALSO enforced server-side;
// hiding a link is convenience, never security.
const can = (admin, perm) => admin?.role === 'main_admin' || admin?.adminPermissions?.[perm] === true;
const initials = (name = '') => (String(name).trim().charAt(0) || 'A').toUpperCase();

function Avatar({ admin, size = 'sm' }) {
  const src = admin?.profile?.avatar;
  return (
    <span className={`admin-avatar ${size}`}>
      {src ? <img src={src} alt="Profile photo" /> : initials(admin?.name)}
    </span>
  );
}

export default function AdminLayout() {
  const { admin, adminLogout, updateAdmin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false); // section navigation
  const [profileOpen, setProfileOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [notifs, setNotifs] = useState([]);
  const [unread, setUnread] = useState(0);
  const [pending, setPending] = useState(0);
  const popRef = useRef(null);

  const isMain = admin?.role === 'main_admin';
  const mustChange = !!admin?.mustChangePassword;

  // One poller for the whole layout (never one per render): refreshes the real
  // notification/request badge counts + the admin's own profile from /admin/me.
  const refresh = useCallback(async () => {
    try {
      const { data } = await adminMe();
      if (data.admin) updateAdmin(data.admin);
      setUnread(data.unreadNotifications || 0);
      setPending(data.pendingAdminRequests || 0);
    } catch {
      /* transient — keep the last known counts */
    }
  }, [updateAdmin]);

  useEffect(() => {
    if (!admin || mustChange) return undefined;
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mustChange, refresh]);

  // Mutations (block/unblock, approve/reject, revoke/demote) ask the layout to
  // refresh the badge counts and the signed-in admin's own record immediately,
  // instead of waiting for the 30s poll.
  useEffect(() => {
    const onRefresh = () => { if (admin && !mustChange) refresh(); };
    window.addEventListener('admin:refresh', onRefresh);
    return () => window.removeEventListener('admin:refresh', onRefresh);
  }, [admin, mustChange, refresh]);

  useEffect(() => {
    const onDoc = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) {
        setProfileOpen(false);
        setBellOpen(false);
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  // Any route change closes the top-right menus.
  useEffect(() => {
    setMenuOpen(false);
    setProfileOpen(false);
    setBellOpen(false);
  }, [location.pathname]);

  const logout = () => {
    adminLogout();
    navigate('/admin/login', { replace: true });
  };

  const toggleBell = async () => {
    setProfileOpen(false);
    setMenuOpen(false);
    const next = !bellOpen;
    setBellOpen(next);
    if (next) {
      try {
        const { data } = await listAdminNotifications({ limit: 20 });
        setNotifs(data.notifications || []);
        setUnread(data.unread || 0);
      } catch {
        /* best-effort */
      }
    }
  };

  const markAll = async () => {
    try {
      await readAllAdminNotifications();
      setUnread(0);
      setNotifs((list) => list.map((n) => ({ ...n, read: true })));
    } catch {
      /* best-effort */
    }
  };

  const items = useMemo(() => {
    if (!admin) return [];
    return [
      { to: '/admin/overview', label: 'Dashboard', icon: LayoutDashboard, show: true },
      { to: '/admin/users', label: 'Users', icon: Users, show: can(admin, 'manageUsers') },
      // Requests + approved administrators + user status live together in the
      // Main Admin Leader's own Admin Controls page (kept separate from the
      // focused two-card dashboard).
      { to: '/admin/controls', label: 'Admin Controls', icon: ShieldAlert, show: isMain, badge: pending },
      { to: '/admin/audit', label: 'Audit Log', icon: ScrollText, show: can(admin, 'viewAudit') },
      { to: '/admin/settings', label: 'Profile & Settings', icon: SettingsIcon, show: true },
    ].filter((i) => i.show);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin?.role, JSON.stringify(admin?.adminPermissions || {}), pending]);

  // ---- Forced initial password change (backend-enforced; this is the UI) ----
  // A SEPARATE security step: no dashboard/dashboard navigation is rendered
  // until the initial password has been replaced. On success the component
  // updates the admin session and routes straight to the dashboard.
  if (mustChange) {
    return (
      <div className="auth-page admin-auth">
        <div className="admin-orb" aria-hidden="true" />
        <AdminChangePassword forced />
        <button className="link-as-btn admin-gate-logout" onClick={logout}>
          <LogOut size={14} /> Sign out
        </button>
      </div>
    );
  }

  const roleLabel = isMain ? 'Main Admin Leader' : 'Co-Admin';
  const badgeTotal = isMain ? pending + unread : unread;

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <span className="admin-topbar-brand"><ShieldCheck size={17} /> Admin</span>

        <div className="admin-topbar-right" ref={popRef}>
          {/* Compact section navigation (top-right). The large left sidebar is gone. */}
          <div className="admin-menu-wrap">
            <button
              className="admin-menu-btn"
              aria-label="Open admin menu"
              aria-haspopup="true"
              aria-expanded={menuOpen}
              onClick={() => { setBellOpen(false); setProfileOpen(false); setMenuOpen((m) => !m); }}
            >
              <Menu size={18} />
              <span className="admin-menu-label">Menu</span>
              {isMain && pending > 0 && <span className="admin-bell-badge">{pending > 99 ? '99+' : pending}</span>}
            </button>
            {menuOpen && (
              <div className="admin-pop admin-nav-pop">
                <div className="admin-pop-head"><strong>Sections</strong></div>
                {items.map((item) => {
                  const active = location.pathname === item.to || (item.to === '/admin/overview' && location.pathname === '/admin');
                  return (
                    <button
                      key={item.to}
                      type="button"
                      className={`admin-pop-item${active ? ' active' : ''}`}
                      onClick={() => navigate(item.to)}
                    >
                      <item.icon size={15} /> {item.label}
                      {item.badge > 0 && <span className="admin-nav-badge">{item.badge}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="admin-bell-wrap">
            <button className="admin-bell" aria-label="Notifications" aria-expanded={bellOpen} onClick={toggleBell}>
              <Bell size={18} />
              {badgeTotal > 0 && <span className="admin-bell-badge">{badgeTotal > 99 ? '99+' : badgeTotal}</span>}
            </button>
            {bellOpen && (
              <div className="admin-pop admin-notif-pop">
                <div className="admin-pop-head">
                  <strong>Notifications</strong>
                  <button type="button" className="link" onClick={markAll}>Mark all read</button>
                </div>
                <div className="admin-pop-list">
                  {isMain && pending > 0 && (
                    <button
                      type="button"
                      className="admin-notif unread"
                      onClick={() => { setBellOpen(false); navigate('/admin/controls', { state: { tab: 'requests' } }); }}
                    >
                      <strong>{pending} pending admin request{pending > 1 ? 's' : ''}</strong>
                      <div className="muted small">Open Admin Controls to review.</div>
                    </button>
                  )}
                  {notifs.length === 0 && !(isMain && pending > 0) && (
                    <div className="admin-empty sm">No notifications yet.</div>
                  )}
                  {notifs.map((n) => (
                    <button
                      type="button"
                      key={n._id}
                      className={`admin-notif ${n.read ? '' : 'unread'}`}
                      onClick={() => { setBellOpen(false); if (n.link) navigate(n.link.replace(/^#/, '')); }}
                    >
                      <strong>{n.title}</strong>
                      <div className="muted small">{n.body}</div>
                      <div className="muted xs">{n.createdAt ? new Date(n.createdAt).toLocaleString() : ''}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <span className={`badge ${isMain ? 'crown' : ''}`}>{roleLabel}</span>

          <div className="admin-profile-wrap">
            <button
              className="admin-profile-btn"
              aria-haspopup="true"
              aria-expanded={profileOpen}
              onClick={() => { setBellOpen(false); setMenuOpen(false); setProfileOpen((m) => !m); }}
            >
              <Avatar admin={admin} />
              <span className="admin-profile-name">{String(admin?.name || 'Admin').split(' ')[0]}</span>
              <ChevronDown size={15} />
            </button>
            {profileOpen && (
              <div className="admin-pop admin-profile-pop">
                <div className="admin-pop-id">
                  <Avatar admin={admin} size="lg" />
                  <div><strong>{admin?.name || 'Administrator'}</strong><span className="muted small">{admin?.email}</span></div>
                </div>
                <button type="button" className="admin-pop-item"
                  onClick={() => navigate('/admin/settings', { state: { tab: 'profile' } })}>
                  <UserRound size={15} /> My Profile
                </button>
                <button type="button" className="admin-pop-item"
                  onClick={() => navigate('/admin/settings', { state: { tab: 'security' } })}>
                  <SettingsIcon size={15} /> Settings
                </button>
                {isMain && (
                  <button type="button" className="admin-pop-item"
                    onClick={() => navigate('/admin/controls', { state: { tab: 'requests' } })}>
                    <ShieldAlert size={15} /> Admin Controls
                    {pending > 0 && <span className="admin-nav-badge">{pending > 99 ? '99+' : pending}</span>}
                  </button>
                )}
                <button type="button" className="admin-pop-item danger" onClick={logout}>
                  <LogOut size={15} /> Logout
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
