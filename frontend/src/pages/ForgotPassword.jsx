import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, Loader2, MailCheck } from 'lucide-react';
import { forgotPassword } from '../services/authService';
import { useToast } from '../hooks/useToast';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      showToast('Please enter a valid email address.', 'error');
      return;
    }
    setLoading(true);
    try {
      const { data } = await forgotPassword(email);
      showToast(data.message || 'OTP sent');
      setSent(true);
    } catch (err) {
      showToast(err.message || 'Failed to send OTP', 'error');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="auth-page">
        <div className="auth-card glass-card fade-up center-text">
          <span className="auth-icon success"><MailCheck size={24} /></span>
          <h1>Check your inbox</h1>
          <p className="muted">
            If <strong>{email}</strong> is registered, we've sent a 6-digit OTP that expires in about 10 minutes.
          </p>
          <button className="btn btn-primary btn-block" onClick={() => navigate('/verify-otp', { state: { email } })}>
            I have the OTP — continue
          </button>
          <p className="auth-switch">
            <button className="link-as-btn" onClick={() => setSent(false)}>Use a different email</button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card glass-card fade-up">
        <div className="auth-head">
          <span className="auth-icon"><KeyRound size={22} /></span>
          <h1>Forgot your password?</h1>
          <p className="muted">Enter your registered email and we'll send you a reset OTP.</p>
        </div>
        <form onSubmit={handleSubmit} className="form" noValidate>
          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" className="input" placeholder="you@example.com" value={email}
              onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? <><Loader2 size={18} className="spin" /> Sending OTP...</> : 'Send OTP'}
          </button>
        </form>
        <p className="auth-switch">
          Remembered it? <span className="link-as-btn" onClick={() => navigate('/login')}>Back to login</span>
        </p>
      </div>
    </div>
  );
}