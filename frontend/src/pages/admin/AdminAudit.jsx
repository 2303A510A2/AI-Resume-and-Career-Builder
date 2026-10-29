import { useCallback, useEffect, useState } from 'react';
import { ScrollText, Search, ChevronLeft, ChevronRight, Lock } from 'lucide-react';
import { listAudit } from '../../services/adminService';
import { useToast } from '../../hooks/useToast';
import Loading from '../../components/Loading.jsx';

const humanAction = (action = '') =>
  action.replace(/^admin\./, '').replace(/\./g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default function AdminAudit() {
  const { showToast } = useToast();
  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, total: 0, pages: 1 });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await listAudit({ page, limit: 25, search, action });
      setLogs(data.logs || []);
      setPagination(data.pagination || { page: 1, total: 0, pages: 1 });
    } catch (err) {
      showToast(err?.response?.data?.message || 'Failed to load audit log', 'error');
    } finally {
      setLoading(false);
    }
  }, [page, search, action, showToast]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="admin-top">
        <h1>Audit Log</h1>
        <span className="muted small"><Lock size={12} /> Append-only · {pagination.total.toLocaleString()} entries</span>
      </div>

      <div className="admin-toolbar">
        <div className="search-box">
          <Search size={16} />
          <input className="input" placeholder="Search by actor or target..."
            value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <input className="input admin-select" placeholder="Filter action (e.g. user.delete)"
          value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} />
      </div>

      {loading ? (
        <Loading label="Loading audit log..." />
      ) : (
        <div className="glass-card admin-table-card">
          <table className="admin-table">
            <thead>
              <tr><th>When</th><th>Actor</th><th>Role</th><th>Action</th><th>Target</th><th>Meta</th></tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l._id}>
                  <td className="muted small">{new Date(l.createdAt).toLocaleString()}</td>
                  <td className="small">{l.actorEmail || '—'}</td>
                  <td><span className="badge">{l.actorRole || '—'}</span></td>
                  <td><strong className="small">{humanAction(l.action)}</strong><br /><span className="muted small">{l.action}</span></td>
                  <td className="small">{l.targetLabel || l.targetId || '—'}</td>
                  <td className="muted small admin-meta">
                    {l.meta && Object.keys(l.meta).length ? JSON.stringify(l.meta) : '—'}
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr><td colSpan={6} className="muted center"><ScrollText size={18} /> No audit entries found.</td></tr>
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

      <p className="muted small admin-footer-note">
        <Lock size={13} /> Audit entries can only be created — there is no edit or delete endpoint, not even for the Main Admin Leader.
      </p>
    </>
  );
}
