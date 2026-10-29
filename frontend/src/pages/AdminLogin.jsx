import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck, Loader2, Eye, EyeOff, ArrowLeft, Send, Clock,
  CheckCircle2, XCircle, UserPlus, KeyRound,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';

const STATUS_META = {
  pending: { label: 'Pending review', icon: Clock, cls: 'warn' },
  approved: { label: 'Approved', icon: CheckCircle2, cls: 'ok' },
  rejected: { label: 'Rejected', icon: XCircle, cls: 'not-ok' },
  revoked: { label: 'Revoked', icon: XCircle, cls: 'not-ok' },
};

export default function AdminLogin() {
  const { adminLogin, requestAdminAccess } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [view, setView] = useState('login'); // 'login' | 'request'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState(null); // { tone, text }
  const [submitted, setSubmitted] = useState(null); // request object

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!email || !password) return showToast('Email and password are required.', 'error');
    setLoading(true);
    setNotice(null);
    try {
      const adminUser = await adminLogin(email, password);
      if (adminUser.mustChangePassword) {
        showToast('Please set your own password to continue.');
      } else {
        showToast('Welcome back.');
      }
      navigate('/admin/overview', { replace: true });
    } catch (err) {
      const data = err?.response?.data || {};
      if (data.code === 'NOT_ADMIN') {
        // A valid account WITHOUT admin access: never a session, only an offer.
        setNotice({
          tone: 'warn',
          text: data.requestStatus === 'pending'
            ? 'Your admin-access request is already pending review.'
            : 'This account has no administrator access. You can request it below.',
        });
        setView('request');
      } else {
        showToast(data.message || err.message || 'Admin login failed', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRequest = async (e) => {
    e.preventDefault();
    if (!email || !password) return showToast('Enter your account email and password.', 'error');
    if (reason.trim().length < 5) return showToast('Please provide a short reason (at least 5 characters).', 'error');
    setLoading(true);
    setNotice(null);
    try {
      const { data } = await requestAdminAccess({ email, password, reason: reason.trim() });
      setSubmitted(data.request || { status: 'pending' });
      showToast(data.code === 'ALREADY_PENDING' ? 'Your request is already pending.' : 'Request submitted for review.');
    } catch (err) {
      const data = err?.response?.data || {};
      showToast(data.message || err.message || 'Could not submit the request', 'error');
    } finally {
      setLoading(false);
    }
  };

  const resetToLogin = () => {
    setView('login');
    setSubmitted(null);
    setNotice(null);
    setReason('');
  };

  const statusMeta = submitted ? (STATUS_META[submitted.status] || STATUS_META.pending) : null;
  const StatusIcon = statusMeta?.icon;

  return (
    <div className="auth-page admin-auth">
      <div className="admin-orb" aria-hidden="true" />
      <div className="auth-card auth-card-admin glass-card fade-up">
        <div className="auth-head">
          <span className="auth-icon"><ShieldCheck size={22} /></span>
          <h1>Admin Portal</h1>
          <p className="muted">
            {view === 'login'
              ? 'Restricted access — administrators only.'
              : 'Request administrator access from the Main Admin Leader.'}
          </p>
        </div>

        {notice && (
          <div className={`inline-note ${notice.tone}`} role="status">
            <span>{notice.text}</span>
          </div>
        )}

        {view === 'login' && (
          <form onSubmit={handleLogin} className="form" noValidate>
            <div className="form-group">
              <label htmlFor="adminEmail">Admin Email</label>
              <input id="adminEmail" type="email" className="input" placeholder="admin@company.com"
                value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="form-group">
              <label htmlFor="adminPassword">Password</label>
              <div className="input-with-icon">
                <input id="adminPassword" type={showPass ? 'text' : 'password'} className="input"
                  placeholder="••••••••" value={password}
                  onChange={(e) => setPassword(e.target.value)} required />
                <button type="button" className="input-icon-btn" aria-label="Toggle password visibility"
                  onClick={() => setShowPass((s) => !s)}>
                  {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
              {loading ? <><Loader2 size={18} className="spin" /> Signing in...</> : <><KeyRound size={17} /> Sign in to Admin</>}
            </button>
            <button type="button" className="link-as-btn center" onClick={() => { setView('request'); setNotice(null); }}>
              <UserPlus size={14} /> Request admin access
            </button>
          </form>
        )}

        {view === 'request' && !submitted && (
          <form onSubmit={handleRequest} className="form" noValidate>
            <div className="form-group">
              <label htmlFor="reqEmail">Your Account Email</label>
              <input id="reqEmail" type="email" className="input" placeholder="you@example.com"
                value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="form-group">
              <label htmlFor="reqPassword">Your Account Password</label>
              <div className="input-with-icon">
                <input id="reqPassword" type={showPass ? 'text' : 'password'} className="input"
                  placeholder="••••••••" value={password}
                  onChange={(e) => setPassword(e.target.value)} required />
                <button type="button" className="input-icon-btn" aria-label="Toggle password visibility"
                  onClick={() => setShowPass((s) => !s)}>
                  {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <span className="field-hint">Your credentials are verified but grant no access by themselves.</span>
            </div>
            <div className="form-group">
              <label htmlFor="reqReason">Reason for access</label>
              <textarea id="reqReason" className="input" rows={3} maxLength={500}
                placeholder="Briefly explain why you need administrator access..."
                value={reason} onChange={(e) => setReason(e.target.value)} required />
              <span className="field-hint">{reason.length}/500</span>
            </div>
            <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
              {loading ? <><Loader2 size={18} className="spin" /> Submitting...</> : <><Send size={16} /> Submit request</>}
            </button>
            <button type="button" className="link-as-btn center" onClick={resetToLogin}>
              <ArrowLeft size={14} /> Back to sign in
            </button>
          </form>
        )}

        {view === 'request' && submitted && (
          <div className="request-result">
            {StatusIcon && (
              <span className={`status-icon ${statusMeta.cls}`}><StatusIcon size={30} /></span>
            )}
            <h3>Request {statusMeta?.label?.toLowerCase() || 'submitted'}</h3>
            <p className="muted small">
              {submitted.status === 'pending'
                ? 'The Main Admin Leader will review your request. You will be able to sign in here once it is approved.'
                : 'You can submit a new request if your situation has changed.'}
            </p>
            <div className="modal-foot">
              <button className="btn btn-outline" onClick={resetToLogin}>
                <ArrowLeft size={15} /> Back to sign in
              </button>
            </div>
          </div>
        )}

        <p className="auth-switch">
          <button className="link-as-btn" onClick={() => navigate('/')}>
            <ArrowLeft size={14} /> Back to website
          </button>
        </p>
      </div>
    </div>
  );
}
