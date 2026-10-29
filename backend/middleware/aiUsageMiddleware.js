const usageService = require('../services/usageService');
const settingsService = require('../services/settingsService');
const { ADMIN_ROLES } = require('./adminMiddleware');

// Counts every AI call from its real HTTP outcome (success/failure/quota) so the
// admin dashboard shows measured usage, never fabricated numbers. Hooked on
// response finish; never throws.
const trackAiUsage = (req, res, next) => {
  if (req.method !== 'POST') return next();
  res.on('finish', () => {
    usageService.trackAi(res.statusCode).catch(() => {});
  });
  return next();
};

// Per-user per-minute AI limit (in-memory, bounded). Real enforcement of the
// admin-configured aiLimits.perMinuteUserLimit. Admins are always exempt.
const minuteHits = new Map(); // userId -> number[] (epoch ms)
const MINUTE = 60 * 1000;

const perMinuteExceeded = (userId, limit) => {
  const now = Date.now();
  const prev = (minuteHits.get(userId) || []).filter((t) => now - t < MINUTE);
  if (prev.length >= limit) {
    minuteHits.set(userId, prev);
    return true;
  }
  prev.push(now);
  minuteHits.set(userId, prev);
  if (minuteHits.size > 5000) {
    // Bound memory: drop the oldest entries.
    for (const k of minuteHits.keys()) {
      minuteHits.delete(k);
      if (minuteHits.size <= 2500) break;
    }
  }
  return false;
};

/**
 * Enforces the admin-configured AI usage limits BEFORE the request reaches the
 * provider. Must run AFTER protect() (it needs req.userRecord). Admins are
 * exempt so an operator can never lock themselves out of the product.
 */
const enforceAiLimits = async (req, res, next) => {
  try {
    const rec = req.userRecord;
    if (rec && ADMIN_ROLES.includes(rec.role)) return next();

    const settings = await settingsService.getSettings();
    const daily = Number(settings.aiLimits.dailyRequestLimit) || 0;
    const perMinute = Number(settings.aiLimits.perMinuteUserLimit) || 0;

    if (perMinute > 0 && rec && rec._id && perMinuteExceeded(String(rec._id), perMinute)) {
      return res.status(429).json({
        success: false,
        code: 'AI_RATE_LIMITED',
        retryable: true,
        message: 'You have reached the per-minute AI usage limit. Please try again in a moment.',
      });
    }

    if (daily > 0) {
      const total = await usageService.getTodayAiTotal();
      if (total >= daily) {
        return res.status(429).json({
          success: false,
          code: 'AI_DAILY_LIMIT',
          retryable: false,
          message: "The administrator's daily AI usage limit has been reached. Please try again tomorrow.",
        });
      }
    }
    return next();
  } catch {
    return next();
  }
};

module.exports = { trackAiUsage, enforceAiLimits };
