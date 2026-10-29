const mongoose = require('mongoose');

const resumeSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    fileName: { type: String, required: true, trim: true },
    fileType: { type: String, enum: ['pdf', 'docx', 'txt', 'doc'], required: true },
    fileSize: { type: Number, required: true },
    originalText: { type: String, default: '', select: false },

    // Heuristic extraction - only contains information actually found in the resume.
    parsed: {
      name: { type: String, default: '' },
      contact: {
        email: { type: String, default: '' },
        phone: { type: String, default: '' },
        linkedin: { type: String, default: '' },
        github: { type: String, default: '' },
        location: { type: String, default: '' },
      },
      summary: { type: String, default: '' },
      skills: { type: [String], default: [] },
      programmingLanguages: { type: [String], default: [] },
      frameworks: { type: [String], default: [] },
      libraries: { type: [String], default: [] },
      tools: { type: [String], default: [] },
      education: { type: [], default: [] },
      projects: { type: [], default: [] },
      experience: { type: [], default: [] },
      internships: { type: [], default: [] },
      certifications: { type: [String], default: [] },
      achievements: { type: [String], default: [] },
    },

    // Career analysis result (resume + job description comparison)
    analysis: {
      jobTitle: { type: String, default: '' },
      company: { type: String, default: '' },
      matchPercent: { type: Number, default: 0 },
      requiredSkills: { type: [String], default: [] },
      preferredSkills: { type: [String], default: [] },
      matchedSkills: { type: [String], default: [] },
      missingSkills: { type: [String], default: [] },
      prioritySkills: { type: [String], default: [] },
      additionalSkills: { type: [String], default: [] },
      strengths: { type: [String], default: [] },
      summary: { type: String, default: '' },
      analyzedAt: { type: Date },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Resume', resumeSchema);