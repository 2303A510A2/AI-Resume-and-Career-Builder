import { useCallback, useEffect, useState } from 'react';
import {
  Users, MessagesSquare, RefreshCw, AlertTriangle, Search, Trash2,
  ChevronLeft, ChevronRight, Loader2, ShieldAlert, UserX, UserCheck,
} from 'lucide-react';
import {
  getAdminStats, listUsers, deleteUser, suspendUser, restoreUser,
} from '../../services/adminService';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import Loading from '../../components/Loading.jsx';

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : '0');
const initials = (name = '') => (String(name).trim().charAt(0) || 'A').toUpperCase();
const can = (admin, perm) => admin?.role === 'main_admin' || admin?.adminPermissions?.[perm] === true;
const ROLE_LABEL = { co_admin: 'Co-Admin', main_admin: 'Main Admin' };

export default function AdminOverview() {
  const { admin } = useAuth();
  const { showToast } = useToast();

  // --- The two primary statistics (real MongoDB counts from GET /admin/stats) ---
  const [stats, setStats] = useState(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');

  // --- The user-management list below the cards ---
  const [users, setUsers] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, pages: 1 });
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError] = useState('');

  const [confirm, setConfirm] = useState(null); // { type: 'block'|'unblock'|'delete', user }
  const [busy, setBusy] = useState(false);

  const allowDelete = can(admin, 'deleteUsers');
  const allowBlock = can(admin, 'manageUsers');

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError('');
    try {
      const { data } = await getAdminStats();
      setStats(data.stats || {});
    } catch (err) {
      setStatsError(err?.response?.data?.message || err.message || 'Could not load the dashboard statistics.');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError('');
    try {
      // Only ordinary registered users here — administrative accounts live in the
      // "Admins" section, and Total Users excludes them too.
      const { data } = await listUsers({ page, limit: 10, role: 'user', search });
      setUsers(data.users || []);
      setPagination(data.pagination || { page: 1, total: 0, pages: 1 });
    } catch (err) {
      setUsersError(err?.response?.data?.message || err.message || 'Could not load users.');
    } finally {
      setUsersLoading(false);
    }
  }, [page, search]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadUsers(); }, [loadUsers]);

  // Debounced search by name or email.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const reloadAll = useCallback(() => { loadStats(); loadUsers(); }, [loadStats, loadUsers]);

  const doConfirm = async () => {
    if (!confirm) return;
    const { type, user } = confirm;
    setBusy(true);
    try {
      if (type === 'delete') {
        await deleteUser(user._id);
        showToast('User and related data deleted.', 'success');
      } else if (type === 'block') {
        await suspendUser(user._id, 'Blocked by administrator');
        showToast(`${user.name} has been blocked.`, 'success');
      } else {
        await restoreUser(user._id);
        showToast(`${user.name} has been unblocked.`, 'success');
      }
      setConfirm(null);
      reloadAll(); // refresh the list AND both statistics
      window.dispatchEvent(new Event('admin:refresh'));
    } catch (err) {
      showToast(err?.response?.data?.message || 'Could not complete that action.', 'error');
    } finally {
      setBusy(false);
    }
  };

  // A regular user is the only kind of account the dashboard lists, but keep the
  // guard explicit: self, the Main Admin Leader and (for a co-admin) any other
  // administrator can never be blocked/deleted from here.
  const isProtected = (u) =>
    u.role === 'main_admin' ||
    String(u._id) === String(admin?._id) ||
    (u.role !== 'user' && admin?.role !== 'main_admin');

  const cards = [
    { label: 'Total Users', value: fmt(stats?.totalUsers), icon: Users },
    { label: 'Total Chats', value: fmt(stats?.totalChats ?? stats?.totalConversations), icon: MessagesSquare },
  ];

  const confirmCopy = () => {
    if (!confirm) return null;
    const { type, user } = confirm;
    if (type === 'delete') {
      return {
        title: 'Delete user',
        icon: <ShieldAlert size={18} />,
        body: (
          <>
            <p>
              Permanently delete <strong>{user.name}</strong> ({user.email}) and <strong>all</strong> of their
              related data — conversations, resume, knowledge base, documents and generated images?
            </p>
            <p className="muted small">This cannot be undone.</p>
          </>
        ),
        confirmLabel: 'Yes, delete everything',
        danger: true,
        busyLabel: 'Deleting...',
      };
    }
    if (type === 'block') {
      return {
        title: 'Block user',
        icon: <UserX size={18} />,
        body: (
          <>
            <p>
              Block <strong>{user.name}</strong> ({user.email})? They will be signed out immediately and
              cannot sign in or use protected features until you unblock them.
            </p>
            <p className="muted small">Their data is preserved.</p>
          </>
        ),
        confirmLabel: 'Block account',
        danger: true,
        busyLabel: 'Blocking...',
      };
    }
    return {
      title: 'Unblock user',
      icon: <UserCheck size={18} />,
      body: <p>Restore access for <strong>{user.name}</strong> ({user.email})?</p>,
      confirmLabel: 'Unblock account',
      danger: false,
      busyLabel: 'Unblocking...',
    };
  };
  const copy = confirmCopy();

  return (
    <>
      <div className="admin-top center">
        <h1>Dashboard</h1>
        <span className="muted small">Users and conversations at a glance</span>
      </div>

      {/* Two centered statistic cards */}
      {statsLoading ? (
        <Loading label="Loading dashboard..." />
      ) : statsError ? (
        <div className="admin-stat-error">
          <div className="inline-note error" role="alert">
            <AlertTriangle size={16} />
            <span>{statsError}</span>
          </div>
          <button className="btn btn-primary" onClick={loadStats}>
            <RefreshCw size={15} /> Retry
          </button>
        </div>
      ) : (
        <div className="admin-stat-grid center">
          {cards.map((c, i) => (
            <div key={c.label} className="glass-card stat-card stat-card-lg fade-up" style={{ animationDelay: `${i * 0.05}s` }}>
              <div className="stat-icon admin"><c.icon size={22} /></div>
              <div><h3>{c.label}</h3><p className="stat-value">{c.value}</p></div>
            </div>
          ))}
        </div>
      )}

      {/* User management, directly below the cards */}
      <section className="glass-card admin-section-card fade-up">
        <div className="admin-section-head">
          <h3><Users size={17} /> Users{pagination.total ? ` (${pagination.total.toLocaleString()})` : ''}</h3>
          <div className="search-box">
            <Search size={16} />
            <input
              className="input"
              placeholder="Search by name or email..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              aria-label="Search users"
            />
          </div>
        </div>

        {usersLoading ? (
          <Loading label="Loading users..." />
        ) : usersError ? (
          <div className="inline-note error" role="alert">
            <AlertTriangle size={16} />
            <span>{usersError}</span>
            <button className="btn btn-outline btn-xs" onClick={loadUsers}>
              <RefreshCw size={14} /> Retry
            </button>
          </div>
        ) : users.length === 0 ? (
          <div className="admin-empty">{search ? 'No users match your search.' : 'No users yet.'}</div>
        ) : (
          <>
            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Name</th><th>Email</th><th>Total Chats</th><th>Status</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u._id}>
                      <td>
                        <div className="admin-who">
                          <span className="admin-avatar xs">
                            {u.profile?.avatar ? <img src={u.profile.avatar} alt="" /> : initials(u.name)}
                          </span>
                          <strong>{u.name}</strong>
                          {u.role !== 'user' && (
                            <span className={`badge ${u.role === 'main_admin' ? 'crown' : ''}`}>{ROLE_LABEL[u.role] || u.role}</span>
                          )}
                        </div>
                      </td>
                      <td className="muted small">{u.email}</td>
                      <td>{u.chatCount || 0}</td>
                      <td>
                        <span className={`badge ${u.isActive === false ? 'warn' : 'ok'}`}>
                          {u.isActive === false ? 'Blocked' : 'Active'}
                        </span>
                      </td>
                      <td>
                        {(allowBlock || allowDelete) && !isProtected(u) ? (
                          <div className="row-actions">
                            {allowBlock && (
                              <button
                                className={`btn btn-xs ${u.isActive === false ? 'btn-outline' : 'btn-warn'}`}
                                onClick={() => setConfirm({ type: u.isActive === false ? 'unblock' : 'block', user: u })}
                                disabled={busy}
                              >
                                {u.isActive === false
                                  ? <><UserCheck size={14} /> Unblock</>
                                  : <><UserX size={14} /> Block</>}
                              </button>
                            )}
                            {allowDelete && (
                              <button className="btn btn-danger btn-xs" onClick={() => setConfirm({ type: 'delete', user: u })} disabled={busy}>
                                <Trash2 size={14} /> Delete
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="muted small">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pagination.pages > 1 && (
              <div className="pager">
                <button className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft size={15} /> Prev
                </button>
                <span className="muted small">Page {pagination.page} of {pagination.pages}</span>
                <button className="btn btn-outline btn-sm" disabled={page >= pagination.pages} onClick={() => setPage((p) => p + 1)}>
                  Next <ChevronRight size={15} />
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {/* Block / unblock / delete confirmation */}
      {confirm && copy && (
        <div className="modal-scrim" onClick={() => !busy && setConfirm(null)}>
          <div className="modal modal-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{copy.icon} {copy.title}</h3>
            </div>
            <div className="modal-body">{copy.body}</div>
            <div className="modal-foot">
              <button className={`btn ${copy.danger ? 'btn-danger' : 'btn-primary'}`} onClick={doConfirm} disabled={busy}>
                {busy ? <><Loader2 size={15} className="spin" /> {copy.busyLabel}</> : copy.confirmLabel}
              </button>
              <button className="btn btn-outline" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
