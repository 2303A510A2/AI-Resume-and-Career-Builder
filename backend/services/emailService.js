const { getTransport, consoleTransport, isSmtpConfigured } = require('../config/mail');

/** Sends an email via SMTP, or falls back to console delivery in development. */
const sendMail = async ({ to, subject, html, text }) => {
  const payload = { to, subject, html, text };

  if (isSmtpConfigured()) {
    const transport = getTransport();
    const from = process.env.MAIL_FROM || `"AI Resume & Career Builder" <${process.env.EMAIL_USER}>`;
    await transport.sendMail({ from, ...payload });
    return { delivered: 'smtp' };
  }

  // Development mode: print the email instead of sending it.
  if (process.env.NODE_ENV !== 'production') {
    await consoleTransport.sendMail(payload);
    return { delivered: 'console' };
  }

  const err = new Error('Email service is not configured (EMAIL_USER / EMAIL_PASSWORD)');
  err.statusCode = 500;
  err.isOperational = true;
  throw err;
};

const brand = {
  name: 'AI Resume & Career Builder',
  logo: '🚀',
};

const otpEmailHtml = (otp, minutes) => `
<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#0b1020;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b1020;padding:24px;">
      <tr><td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#141a33;border:1px solid #2b3352;border-radius:16px;overflow:hidden;">
          <tr style="background:linear-gradient(135deg,#4f46e5,#7c3aed);">
            <td align="center" style="padding:28px 24px;">
              <div style="font-size:30px;">${brand.logo}</div>
              <div style="color:#ffffff;font-size:20px;font-weight:bold;margin-top:6px;">${brand.name}</div>
            </td>
          </tr>
          <tr><td style="padding:32px 28px;color:#e5e7eb;">
            <p style="margin:0 0 12px;font-size:15px;">Your password reset OTP is:</p>
            <div style="background:#0b1020;border:1px solid #2b3352;border-radius:12px;padding:18px;text-align:center;font-size:34px;font-weight:bold;letter-spacing:10px;color:#a78bfa;margin:8px 0 20px;">${otp}</div>
            <p style="margin:0 0 8px;font-size:14px;color:#9ca3af;">This OTP will expire in about ${minutes} minutes.</p>
            <p style="margin:0 0 20px;font-size:14px;color:#9ca3af;">If you did not request this, you can safely ignore this email.</p>
            <p style="margin:0;font-size:12px;color:#6b7280;">— The ${brand.name} Team</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

const sendOTPEmail = (email, otp, minutes = 10) =>
  sendMail({
    to: email,
    subject: `Your Password Reset OTP - ${brand.name}`,
    html: otpEmailHtml(otp, minutes),
    text: `Your password reset OTP is: ${otp}\nThis OTP will expire in about ${minutes} minutes.\nIf you did not request this, ignore this email.`,
  });

module.exports = { sendMail, sendOTPEmail };