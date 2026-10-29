import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, Loader2, Eye, EyeOff, ShieldAlert } from 'lucide-react';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import { adminChangePassword } from '../../services/adminService';

export default function AdminChangePassword({ forced = false }) {
  const { applyAdminSession } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (newPassword.length < 6) return showToast('New password must be at least 6 characters.', 'error');
    if (newPassword !== confirmPassword) return showToast('New passwords do not match.', 'error');
    setBusy(true);
    try {
      const { data } = await adminChangePassword({ currentPassword, newPassword, confirmPassword });
      applyAdminSession(data.token, data.admin);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      showToast('Password updated.');
      if (forced) navigate('/admin/overview', { replace: true });
    } catch (err) {
      showToast(err?.response?.data?.message || err.message || 'Could not change password', 'error');
    } finally {
      setBusy(false);
    }
  };

  const Wrapper = forced ? 'div' : 'section';
  const wrapperProps = forced
    ? { className: 'auth-card auth-card-admin glass-card fade-up' }
    : { className: 'glass-card admin-section-card fade-up' };

  return (
    <Wrapper {...wrapperProps}>
      <div className="admin-section-head">
        <h3><KeyRound size={17} /> {forced ? 'Set Your Own Password' : 'Change Password'}</h3>
      </div>

      {forced && (
        <div className="inline-note warn" role="status">
          <ShieldAlert size={16} />
          <span>For your security, you must replace the initial password before using the admin portal.</span>
        </div>
      )}

      <form onSubmit={submit} className="form" noValidate>
        <div className="form-group">
          <label htmlFor="curPass">{forced ? 'Initial password' : 'Current password'}</label>
          <input id="curPass" type={show ? 'text' : 'password'} className="input"
            value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required autoFocus={forced} />
        </div>
        <div className="form-group">
          <label htmlFor="newPass">New password</label>
          <div className="input-with-icon">
            <input id="newPass" type={show ? 'text' : 'password'} className="input"
              value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={6} />
            <button type="button" className="input-icon-btn" aria-label="Toggle password visibility"
              onClick={() => setShow((s) => !s)}>
              {show ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="confPass">Confirm new password</label>
          <input id="confPass" type={show ? 'text' : 'password'} className="input"
            value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
        </div>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <><Loader2 size={17} className="spin" /> Saving...</> : 'Update password'}
        </button>
      </form>
    </Wrapper>
  );
}
