import { useCallback, useEffect, useState } from 'react';
import {
  Search, Eye, Trash2, UserX, UserCheck, ChevronLeft, ChevronRight, Loader2, ShieldAlert, Mail,
} from 'lucide-react';
import {
  listUsers, getUserDetail, suspendUser, restoreUser, deleteUser,
} from '../../services/adminService';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import Loading from '../../components/Loading.jsx';

const can = (admin, perm) => admin?.role === 'main_admin' || admin?.adminPermissions?.[perm] === true;

const ROLE_LABEL = { user: 'User', co_admin: 'Co-Admin', main_admin: 'Main Admin' };

// `embedded` renders the table inside the Main Admin Controls page (no duplicate
// page heading). `defaultRole` locks a section to regular users, and
// `enableEmailBlock` adds the explicit "block a user by email" form.
export default function AdminUsers({ embedded = false, defaultRole = '', enableEmailBlock = false }) {
  const { admin } = useAuth();
  const { showToast } = useToast();

  const [users, setUsers] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, pages: 1 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState(defaultRole);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState(null);
  const [confirm, setConfirm] = useState(null); // { type: 'block'|'unblock'|'delete', user }
  const [emailInput, setEmailInput] = useState('');
  const [emailBusy, setEmailBusy] = useState(false);

  const allowDelete = can(admin, 'deleteUsers');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await listUsers({ page, limit: 10, search, role, status });
      setUsers(data.users || []);
      setPagination(data.pagination || { page: 1, total: 0, pages: 1 });
    } catch (err) {
      showToast(err?.response?.data?.message || err.message || 'Failed to load users', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, search, role, status, showToast]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (id) => {
    setBusy(true);
    try {
      const { data } = await getUserDetail(id);
      setDetail(data);
    } catch (err) {
      showToast(err?.response?.data?.message || 'Failed to load user', 'error');
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async () => {
    if (!confirm) return;
    const { type, user } = confirm;
    setBusy(true);
    try {
      if (type === 'delete') {
        await deleteUser(user._id);
        showToast('User and all related data deleted');
        setDetail(null);
      } else if (type === 'block') {
        await suspendUser(user._id, 'Blocked by administrator');
        showToast('User account blocked');
        if (detail?.user?._id === user._id) openDetail(user._id);
      } else {
        await restoreUser(user._id);
        showToast('User account unblocked');
        if (detail?.user?._id === user._id) openDetail(user._id);
      }
      setConfirm(null);
      load();
      window.dispatchEvent(new Event('admin:refresh'));
    } catch (err) {
      showToast(err?.response?.data?.message || 'Action failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Block/unblock by email: resolve the account through the EXISTING user list
  // endpoint (no duplicate backend endpoint), then use the same confirmation and
  // suspend/restore handlers as the table.
  const findUserByEmail = async (e) => {
    e.preventDefault();
    const email = emailInput.trim().toLowerCase();
    if (!email) return showToast('Enter the email address of a regular user.', 'error');
    setEmailBusy(true);
    try {
      const { data } = await listUsers({ page: 1, limit: 50, search: email, role: 'user' });
      const found = (data.users || []).find((u) => String(u.email).toLowerCase() === email);
      if (!found) {
        showToast('No regular user found with that email address.', 'error');
        return;
      }
      setConfirm({ type: found.isActive === false ? 'unblock' : 'block', user: found });
    } catch (err) {
      showToast(err?.response?.data?.message || 'Could not look up that email.', 'error');
    } finally {
      setEmailBusy(false);
    }
  };

  // Ordinary users may be managed by a co-admin with manageUsers; another
  // administrator (and the Main Admin Leader) never may. Server-side guards
  // repeat this rule — the UI only avoids offering an action that would 403.
  const isProtectedRow = (u) =>
    u.role === 'main_admin' ||
    String(u._id) === String(admin?._id) ||
    (u.role !== 'user' && admin?.role !== 'main_admin');

  const confirmCopy = () => {
    if (!confirm) return null;
    const { type, user } = confirm;
    if (type === 'delete') {
      return {
        title: 'Delete account',
        icon: <ShieldAlert size={18} />,
        body: (
          <>
            <p>
              Permanently delete <strong>{user.name}</strong> ({user.email}) and <strong>all</strong> of
              their data — conversations, resume, knowledge base, documents and generated images?
            </p>
            <p className="muted small">This cannot be undone.</p>
          </>
        ),
        confirmLabel: 'Yes, delete everything',
        danger: true,
      };
    }
    if (type === 'block') {
      return {
        title: 'Block account',
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
      };
    }
    return {
      title: 'Unblock account',
      icon: <UserCheck size={18} />,
      body: <p>Restore access for <strong>{user.name}</strong> ({user.email})?</p>,
      confirmLabel: 'Unblock account',
      danger: false,
    };
  };

  const copy = confirmCopy();

  return (
    <>
      {!embedded && (
        <div className="admin-top">
          <h1>Users</h1>
          <span className="muted small">{pagination.total.toLocaleString()} accounts</span>
        </div>
      )}

      {enableEmailBlock && (
        <form className="admin-toolbar admin-email-block" onSubmit={findUserByEmail}>
          <div className="search-box">
            <Mail size={16} />
            <input
              className="input"
              type="email"
              placeholder="Block or unblock a regular user by email..."
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              aria-label="User email to block or unblock"
            />
          </div>
          <button type="submit" className="btn btn-warn btn-sm" disabled={emailBusy || busy}>
            {emailBusy ? <><Loader2 size={14} className="spin" /> Looking up...</> : <><UserX size={14} /> Find user</>}
          </button>
        </form>
      )}

      <div className="admin-toolbar">
        <div className="search-box">
          <Search size={16} />
          <input className="input" placeholder="Search by name or email..."
            value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        {!defaultRole && (
          <select className="input admin-select" value={role} onChange={(e) => { setRole(e.target.value); setPage(1); }}>
            <option value="">All roles</option>
            <option value="user">User</option>
            <option value="co_admin">Co-Admin</option>
            <option value="main_admin">Main Admin</option>
          </select>
        )}
        <select className="input admin-select" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Blocked</option>
        </select>
      </div>

      {loading ? (
        <Loading label="Loading users..." />
      ) : (
        <div className="glass-card admin-table-card">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Total Conversations</th>
                <th>Account Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u._id}>
                  <td>
                    <strong>{u.name}</strong>
                    {u.role !== 'user' && (
                      <> <span className={`badge ${u.role === 'main_admin' ? 'crown' : ''}`}>{ROLE_LABEL[u.role] || u.role}</span></>
                    )}
                  </td>
                  <td className="muted small">{u.email}</td>
                  <td>{u.chatCount}</td>
                  <td>{u.isActive === false ? <span className="not-ok">Blocked</span> : <span className="ok">Active</span>}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-outline btn-xs" onClick={() => openDetail(u._id)} disabled={busy}>
                        <Eye size={14} /> View
                      </button>
                      {!isProtectedRow(u) && (
                        <button className={`btn btn-xs ${u.isActive === false ? 'btn-outline' : 'btn-warn'}`}
                          onClick={() => setConfirm({ type: u.isActive === false ? 'unblock' : 'block', user: u })} disabled={busy}>
                          {u.isActive === false ? <><UserCheck size={14} /> Unblock</> : <><UserX size={14} /> Block</>}
                        </button>
                      )}
                      {allowDelete && !isProtectedRow(u) && (
                        <button className="btn btn-danger btn-xs" onClick={() => setConfirm({ type: 'delete', user: u })} disabled={busy}>
                          <Trash2 size={14} /> Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {users.length === 0 && <tr><td colSpan={5} className="muted center">No users found.</td></tr>}
            </tbody>
          </table>
          <div className="pager">
            <button className="btn btn-outline btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft size={15} /> Prev
            </button>
            <span className="muted small">Page {pagination.page} of {pagination.pages}</span>
            <button className="btn btn-outline btn-sm" disabled={page >= pagination.pages} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}

      {/* Detail modal */}
      {detail && (
        <div className="modal-scrim" onClick={() => setDetail(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{detail.user.name}</h3>
              <button className="icon-btn" onClick={() => setDetail(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="muted small">{detail.user.email} · joined {new Date(detail.user.createdAt).toLocaleDateString()}</p>
              <h4>Resume</h4>
              {detail.resume ? (
                <p className="small">
                  {detail.resume.fileName} · {(detail.resume.fileSize / 1024).toFixed(0)} KB · match {detail.resume.analysis?.matchPercent ?? '—'}%
                </p>
              ) : <p className="muted small">No resume.</p>}
              <h4>Target job</h4>
              <p className="small">{detail.job ? `${detail.job.jobTitle}${detail.job.company ? ' · ' + detail.job.company : ''}` : 'None'}</p>
              <div className="detail-stats">
                <div><strong>{detail.chatCount}</strong><span>conversations</span></div>
                <div><strong>{detail.interviewCount}</strong><span>interviews</span></div>
                <div><strong>{detail.ragDocumentCount}</strong><span>knowledge chunks</span></div>
                <div><strong>{detail.documentCount}</strong><span>documents</span></div>
                <div><strong>{detail.generatedImageCount}</strong><span>images</span></div>
                <div><strong>{detail.roadmap?.progressPercent ?? 0}%</strong><span>roadmap</span></div>
              </div>
              {detail.adminRequest && (
                <p className="small">Admin request: <strong>{detail.adminRequest.status}</strong></p>
              )}
              <p className="muted small note">Private chat content is intentionally not shown to admins.</p>
            </div>
            <div className="modal-foot">
              {!isProtectedRow(detail.user) && (
                <button className={`btn ${detail.user.isActive === false ? 'btn-outline' : 'btn-warn'}`} disabled={busy}
                  onClick={() => setConfirm({ type: detail.user.isActive === false ? 'unblock' : 'block', user: detail.user })}>
                  {detail.user.isActive === false ? <><UserCheck size={15} /> Unblock</> : <><UserX size={15} /> Block</>}
                </button>
              )}
              {allowDelete && !isProtectedRow(detail.user) && (
                <button className="btn btn-danger" onClick={() => setConfirm({ type: 'delete', user: detail.user })} disabled={busy}>
                  <Trash2 size={15} /> Delete user &amp; data
                </button>
              )}
              <button className="btn btn-outline" onClick={() => setDetail(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation modal (block / unblock / delete) */}
      {confirm && copy && (
        <div className="modal-scrim" onClick={() => !busy && setConfirm(null)}>
          <div className="modal modal-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{copy.icon} {copy.title}</h3>
            </div>
            <div className="modal-body">{copy.body}</div>
            <div className="modal-foot">
              <button className={`btn ${copy.danger ? 'btn-danger' : 'btn-primary'}`} onClick={doConfirm} disabled={busy}>
                {busy ? <><Loader2 size={15} className="spin" /> Working...</> : copy.confirmLabel}
              </button>
              <button className="btn btn-outline" onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
