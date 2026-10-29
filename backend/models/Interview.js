const mongoose = require('mongoose');

const questionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    category: { type: String, default: 'general' },
    expectedPoints: { type: [String], default: [] }, // points a good answer should cover
  },
  { _id: false }
);

const answerSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    answer: { type: String, default: '' },
    feedback: { type: String, default: '' },
    scores: {
      relevance: { type: Number, default: 0 },
      technicalCoverage: { type: Number, default: 0 },
      clarity: { type: Number, default: 0 },
      structure: { type: Number, default: 0 },
      missingPoints: { type: [String], default: [] },
    },
  },
  { _id: false }
);

const interviewSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['questions', 'mock'], required: true },
    category: { type: String, default: 'general' },
    title: { type: String, default: 'Interview Session' },
    status: { type: String, enum: ['pending', 'in-progress', 'completed'], default: 'pending' },
    questions: [questionSchema],
    answers: [answerSchema],
    currentIndex: { type: Number, default: 0 },
    overallFeedback: { type: String, default: '' },
    averageScore: { type: Number, default: 0 },
  },
  { timestamps: true }
);

interviewSchema.index({ userId: 1, updatedAt: -1 });

module.exports = mongoose.model('Interview', interviewSchema);