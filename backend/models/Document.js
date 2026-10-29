const mongoose = require('mongoose');

// Generic uploaded document (resume, job description, or other reference file).
// Every document is owned by a userId; every read is ownership-validated
// (a user must never access another user's documents).
const documentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', default: null, index: true },

    fileName: { type: String, required: true, trim: true },
    mimeType: { type: String, default: '' },
    extension: { type: String, enum: ['pdf', 'doc', 'docx', 'txt', 'png', 'jpg', 'jpeg'], required: true },
    size: { type: Number, required: true },

    // resume | jd | document — drives how the file feeds the career assistant.
    category: { type: String, enum: ['resume', 'jd', 'document'], default: 'document' },

    // Extracted text (server-side). Kept out of default queries.
    text: { type: String, default: '', select: false },

    // Base64 data URL of an attached image (PNG/JPG) kept for AI vision analysis.
    // Only present when the image is small enough (LLM_VISION_MAX_IMAGE_BYTES) and
    // vision is configured. Kept out of default queries like `text`.
    imageData: { type: String, default: '', select: false },

    // uploaded (stored, extraction not yet possible) | ready (text extracted) | failed (extraction error)
    status: { type: String, enum: ['uploaded', 'ready', 'failed'], default: 'uploaded' },
    processingNote: { type: String, default: '' },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

documentSchema.index({ userId: 1, createdAt: -1 });

// Helper: map a raw upload to the safe "document" projection returned to clients.
documentSchema.methods.toClientJSON = function toClientJSON() {
  return {
    id: this._id,
    fileName: this.fileName,
    mimeType: this.mimeType,
    extension: this.extension,
    size: this.size,
    category: this.category,
    status: this.status,
    processingNote: this.processingNote,
    // True when a vision-ready image was stored (never includes the raw data here).
    ...(this.imageData ? { hasImage: true } : {}),
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('Document', documentSchema);