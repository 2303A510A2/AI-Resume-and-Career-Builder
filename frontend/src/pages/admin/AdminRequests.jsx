import { useCallback, useEffect, useState } from 'react';
import {
  Inbox, ChevronLeft, ChevronRight, Check, X, Loader2, User, Clock,
} from 'lucide-react';
import { listAdminRequests, approveAdminRequest, rejectAdminRequest } from '../../services/adminService';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import Loading from '../../components/Loading.jsx';

const STATUS_TABS = ['pending', 'approved', 'rejected', 'revoked', 'all'];

export default function AdminRequests({ embedded = false }) {
  const { admin } = useAuth();
  const { showToast } = useToast();
  const isMain = admin?.role === 'main_admin';

  const [tab, setTab] = useState('pending');
  const [requests, setRequests] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, pages: 1 });
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [rejecting, setRejecting] = useState(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await listAdminRequests({ page, limit: 20, status: tab === 'all' ? '' : tab });
      setRequests(data.requests || []);
      setPagination(data.pagination || { page: 1, total: 0, pages: 1 });
    } catch (err) {
      showToast(err?.response?.data?.message || 'Failed to load requests', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, tab, showToast]);

  useEffect(() => { load(); }, [load]);

  const approve = async (r) => {
    setBusyId(r._id);
    try {
      await approveAdminRequest(r._id);
      showToast(`${r.name} is now a co-admin`);
      load();
      window.dispatchEvent(new Event('admin:refresh'));
    } catch (err) {
      showToast(err?.response?.data?.message || 'Approval failed', 'error');
      load();
    } finally {
      setBusyId('');
    }
  };

  const reject = async () => {
    if (!rejecting) return;
    setBusyId(rejecting._id);
    try {
      await rejectAdminRequest(rejecting._id, note.trim());
      showToast('Request rejected');
      setRejecting(null);
      setNote('');
      load();
      window.dispatchEvent(new Event('admin:refresh'));
    } catch (err) {
      showToast(err?.response?.data?.message || 'Rejection failed', 'error');
    } finally {
      setBusyId('');
    }
  };

  return (
    <>
      {!embedded && (
        <div className="admin-top">
          <h1>Admin Approval</h1>
          <span className="muted small">Only the Main Admin Leader can approve or reject.</span>
        </div>
      )}

      <div className="admin-tabs">
        {STATUS_TABS.map((s) => (
          <button key={s} className={`admin-tab ${tab === s ? 'active' : ''}`}
            onClick={() => { setTab(s); setPage(1); }}>
            {s[0].toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <Loading label="Loading requests..." />
      ) : (
        <div className="glass-card admin-table-card">
          <table className="admin-table">
            <thead>
              <tr><th>Applicant</th><th>Reason</th><th>Status</th><th>Submitted</th><th>Reviewed</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r._id}>
                  <td>
                    <strong>{r.name}</strong><br />
                    <span className="muted small">{r.email}</span>
                  </td>
                  <td className="admin-reason">{r.reason}</td>
                  <td><span className={`badge status-${r.status}`}>{r.status}</span></td>
                  <td className="muted small">{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td className="muted small">
                    {r.reviewedAt ? <>{new Date(r.reviewedAt).toLocaleDateString()}<br /><span className="muted">{r.reviewedByEmail}</span></> : '—'}
                    {r.decisionNote ? <><br /><span className="muted">“{r.decisionNote}”</span></> : null}
                  </td>
                  <td>
                    {isMain && r.status === 'pending' ? (
                      <div className="row-actions">
                        <button className="btn btn-primary btn-xs" title="Approve" onClick={() => approve(r)} disabled={busyId === r._id}>
                          {busyId === r._id ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Approve
                        </button>
                        <button className="btn btn-danger btn-xs" title="Reject" onClick={() => { setRejecting(r); setNote(''); }} disabled={busyId === r._id}>
                          <X size={14} /> Reject
                        </button>
                      </div>
                    ) : (
                      <span className="muted small">{r.status === 'pending' ? <><Clock size={13} /> pending</> : '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
              {requests.length === 0 && (
                <tr><td colSpan={6} className="muted center">
                  <Inbox size={18} /> No {tab === 'all' ? '' : tab} requests.
                </td></tr>
              )}
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

      {rejecting && (
        <div className="modal-scrim" onClick={() => !busyId && setRejecting(null)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3><User size={18} /> Reject request</h3>
              <button className="icon-btn" onClick={() => setRejecting(null)}>✕</button>
            </div>
            <div className="modal-body">
              <p className="small">Reject <strong>{rejecting.name}</strong> ({rejecting.email})? They stay an ordinary user.</p>
              <div className="form-group">
                <label htmlFor="rejNote">Note (optional)</label>
                <textarea id="rejNote" className="input" rows={3} maxLength={300}
                  value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="Why is this request being rejected?" />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn btn-danger" onClick={reject} disabled={busyId === rejecting._id}>
                {busyId === rejecting._id ? <><Loader2 size={15} className="spin" /> Rejecting...</> : 'Reject request'}
              </button>
              <button className="btn btn-outline" onClick={() => setRejecting(null)} disabled={!!busyId}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
