import { useCallback, useEffect, useState } from 'react';
import {
  ShieldHalf, SlidersHorizontal, Ban, Trash2, Loader2, Check, Crown, ShieldAlert,
} from 'lucide-react';
import {
  listCoAdmins, updateCoAdminPermissions, revokeCoAdmin, deleteCoAdmin,
} from '../../services/adminService';
import { useToast } from '../../hooks/useToast';
import Loading from '../../components/Loading.jsx';

const PERMS = [
  ['manageUsers', 'Manage users', 'View, suspend and restore ordinary users.'],
  ['deleteUsers', 'Delete users', 'Permanently delete ordinary users and their data.'],
  ['manageResumes', 'Manage resumes', 'View and remove uploaded resumes.'],
  ['manageRequests', 'View access requests', 'See admin-access requests (cannot decide them).'],
  ['viewAudit', 'View audit log', 'Read the administrative audit trail.'],
  ['manageSettings', 'View settings', 'See system settings and provider status.'],
];

export default function AdminCoAdmins({ embedded = false }) {
  const { showToast } = useToast();
  const [coAdmins, setCoAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});
  const [confirm, setConfirm] = useState(null); // { type:'revoke'|'delete', admin }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await listCoAdmins();
      setCoAdmins(data.coAdmins || []);
    } catch (err) {
      showToast(err?.response?.data?.message || 'Failed to load co-admins', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const openPerms = (a) => {
    setEditing(a);
    setDraft({
      manageUsers: !!a.adminPermissions?.manageUsers,
      deleteUsers: !!a.adminPermissions?.deleteUsers,
      manageResumes: !!a.adminPermissions?.manageResumes,
      manageRequests: !!a.adminPermissions?.manageRequests,
      viewAudit: !!a.adminPermissions?.viewAudit,
      manageSettings: !!a.adminPermissions?.manageSettings,
    });
  };

  const savePerms = async () => {
    setBusy('perms');
    try {
      await updateCoAdminPermissions(editing._id, draft);
      showToast('Permissions updated');
      setEditing(null);
      load();
      window.dispatchEvent(new Event('admin:refresh'));
    } catch (err) {
      showToast(err?.response?.data?.message || 'Update failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const doConfirm = async () => {
    if (!confirm) return;
    setBusy(confirm.type);
    try {
      if (confirm.type === 'revoke') {
        await revokeCoAdmin(confirm.admin._id);
        showToast('Co-admin access revoked');
      } else {
        await deleteCoAdmin(confirm.admin._id);
        showToast('Co-admin deleted');
      }
      setConfirm(null);
      load();
      window.dispatchEvent(new Event('admin:refresh'));
    } catch (err) {
      showToast(err?.response?.data?.message || 'Action failed', 'error');
    } finally {
      setBusy('');
    }
  };

  if (loading) return <Loading label="Loading co-admins..." />;

  return (
    <>
      {!embedded && (
        <div className="admin-top">
          <h1>Admins</h1>
          <span className="muted small">{coAdmins.length} co-admin{coAdmins.length === 1 ? '' : 's'}</span>
        </div>
      )}

      <div className="glass-card admin-table-card">
        <table className="admin-table">
          <thead>
            <tr><th>Admin</th><th>Permissions</th><th>Account Status</th><th>Approved On</th><th>Approved By</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {coAdmins.map((a) => (
              <tr key={a._id}>
                <td>
                  <strong>{a.name}</strong><br />
                  <span className="muted small">{a.email}</span>
                  {a.mustChangePassword && <><br /><span className="badge warn">pending first login</span></>}
                </td>
                <td>
                  <div className="perm-chips">
                    {PERMS.filter(([k]) => a.adminPermissions?.[k]).map(([k, label]) => (
                      <span key={k} className="chip">{label}</span>
                    ))}
                    {!PERMS.some(([k]) => a.adminPermissions?.[k]) && <span className="muted small">None</span>}
                  </div>
                </td>
                <td>{a.isActive === false ? <span className="not-ok">Blocked</span> : <span className="ok">Active</span>}</td>
                <td className="muted small">{a.adminApprovedAt ? new Date(a.adminApprovedAt).toLocaleString() : '—'}</td>
                <td className="muted small">{a.adminApprovedByEmail || '—'}</td>
                <td>
                  <div className="row-actions">
                    <button className="btn btn-outline btn-xs" title="Edit permissions" onClick={() => openPerms(a)} disabled={!!busy}>
                      <SlidersHorizontal size={14} /> Permissions
                    </button>
                    <button className="btn btn-warn btn-xs" title="Revoke access" onClick={() => setConfirm({ type: 'revoke', admin: a })} disabled={!!busy}>
                      <Ban size={14} /> Revoke
                    </button>
                    <button className="btn btn-danger btn-xs" title="Delete admin" onClick={() => setConfirm({ type: 'delete', admin: a })} disabled={!!busy}>
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {coAdmins.length === 0 && (
              <tr><td colSpan={6} className="muted center"><ShieldHalf size={18} /> No co-admins yet. Approve a request to add one.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="modal-scrim" onClick={() => !busy && setEditing(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3><SlidersHorizontal size={18} /> Permissions — {editing.name}</h3>
              <button className="icon-btn" onClick={() => setEditing(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="perm-list">
                {PERMS.map(([key, label, desc]) => (
                  <label key={key} className="perm-row">
                    <input type="checkbox" checked={!!draft[key]}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))} />
                    <span>
                      <strong>{label}</strong>
                      <span className="muted small"> {desc}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="muted small note">Approving/rejecting requests and changing settings stay restricted to the Main Admin Leader.</p>
            </div>
            <div className="modal-foot">
              <button className="btn btn-primary" onClick={savePerms} disabled={busy === 'perms'}>
                {busy === 'perms' ? <><Loader2 size={15} className="spin" /> Saving...</> : <><Check size={15} /> Save permissions</>}
              </button>
              <button className="btn btn-outline" onClick={() => setEditing(null)} disabled={!!busy}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {confirm && (
        <div className="modal-scrim" onClick={() => !busy && setConfirm(null)}>
          <div className="modal modal-confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3><ShieldAlert size={18} /> {confirm.type === 'revoke' ? 'Revoke access' : 'Delete co-admin'}</h3>
            </div>
            <div className="modal-body">
              {confirm.type === 'revoke' ? (
                <p>
                  Revoke <strong>{confirm.admin.name}</strong>'s administrator access? Their sessions are
                  invalidated immediately and they return to an ordinary account.
                </p>
              ) : (
                <p>
                  Permanently delete <strong>{confirm.admin.name}</strong> ({confirm.admin.email}) and all
                  related data? This cannot be undone.
                </p>
              )}
            </div>
            <div className="modal-foot">
              <button className={`btn ${confirm.type === 'delete' ? 'btn-danger' : 'btn-primary'}`} onClick={doConfirm} disabled={!!busy}>
                {busy ? <><Loader2 size={15} className="spin" /> Working...</> : (confirm.type === 'revoke' ? <><Ban size={15} /> Revoke access</> : <><Trash2 size={15} /> Delete permanently</>)}
              </button>
              <button className="btn btn-outline" onClick={() => setConfirm(null)} disabled={!!busy}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <p className="muted small admin-footer-note">
        <Crown size={13} /> Co-admins can never modify, suspend, revoke or delete another administrator.
      </p>
    </>
  );
}
