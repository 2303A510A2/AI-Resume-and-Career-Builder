const mongoose = require('mongoose');

// An ordinary user's request to become an administrator. A request NEVER grants
// admin access by itself: it only records intent. Only the Main Admin Leader may
// approve it, and approval is what flips User.role to `co_admin`.
const adminRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, default: '', trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    reason: { type: String, required: true, trim: true, maxlength: 500 },

    status: { type: String, enum: ['pending', 'approved', 'rejected', 'revoked'], default: 'pending', index: true },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedByEmail: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true }
);

// At most ONE pending request per user. The partial unique index makes a
// duplicate/concurrent request fail at the database level, not just in code.
adminRequestSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);
adminRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('AdminRequest', adminRequestSchema);
