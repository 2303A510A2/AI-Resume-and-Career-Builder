const mongoose = require('mongoose');

// One document per chunk of the user's knowledge base (resume, job description, career context).
// userId filtering is mandatory for every RAG query - a user must never see another
// user's private documents.
const ragDocumentSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    source: {
      type: String,
      enum: ['resume', 'job', 'career', 'document'],
      required: true,
      index: true,
    },
    section: { type: String, required: true }, // skills, education, projects, experience, certifications, requirements, responsibilities, ...
    text: { type: String, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    embedding: { type: [Number], default: undefined, select: false }, // set when an embedding provider is configured
  },
  { timestamps: true }
);

// Text index for the keyword-search fallback when embeddings are unavailable.
ragDocumentSchema.index({ userId: 1, text: 'text' });
ragDocumentSchema.index({ userId: 1, source: 1 });

module.exports = mongoose.model('RAGDocument', ragDocumentSchema);