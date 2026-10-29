const Interview = require('../models/Interview');
const Resume = require('../models/Resume');
const JobDescription = require('../models/JobDescription');
const llmService = require('../services/llmService');
const { INTERVIEW_GENERATOR_SYSTEM, MOCK_INTERVIEW_SYSTEM } = require('../services/prompts');
const { buildUserContext } = require('../services/careerService');
const { analyzeRequest, planOutput } = require('../services/outputRequirements');

const CATEGORIES = ['resume questions', 'project questions', 'technical', 'java', 'python', 'sql', 'dsa', 'web development', 'hr', 'behavioral', 'system design'];

const requiresContext = (category) =>
  ['resume questions', 'project questions', 'technical'].includes(String(category || '').toLowerCase());

// Real-AI only: generates questions through the configured LLM provider. There is
// NO question-bank/template fallback — without a configured provider (or on a
// real provider failure) this throws an honest error instead of a fake answer.
const buildQuestionPool = async ({ category, count = 6, resume, job }) => {
  const cat = String(category || 'technical').toLowerCase();
  const context = buildUserContext({ resume, job });
  // The JSON budget scales with the number of questions actually requested, so a
  // pool of 20 is never cut off mid-array (a truncated JSON array parses to
  // nothing and the whole request failed with "unparseable response").
  const planned = planOutput(
    analyzeRequest({ question: `${count} interview questions about ${cat}` }),
    { cap: 16384 }
  );
  const json = await llmService.complete({
    system: INTERVIEW_GENERATOR_SYSTEM,
    user: `${context}\n\nCATEGORY: ${cat}\nNUMBER OF QUESTIONS: ${count}\n\nReturn only the JSON array of questions.`,
    temperature: 0.6,
    maxTokens: planned.maxTokens,
  });
  const arr = parseJsonArray(json);
  if (!arr?.length) {
    const err = new Error('AI provider returned an unparseable interview-question response. Try again.');
    err.statusCode = 502;
    err.isOperational = true;
    throw err;
  }
  const mapped = arr.slice(0, count).map((q) => ({
    question: String(q.question || ''),
    category: cat,
    expectedPoints: (q.expectedPoints || []).map(String),
  })).filter((q) => q.question);
  if (!mapped.length) {
    const err = new Error('AI provider returned no valid interview questions. Try again.');
    err.statusCode = 502;
    err.isOperational = true;
    throw err;
  }
  return mapped;
};

const parseJsonArray = (text) => {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
};

// @desc   Generate a batch of interview questions
// @route  POST /api/interview/generate
const generateQuestions = async (req, res) => {
  const { category, count } = req.body || {};
  const resume = await Resume.findOne({ userId: req.user.id });
  const job = await JobDescription.findOne({ userId: req.user.id });

  const questions = await buildQuestionPool({
    category: category || 'technical',
    count: Math.min(Number(count) || 6, 12),
    resume,
    job,
  });

  const session = await Interview.create({
    userId: req.user.id,
    type: 'questions',
    category: category || 'technical',
    title: `${category || 'Technical'} Questions`,
    status: 'completed',
    questions,
    currentIndex: questions.length,
  });

  res.status(201).json({ success: true, session });
};

// @desc   Start a mock interview (first question returned)
// @route  POST /api/interview/mock/start
const startMock = async (req, res) => {
  const { category, count } = req.body || {};
  const resume = await Resume.findOne({ userId: req.user.id });
  const job = await JobDescription.findOne({ userId: req.user.id });

  const questions = await buildQuestionPool({
    category: category || 'technical',
    count: Math.min(Number(count) || 5, 8),
    resume,
    job,
  });

  const session = await Interview.create({
    userId: req.user.id,
    type: 'mock',
    category: category || 'technical',
    title: `Mock Interview - ${category || 'Technical'}`,
    status: 'in-progress',
    questions,
    currentIndex: 0,
  });

  res.status(201).json({
    success: true,
    session,
    question: questions[0] || null,
    index: 0,
  });
};

const parseJson = (text) => {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
};

const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

