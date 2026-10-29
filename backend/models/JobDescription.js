const mongoose = require('mongoose');

const jobDescriptionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    jobTitle: { type: String, required: true, trim: true, maxlength: 200 },
    company: { type: String, default: '', trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true },

    // Parsed from the JD text. Only contains content actually found in the JD.
    parsed: {
      requiredSkills: { type: [String], default: [] },
      preferredSkills: { type: [String], default: [] },
      responsibilities: { type: [String], default: [] },
      qualifications: { type: [String], default: [] },
      technologies: { type: [String], default: [] },
      experienceLevel: { type: String, default: '' },
      educationRequirement: { type: String, default: '' },
    },
    parsedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('JobDescription', jobDescriptionSchema);