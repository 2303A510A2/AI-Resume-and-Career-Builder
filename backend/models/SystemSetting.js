const mongoose = require('mongoose');

// A single global settings document (key = 'global'). Every field is REAL and
// consumed by the running backend: upload caps, AI usage limits and maintenance
// mode actually change behaviour. No decorative toggles.
const systemSettingSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: 'global' },

    uploadLimits: {
      resumeMaxMB: { type: Number, default: 10, min: 1, max: 50 },
    },

    aiLimits: {
      // 0 = unlimited. When > 0, the backend rejects an ordinary user's AI
      // request once the GLOBAL count of AI requests for the current day
      // reaches this number. Admins are exempt so they can always operate.
      dailyRequestLimit: { type: Number, default: 0, min: 0, max: 1000000 },
      // 0 = unlimited. When > 0, a single ordinary user may make at most N AI
      // requests per minute (in addition to the global limiter).
      perMinuteUserLimit: { type: Number, default: 0, min: 0, max: 1000 },
    },

    maintenanceMode: {
      // When enabled, ordinary API traffic returns 503 with the message below.
      // Admin, auth and health routes stay reachable so the operator can turn
      // it back off and users can still authenticate.
      enabled: { type: Boolean, default: false },
      message: { type: String, default: 'The service is temporarily under maintenance. Please try again shortly.', maxlength: 300 },
    },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemSetting', systemSettingSchema);
