const Resume = require('../models/Resume');
const JobDescription = require('../models/JobDescription');
const RAGDocument = require('../models/RAGDocument');
const { parseResume } = require('../services/resumeParser');
const { syncKnowledgeBase } = require('../services/ragService');
const { analyzeCareer } = require('../services/careerService');
const { improveResumeSection } = require('../services/careerService');

// @desc   Upload / replace resume, parse it, rebuild the user's RAG knowledge base
// @route  POST /api/resume/upload
const uploadResume = async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const { text, parsed, extension } = await parseResume({
    buffer: file.buffer,
    extension: file.extension,
    mimetype: file.mimetype,
  });

  const job = await JobDescription.findOne({ userId: req.user.id });

  const resume = await Resume.findOneAndUpdate(
    { userId: req.user.id },
    {
      userId: req.user.id,
      fileName: file.originalname,
      fileType: extension,
      fileSize: file.size,
      originalText: text,
      parsed,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const ragInfo = await syncKnowledgeBase({ userId: req.user.id, resume, job });

  let analysis = resume.analysis || null;
  if (job) {
    analysis = await analyzeCareer({ resumeModel: resume, jobModel: job });
  }

  res.status(201).json({
    success: true,
    message: job
      ? 'Resume uploaded and analyzed against your target job.'
      : 'Resume uploaded and parsed. Add a job description to unlock career analysis.',
    resume: {
      _id: resume._id,
      fileName: resume.fileName,
      fileType: resume.fileType,
      fileSize: resume.fileSize,
      parsed: resume.parsed,
      analysis,
    },
    rag: ragInfo,
  });
};

// @desc   Get the user's resume
// @route  GET /api/resume
const getResume = async (req, res) => {
  const resume = await Resume.findOne({ userId: req.user.id });
  if (!resume) {
    return res.status(404).json({ success: false, message: 'No resume found. Upload your resume first.' });
  }
  res.json({ success: true, resume });
};

// @desc   Delete the user's resume + related knowledge base chunks
// @route  DELETE /api/resume
const deleteResume = async (req, res) => {
  const resume = await Resume.findOneAndDelete({ userId: req.user.id });
  if (!resume) {
    return res.status(404).json({ success: false, message: 'No resume found to delete' });
  }
  await RAGDocument.deleteMany({ userId: req.user.id, source: 'resume' });
  res.json({ success: true, message: 'Resume deleted' });
};

// @desc   Improve a resume section (AI, truthful rewriting only)
// @route  POST /api/resume/improve
const improveResume = async (req, res) => {
  const { feature, text } = req.body || {};
  if (!feature || !text || !String(text).trim()) {
    return res.status(400).json({ success: false, message: 'feature and text are required' });
  }

  const resume = await Resume.findOne({ userId: req.user.id });
  const job = await JobDescription.findOne({ userId: req.user.id });

  const result = await improveResumeSection({
    feature,
    originalText: String(text),
    resume,
    job,
  });

  res.json({ success: true, ...result });
};

module.exports = { uploadResume, getResume, deleteResume, improveResume };