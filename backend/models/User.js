const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Full name is required'], trim: true, maxlength: 100 },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please provide a valid email'],
    },
    password: { type: String, required: true, minlength: 6, select: false },
    // Authorization roles are EXPLICIT and server-controlled:
    //   user       - an ordinary account
    //   co_admin   - an approved administrator with a permission set
    //   main_admin - the single Main Admin Leader (full control)
    // No client payload may ever set this field (see authController/adminController).
    role: { type: String, enum: ['user', 'co_admin', 'main_admin'], default: 'user', index: true },
    profile: {
      title: { type: String, default: '' },
      company: { type: String, default: '' },
      location: { type: String, default: '' },
      bio: { type: String, default: '', maxlength: 500 },
      skills: { type: [String], default: [] },
      // Profile photo, stored as a small base64 data URL (the client downscales
      // it before upload; the controller enforces a hard size + mime cap). This
      // mirrors the existing `Document.imageData` approach — bytes are never
      // served from a public URL and never reach another user.
      avatar: { type: String, default: '' },
      preferences: {
        targetRoles: { type: [String], default: [] },
        industries: { type: [String], default: [] },
      },
    },
    // User-facing settings. Every field here is REAL: it is persisted and either
    // changes server behaviour (chat response style / language) or is consumed by
    // the clients (theme, enter-to-send, confirm-delete, voice playback). Nothing
    // here is a decorative toggle.
    settings: {
      appearance: {
        theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
        accent: { type: String, enum: ['violet', 'pink', 'indigo', 'teal', 'amber'], default: 'violet' },
      },
      chat: {
        enterToSend: { type: Boolean, default: true },
        confirmDelete: { type: Boolean, default: true },
        responseStyle: { type: String, enum: ['concise', 'balanced', 'detailed'], default: 'balanced' },
        language: { type: String, default: 'auto', maxlength: 40 },
        voicePlayback: { type: Boolean, default: false },
      },
      notifications: {
        // Product/feature emails are OPT-IN consent only. Security/account email
        // (OTP, password reset) is always sent and is not user-toggleable.
        product: { type: Boolean, default: false },
      },
    },
    lastActiveAt: { type: Date },
    isActive: { type: Boolean, default: true },

    // ---- Admin fields (only meaningful for co_admin / main_admin) ----
    // A newly bootstrapped/approved administrator must change the initial
    // password before any normal admin operation is allowed (enforced on the
    // backend by requirePasswordChanged, not just in the UI).
    mustChangePassword: { type: Boolean, default: false },
    // Monotonic version embedded in admin JWTs (`av`). Incrementing it revokes
    // every existing admin session for this account (used by "revoke access" /
    // "sign out everywhere"). Stateless-JWT-safe session invalidation.
    adminTokenVersion: { type: Number, default: 0 },
    // Per-co-admin permission set. main_admin implicitly has ALL permissions,
    // so these flags are only consulted for co_admin accounts.
    adminPermissions: {
      manageUsers: { type: Boolean, default: false },
      deleteUsers: { type: Boolean, default: false },
      manageResumes: { type: Boolean, default: false },
      manageRequests: { type: Boolean, default: false },
      viewAudit: { type: Boolean, default: false },
      manageSettings: { type: Boolean, default: false },
    },
    adminApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    adminApprovedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    suspendReason: { type: String, default: '', maxlength: 300 },
  },
  { timestamps: true }
);

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

userSchema.methods.matchPassword = function (entered) {
  return bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model('User', userSchema);