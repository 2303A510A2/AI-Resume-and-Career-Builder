import { useState, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { verifyOtp } from '../services/authService';
import { useToast } from '../hooks/useToast';

export default function VerifyOTP() {
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();
  const email = location.state?.email || localStorage.getItem('resetEmail') || '';

  const [digits, setDigits] = useState(Array(6).fill(''));
  const [loading, setLoading] = useState(false);
  const refs = useRef([]);

  const handleChange = (i, value) => {
    const v = value.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[i] = v;
    setDigits(next);
    if (v && i < 5) refs.current[i + 1]?.focus();
  };

  const handleKeyDown = (i, e) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
  };

  const handlePaste = (e) => {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (text.length === 6) {
      e.preventDefault();
      setDigits(text.split(''));
      refs.current[5]?.focus();
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const otp = digits.join('');
    if (otp.length !== 6) {
      showToast('Please enter the 6-digit OTP.', 'error');
      return;
    }
    if (!email) {
      showToast('Session expired. Please request a new OTP.', 'error');
      navigate('/forgot-password');
      return;
    }
    setLoading(true);
    try {
      const { data } = await verifyOtp(email, otp);
      localStorage.setItem('resetEmail', email);
      showToast('OTP verified successfully');
      navigate('/reset-password', { state: { resetToken: data.resetToken } });
    } catch (err) {
      showToast(err.message || 'Invalid OTP', 'error');
      setDigits(Array(6).fill(''));
      refs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card glass-card fade-up">
        <div className="auth-head">
          <span className="auth-icon"><ShieldCheck size={22} /></span>
          <h1>Verify your OTP</h1>
          <p className="muted">
            Enter the 6-digit code sent to {email || 'your email'}.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="form" noValidate onPaste={handlePaste}>
          <div className="otp-row" role="group" aria-label="6-digit OTP">
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => (refs.current[i] = el)}
                className="otp-input"
                inputMode="numeric"
                maxLength={1}
                value={d}
                aria-label={`Digit ${i + 1}`}
                onChange={(e) => handleChange(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
              />
            ))}
          </div>

          <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
            {loading ? <><Loader2 size={18} className="spin" /> Verifying...</> : 'Verify OTP'}
          </button>
        </form>

        <p className="auth-switch">
          <span className="link-as-btn" onClick={() => navigate('/forgot-password')}>Resend / new OTP</span>
        </p>
      </div>
    </div>
  );
}