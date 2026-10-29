const mongoose = require('mongoose');

// A single in-app notification delivered to ONE user. Every field here is real:
// notifications are created by genuine administrative events (an access request
// was approved/rejected, etc.) and are read back by the recipient. No fabricated
// notifications are ever stored.
const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, default: 'info', maxlength: 40 },
    title: { type: String, required: true, maxlength: 140 },
    body: { type: String, default: '', maxlength: 500 },
    // A deep link the client may use (e.g. '#/admin/access'). Never a secret.
    link: { type: String, default: '', maxlength: 200 },
    read: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, read: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
