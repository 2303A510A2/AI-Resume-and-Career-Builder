const Resume = require('../models/Resume');
const JobDescription = require('../models/JobDescription');
const Roadmap = require('../models/Roadmap');
const RAGDocument = require('../models/RAGDocument');
const { parseJob } = require('../services/jobParser');
const { syncKnowledgeBase } = require('../services/ragService');
const {
  analyzeCareer,
  computeSkillGap,
  generateRoadmap,
  updateRoadmapProgress,
  generateCodingProblems,
} = require('../services/careerService');

// ---- Job description ----

// @route  POST /api/career/jobs  (spec: POST /api/jobs)
const saveJob = async (req, res) => {
  const { jobTitle, company = '', description } = req.body || {};
  if (!jobTitle || !String(jobTitle).trim()) {
    return res.status(400).json({ success: false, message: 'Job title is required' });
  }
  if (!description || !String(description).trim()) {
    return res.status(400).json({ success: false, message: 'Job description is required' });
  }

  const parsed = parseJob({ jobTitle, company, description });

  const job = await JobDescription.findOneAndUpdate(
    { userId: req.user.id },
    { userId: req.user.id, jobTitle: jobTitle.trim(), company: company.trim(), description, parsed, parsedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const resume = await Resume.findOne({ userId: req.user.id });
  let analysis = null;
  if (resume) {
    analysis = await analyzeCareer({ resumeModel: resume, jobModel: job });
    await syncKnowledgeBase({ userId: req.user.id, resume, job });
  } else {
    await syncKnowledgeBase({ userId: req.user.id, resume, job });
  }

  res.status(201).json({
    success: true,
    message: resume ? 'Job description saved and analyzed against your resume.' : 'Job description saved. Upload your resume to unlock analysis.',
    job: { ...job.toObject(), parsed },
    analysis,
  });
};

// @route  GET /api/career/jobs
const getJob = async (req, res) => {
  const job = await JobDescription.findOne({ userId: req.user.id });
  if (!job) return res.status(404).json({ success: false, message: 'No job description found' });
  res.json({ success: true, job });
};

// @route  DELETE /api/career/jobs
const deleteJob = async (req, res) => {
  const job = await JobDescription.findOneAndDelete({ userId: req.user.id });
  if (!job) return res.status(404).json({ success: false, message: 'No job description found to delete' });

  await RAGDocument.deleteMany({ userId: req.user.id, source: 'job' });

  // Clear the analysis on the resume (job is gone).
  const resume = await Resume.findOne({ userId: req.user.id });
  if (resume) {
    resume.analysis = undefined;
    await resume.save();
  }

  res.json({ success: true, message: 'Job description deleted' });
};

// ---- Analysis & skill gap ----

// @route  POST /api/career/analyze
const analyze = async (req, res) => {
  const resume = await Resume.findOne({ userId: req.user.id });
  const job = await JobDescription.findOne({ userId: req.user.id });

  if (!resume) {
    return res.status(400).json({ success: false, message: 'Upload your resume before analyzing.' });
  }
  if (!job) {
    return res.status(400).json({ success: false, message: 'Add a job description before analyzing.' });
  }

  const analysis = await analyzeCareer({ resumeModel: resume, jobModel: job });
  const ragInfo = await syncKnowledgeBase({ userId: req.user.id, resume, job });

  res.json({ success: true, analysis, rag: ragInfo });
};

// @route  GET /api/career/skill-gap
const skillGap = async (req, res) => {
  const resume = await Resume.findOne({ userId: req.user.id });
  const job = await JobDescription.findOne({ userId: req.user.id });

  if (!resume || !job) {
    return res.status(400).json({
      success: false,
      message: resume ? 'Add a job description to see your skill gap.' : 'Upload your resume to see your skill gap.',
    });
  }

  const gap = computeSkillGap({
    resumeSkills: resume.parsed?.skills || [],
    requiredSkills: job.parsed?.requiredSkills || [],
    preferredSkills: job.parsed?.preferredSkills || [],
  });

  res.json({
    success: true,
    gap,
    resumeSkills: resume.parsed?.skills || [],
    jobTitle: job.jobTitle,
  });
};

// ---- Roadmap ----

// @route  POST /api/career/roadmap/generate
const roadmapGenerate = async (req, res) => {
  const resume = await Resume.findOne({ userId: req.user.id });
  const job = await JobDescription.findOne({ userId: req.user.id });
  if (!resume || !job) {
    return res.status(400).json({ success: false, message: 'Upload your resume and add a job description first.' });
  }
  const roadmap = await generateRoadmap({ userId: req.user.id, resume, job });
  res.status(201).json({ success: true, roadmap });
};

// @route  GET /api/career/roadmap
const roadmapGet = async (req, res) => {
  const roadmap = await Roadmap.findOne({ userId: req.user.id });
  if (!roadmap) return res.status(404).json({ success: false, message: 'No roadmap yet. Generate one first.' });
  res.json({ success: true, roadmap });
};

// @route  PUT /api/career/roadmap/progress
const roadmapProgress = async (req, res) => {
  const { phaseIndex, topicIndex, status } = req.body || {};
  if (!['not-started', 'in-progress', 'completed'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Invalid status' });
  }
  const roadmap = await updateRoadmapProgress({
    userId: req.user.id,
    phaseIndex: Number(phaseIndex),
    topicIndex: Number(topicIndex),
    status,
  });
  res.json({ success: true, roadmap });
};

// @route  DELETE /api/career/roadmap
const roadmapDelete = async (req, res) => {
  await Roadmap.findOneAndDelete({ userId: req.user.id });
  res.json({ success: true, message: 'Roadmap cleared' });
};

// ---- Coding preparation ----

// @route  POST /api/career/coding/generate
const codingGenerate = async (req, res) => {
  const { topic, difficulty } = req.body || {};
  if (!topic || !['Easy', 'Medium', 'Hard'].includes(difficulty)) {
    return res.status(400).json({ success: false, message: 'topic and a valid difficulty (Easy/Medium/Hard) are required' });
  }
  const resume = await Resume.findOne({ userId: req.user.id });
  const job = await JobDescription.findOne({ userId: req.user.id });
  const problems = await generateCodingProblems({ topic, difficulty, resume, job });
  res.json({ success: true, problems, topic, difficulty });
};

module.exports = {
  saveJob,
  getJob,
  deleteJob,
  analyze,
  skillGap,
  roadmapGenerate,
  roadmapGet,
  roadmapProgress,
  roadmapDelete,
  codingGenerate,
};