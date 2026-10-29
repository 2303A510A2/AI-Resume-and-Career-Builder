const mongoose = require('mongoose');
const SystemSetting = require('../models/SystemSetting');

// System settings are read on hot paths (maintenance check, AI limit check), so a
// tiny in-process cache avoids a DB round-trip per request. Invalidated whenever
// the settings are updated through the admin API.
const CACHE_MS = 5000;
let cache = null;
let cachedAt = 0;

const DEFAULTS = {
  uploadLimits: { resumeMaxMB: 10 },
  aiLimits: { dailyRequestLimit: 0, perMinuteUserLimit: 0 },
  maintenanceMode: { enabled: false, message: 'The service is temporarily under maintenance. Please try again shortly.' },
};

const normalize = (doc) => {
  const s = doc ? doc.toObject() : {};
  return {
    uploadLimits: { resumeMaxMB: (s.uploadLimits && s.uploadLimits.resumeMaxMB) ?? DEFAULTS.uploadLimits.resumeMaxMB },
    aiLimits: {
      dailyRequestLimit: (s.aiLimits && s.aiLimits.dailyRequestLimit) ?? DEFAULTS.aiLimits.dailyRequestLimit,
      perMinuteUserLimit: (s.aiLimits && s.aiLimits.perMinuteUserLimit) ?? DEFAULTS.aiLimits.perMinuteUserLimit,
    },
    maintenanceMode: {
      enabled: Boolean(s.maintenanceMode && s.maintenanceMode.enabled),
      message: (s.maintenanceMode && s.maintenanceMode.message) || DEFAULTS.maintenanceMode.message,
    },
    updatedAt: s.updatedAt || null,
  };
};

/** Read settings (cached). Falls back to defaults if the DB is unavailable. */
const getSettings = async ({ fresh = false } = {}) => {
  const now = Date.now();
  if (!fresh && cache && now - cachedAt < CACHE_MS) return cache;
  // CRITICAL: never issue a query while MongoDB is down. Mongoose BUFFERS a
  // query until the connection returns (10s default) instead of failing, so an
  // unguarded read here would hang EVERY request that consults settings — health
  // checks included — and take the whole API offline whenever the database was
  // briefly unreachable. The documented contract is "the API stays online and
  // reports mongodb: disconnected", so a disconnected database means defaults.
  if (mongoose.connection.readyState !== 1) {
    return cache || { ...DEFAULTS, updatedAt: null };
  }
  try {
    let doc = await SystemSetting.findOne({ key: 'global' });
    if (!doc) doc = await SystemSetting.create({ key: 'global' });
    cache = normalize(doc);
    cachedAt = now;
    return cache;
  } catch {
    return cache || { ...DEFAULTS, updatedAt: null };
  }
};

/** Persist a partial settings update and invalidate the cache. */
const updateSettings = async (patch = {}, updatedBy = null) => {
  const doc = (await SystemSetting.findOne({ key: 'global' })) || new SystemSetting({ key: 'global' });
  if (patch.uploadLimits && typeof patch.uploadLimits === 'object') {
    if (patch.uploadLimits.resumeMaxMB != null) {
      doc.uploadLimits.resumeMaxMB = Math.min(50, Math.max(1, Number(patch.uploadLimits.resumeMaxMB) || DEFAULTS.uploadLimits.resumeMaxMB));
    }
  }
  if (patch.aiLimits && typeof patch.aiLimits === 'object') {
    if (patch.aiLimits.dailyRequestLimit != null) {
      doc.aiLimits.dailyRequestLimit = Math.min(1000000, Math.max(0, Number(patch.aiLimits.dailyRequestLimit) || 0));
    }
    if (patch.aiLimits.perMinuteUserLimit != null) {
      doc.aiLimits.perMinuteUserLimit = Math.min(1000, Math.max(0, Number(patch.aiLimits.perMinuteUserLimit) || 0));
    }
  }
  if (patch.maintenanceMode && typeof patch.maintenanceMode === 'object') {
    if (patch.maintenanceMode.enabled != null) doc.maintenanceMode.enabled = Boolean(patch.maintenanceMode.enabled);
    if (patch.maintenanceMode.message != null) {
      doc.maintenanceMode.message = String(patch.maintenanceMode.message).slice(0, 300) || DEFAULTS.maintenanceMode.message;
    }
  }
  doc.updatedBy = updatedBy || doc.updatedBy;
  await doc.save();
  cache = normalize(doc);
  cachedAt = Date.now();
  return cache;
};

const invalidate = () => { cache = null; cachedAt = 0; };

module.exports = { getSettings, updateSettings, invalidate, DEFAULTS };
