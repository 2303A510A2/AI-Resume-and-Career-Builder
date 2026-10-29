const Notification = require('../models/Notification');
const { sendMail } = require('./emailService');

// Best-effort notification delivery. Creating an in-app notification is the
// primary action; an optional email is attempted through the existing email
// service (SMTP when configured, console in development). A delivery failure
// must NEVER break the administrative action that triggered it.
const notify = async ({ userId, type = 'info', title, body = '', link = '', email = '', emailSubject = '' }) => {
  let doc = null;
  try {
    doc = await Notification.create({ userId, type, title, body, link });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notify] in-app notification failed:', err.message);
  }
  if (email && emailSubject) {
    try {
      await sendMail({
        to: email,
        subject: emailSubject,
        text: body,
        html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111"><h2 style="margin:0 0 8px">${title}</h2><p style="margin:0">${body}</p></div>`,
      });
    } catch (err) {
      // Email is optional (a spent/unconfigured provider must not fail the action).
      // eslint-disable-next-line no-console
      console.error('[notify] email notification skipped:', err.message);
    }
  }
  return doc;
};

const list = (userId, { limit = 20 } = {}) =>
  Notification.find({ userId }).sort({ createdAt: -1 }).limit(Math.min(50, Math.max(1, limit)));

const unreadCount = (userId) => Notification.countDocuments({ userId, read: false });

const markRead = (userId, id) => Notification.updateOne({ _id: id, userId }, { $set: { read: true } });

const markAllRead = (userId) => Notification.updateMany({ userId, read: false }, { $set: { read: true } });

module.exports = { notify, list, unreadCount, markRead, markAllRead };
