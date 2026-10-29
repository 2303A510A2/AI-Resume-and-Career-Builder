const mongoose = require('mongoose');

// Lightweight, real operational counters. One document per UTC day. Updated from
// actual request outcomes (never fabricated): AI request totals/success/failure
// and quota (429) errors, plus resume/document processing failures.
const usageStatSchema = new mongoose.Schema(
  {
    date: { type: String, unique: true, index: true }, // YYYY-MM-DD (UTC)
    aiTotal: { type: Number, default: 0 },
    aiSuccess: { type: Number, default: 0 },
    aiFailure: { type: Number, default: 0 },
    aiQuotaErrors: { type: Number, default: 0 },
    resumeFailures: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('UsageStat', usageStatSchema);