const evaluateWithLLM = async ({ answer, question, expectedPoints = [] }) => {
  const result = await llmService.complete({
    system: MOCK_INTERVIEW_SYSTEM,
    user: `QUESTION: ${question}\nEXPECTED POINTS: ${expectedPoints.join('; ')}\n\nCANDIDATE ANSWER:\n${answer}\n\nReturn JSON: {"relevance":0-100,"technicalCoverage":0-100,"clarity":0-100,"structure":0-100,"missingPoints":["..."],"feedback":"..."}`,
    temperature: 0.3,
    // Was 500: a long candidate answer produced a feedback string that ran past
    // the ceiling, the JSON was cut mid-string and the WHOLE evaluation was lost
    // ("AI provider returned an unparseable response"). 900 fits the fixed shape.
    maxTokens: 900,
  });
  const parsed = parseJson(result);
  if (parsed) {
    return {
      scores: {
        relevance: clamp(parsed.relevance),
        technicalCoverage: clamp(parsed.technicalCoverage),
        clarity: clamp(parsed.clarity),
        structure: clamp(parsed.structure),
      },
      missingPoints: (parsed.missingPoints || []).map(String).slice(0, 6),
      feedback: String(parsed.feedback || ''),
      mode: 'llm',
    };
  }
  const err = new Error('AI provider returned an unparseable answer evaluation. Try again.');
  err.statusCode = 502;
  err.isOperational = true;
  throw err;
};

// @desc   Answer the current mock interview question, get feedback + next question
// @route  POST /api/interview/mock/answer
const answerMock = async (req, res) => {
  const { sessionId, answer } = req.body || {};
  if (!sessionId) return res.status(400).json({ success: false, message: 'sessionId is required' });

  const session = await Interview.findOne({ _id: sessionId, userId: req.user.id });
  if (!session) return res.status(404).json({ success: false, message: 'Interview session not found' });
  if (session.type !== 'mock') return res.status(400).json({ success: false, message: 'Not a mock interview session' });

  const idx = session.currentIndex;
  const question = session.questions[idx];
  if (!question) {
    return res.status(400).json({ success: false, message: 'No active question in this session' });
  }

  const evaluation = await evaluateWithLLM({ answer, question: question.question, expectedPoints: question.expectedPoints });

  session.answers.push({
    question: question.question,
    answer: String(answer || ''),
    feedback: evaluation.feedback,
    scores: evaluation.scores,
    missingPoints: evaluation.missingPoints,
  });

  session.currentIndex = idx + 1;

  if (session.currentIndex >= session.questions.length) {
    session.status = 'completed';
    const avg =
      session.answers.reduce(
        (sum, a) =>
          sum + (a.scores.relevance + a.scores.technicalCoverage + a.scores.clarity + a.scores.structure) / 4,
        0
      ) / Math.max(session.answers.length, 1);
    session.averageScore = Math.round(avg);
    session.overallFeedback = 'Mock interview completed. Review per-answer feedback above.';
    await session.save();
    return res.json({
      success: true,
      finished: true,
      session,
      feedback: evaluation,
    });
  }

  await session.save();
  res.json({
    success: true,
    finished: false,
    session,
    feedback: evaluation,
    question: session.questions[session.currentIndex],
    index: session.currentIndex,
  });
};

// @desc   Evaluate a single answer (used by the Mock Interview page)
// @route  POST /api/interview/evaluate
const evaluate = async (req, res) => {
  const { question, answer, expectedPoints = [] } = req.body || {};
  if (!question || !answer) {
    return res.status(400).json({ success: false, message: 'question and answer are required' });
  }
  const result = await evaluateWithLLM({ answer, question, expectedPoints });
  res.json({ success: true, ...result });
};

// @desc   List the user's interview sessions
// @route  GET /api/interview
const listSessions = async (req, res) => {
  const sessions = await Interview.find({ userId: req.user.id })
    .sort({ updatedAt: -1 })
    .select('title type category status averageScore createdAt updatedAt');
  res.json({ success: true, sessions });
};

// @desc   Get one session (owner only)
// @route  GET /api/interview/:id
const getSession = async (req, res) => {
  const session = await Interview.findOne({ _id: req.params.id, userId: req.user.id });
  if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
  res.json({ success: true, session });
};

// @desc   Delete a session (owner only)
// @route  DELETE /api/interview/:id
const deleteSession = async (req, res) => {
  const session = await Interview.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!session) return res.status(404).json({ success: false, message: 'Session not found' });
  res.json({ success: true, message: 'Session deleted' });
};

module.exports = {
  generateQuestions,
  startMock,
  answerMock,
  evaluate,
  listSessions,
  getSession,
  deleteSession,
  CATEGORIES,
};