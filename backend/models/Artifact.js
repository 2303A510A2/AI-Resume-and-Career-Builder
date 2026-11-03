const mongoose = require('mongoose');

const artifactSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 1000 },
    artifactType: { type: String, enum: ['document', 'resume', 'report', 'presentation', 'spreadsheet', 'data'], default: 'document' },
    mimeType: { type: String, required: true },
    extension: { type: String, required: true, lowercase: true },
    objectKey: { type: String, required: true, unique: true },
    storageProvider: { type: String, enum: ['local'], default: 'local' },
    fileSize: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['ready', 'failed'], default: 'ready' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

artifactSchema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.model('Artifact', artifactSchema);
