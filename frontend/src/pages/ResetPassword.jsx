import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Lock, Loader2, Eye, EyeOff } from 'lucide-react';
import { resetPassword } from '../services/authService';
import { useToast } from '../hooks/useToast';

export default function ResetPassword() {
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();
  const resetToken = location.state?.resetToken;
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!resetToken) {
      showToast('Reset token missing. Please verify your OTP again.', 'error');
      navigate('/verify-otp');
      return;
    }
    if (password.length < 6) return showToast('Password must be at least 6 characters.', 'error');
    if (password !== confirmPassword) return showToast('Passwords do not match.', 'error');

    setLoading(true);
    try {
      const { data } = await resetPassword(resetToken, password, confirmPassword);
      localStorage.removeItem('resetEmail');
      showToast(data.message || 'Password updated. Please log in.');
      navigate('/login', { replace: true });
    } catch (err) {
      showToast(err.message || 'Password reset failed', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card glass-card fade-up">
        <div className="auth-head">
          <span className="auth-icon"><Lock size={22} /></span>
          <h1>Create a new password</h1>
          <p className="muted">Choose a new password with at least 6 characters.</p>
        </div>

        <form onSubmit={handleSubmit} className="form" noValidate>
          <div className="form-group">
            <label htmlFor="password">New Password</label>
            <div className="input-with-icon">
              <input id="password" type={showPass ? 'text' : 'password'} className="input"
                placeholder="At least 6 characters" value={password}
                onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="input-icon-btn" aria-label="Toggle password visibility"
                onClick={() => setShowPass((s) => !s)}>
                {showPass ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="confirmPassword">Confirm Password</label>
            <input id="confirmPassword" type={showPass ? 'text' : 'password'} className="input"
              placeholder="Repeat new password" value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)} required />
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? <><Loader2 size={18} className="spin" /> Updating...</> : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  );
}