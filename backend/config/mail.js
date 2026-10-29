// Mail transport factory. Supports real SMTP delivery, or "console" delivery
// (prints the email to the terminal) when no SMTP credentials are configured.
const nodemailer = require('nodemailer');

const isSmtpConfigured = () =>
  Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD);

const getTransport = () => {
  if (!isSmtpConfigured()) return null;
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: Number(process.env.EMAIL_PORT || 587),
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
  });
};

const consoleTransport = {
  async sendMail({ to, subject, html }) {
    console.log('\n📧 [MAIL - console mode] =================================');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log('Body (HTML stripped):');
    console.log(
      html
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
    console.log('===========================================================\n');
  },
};

module.exports = {
  isSmtpConfigured,
  getTransport,
  consoleTransport,
};