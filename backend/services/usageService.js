const mongoose = require('mongoose');
const UsageStat = require('../models/UsageStat');

// True only when a real query can run. Mongoose BUFFERS queries while the
// connection is down (10s default) instead of failing fast, so any hot-path
// counter read must short-circuit to zero rather than stall the request.
const dbReady = () => mongoose.connection.readyState === 1;

// Real operational counters. Every update is a best-effort, non-blocking write;
// a metrics failure must never affect a user request.
const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

const bump = async (fields) => {
  if (!dbReady()) return;
  try {
    const inc = {};
    for (const [k, v] of Object.entries(fields)) inc[k] = v;
    await UsageStat.updateOne({ date: utcDay() }, { $inc: inc }, { upsert: true });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[usage] counter update failed:', err.message);
  }
};

const trackAi = (statusCode, code = '') => {
  const failed = statusCode >= 400;
  const quota = failed && (statusCode === 429 || /RATE_LIMIT|DAILY_LIMIT|QUOTA/i.test(String(code)));
  return bump({
    aiTotal: 1,
    aiSuccess: failed ? 0 : 1,
    aiFailure: failed ? 1 : 0,
    ...(quota ? { aiQuotaErrors: 1 } : {}),
  });
};

const trackResumeFailure = () => bump({ resumeFailures: 1 });

const getToday = async () => {
  if (!dbReady()) {
    return { date: utcDay(), aiTotal: 0, aiSuccess: 0, aiFailure: 0, aiQuotaErrors: 0, resumeFailures: 0 };
  }
  try {
    const doc = await UsageStat.findOne({ date: utcDay() });
    return doc ? doc.toObject() : { date: utcDay(), aiTotal: 0, aiSuccess: 0, aiFailure: 0, aiQuotaErrors: 0, resumeFailures: 0 };
  } catch {
    return { date: utcDay(), aiTotal: 0, aiSuccess: 0, aiFailure: 0, aiQuotaErrors: 0, resumeFailures: 0 };
  }
};

const getTotals = async () => {
  if (!dbReady()) return { aiTotal: 0, aiSuccess: 0, aiFailure: 0, aiQuotaErrors: 0, resumeFailures: 0 };
  try {
    const rows = await UsageStat.aggregate([
      { $group: { _id: null, aiTotal: { $sum: '$aiTotal' }, aiSuccess: { $sum: '$aiSuccess' }, aiFailure: { $sum: '$aiFailure' }, aiQuotaErrors: { $sum: '$aiQuotaErrors' }, resumeFailures: { $sum: '$resumeFailures' } } },
    ]);
    return rows[0] || { aiTotal: 0, aiSuccess: 0, aiFailure: 0, aiQuotaErrors: 0, resumeFailures: 0 };
  } catch {
    return { aiTotal: 0, aiSuccess: 0, aiFailure: 0, aiQuotaErrors: 0, resumeFailures: 0 };
  }
};

/** Count of AI requests so far today (used for the configurable daily limit). */
const getTodayAiTotal = async () => {
  const t = await getToday();
  return Number(t.aiTotal) || 0;
};

module.exports = { trackAi, trackResumeFailure, getToday, getTotals, getTodayAiTotal, utcDay };
