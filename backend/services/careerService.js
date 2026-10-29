// Career analysis, skill gap, roadmap, coding-prep, and resume-improvement logic.
// AI-backed operations use the REAL configured LLM provider only. There are no
// template/offline-fallback answers: when AI is unavailable, callers get an
// honest 503/502 error instead of a fake reply.

const llmService = require('./llmService');
const { SKILL_GAP_SYSTEM, RESUME_IMPROVER_SYSTEM, ROADMAP_SYSTEM, CODING_SYSTEM } = require('./prompts');
const Roadmap = require('../models/Roadmap');

const normalizeSkill = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9+#.]/g, '');

const unique = (arr) => [...new Set((arr || []).filter(Boolean))];

/**
 * Descriptive, non-scientific comparison between user skills and job requirements.
 */
const computeSkillGap = ({ resumeSkills = [], requiredSkills = [], preferredSkills = [] }) => {
  const rs = unique(resumeSkills);
  const req = unique(requiredSkills);
  const pref = unique(preferredSkills);

  const userSet = new Set(rs.map(normalizeSkill));
  const reqSet = new Set(req.map(normalizeSkill));
  const prefSet = new Set(pref.map(normalizeSkill));

  const matched = req.filter((s) => userSet.has(normalizeSkill(s)));
  const missing = req.filter((s) => !userSet.has(normalizeSkill(s)));
  const matchedPreferred = pref.filter((s) => userSet.has(normalizeSkill(s)));
  const additional = rs.filter(
    (s) => !reqSet.has(normalizeSkill(s)) && !prefSet.has(normalizeSkill(s))
  );

  const matchPercent = req.length ? Math.round((matched.length / req.length) * 100) : 0;

  // Priority: least-covered required skills first, keeping JD order as a tie-break.
  const priority = missing.slice(0, 8);

  return {
    matchPercent,
    totalRequired: req.length,
    matched,
    matchedPreferred,
    missing,
    additional,
    priority,
  };
};

const buildUserContext = ({ resume, job }) => {
  const lines = [];
  if (resume?.parsed) {
    const p = resume.parsed;
    lines.push(`USER SKILLS: ${(p.skills || []).join(', ') || 'not provided'}`);
    lines.push(`PROGRAMMING LANGUAGES: ${(p.programmingLanguages || []).join(', ') || ''}`);
    lines.push(`FRAMEWORKS/TOOLS: ${(p.frameworks || []).join(', ')} ${(p.tools || []).join(', ')}`);
    if (p.projects?.length) {
      lines.push('PROJECTS:');
      p.projects.slice(0, 5).forEach((pr) =>
        lines.push(`- ${pr.name}: ${(pr.description || '').slice(0, 200)}${pr.technologies?.length ? ` [${pr.technologies.join(', ')}]` : ''}`)
      );
    }
    if (p.experience?.length) {
      lines.push('EXPERIENCE:');
      p.experience.slice(0, 4).forEach((e) => lines.push(`- ${e.role}${e.company ? ` @ ${e.company}` : ''}${e.duration ? ` (${e.duration})` : ''}: ${(e.description || '').slice(0, 150)}`));
    }
    if (p.education?.length) lines.push(`EDUCATION: ${p.education.map((e) => e.degree).join('; ')}`);
  }
  if (job?.parsed) {
    lines.push(`TARGET ROLE: ${job.jobTitle || ''}${job.company ? ` @ ${job.company}` : ''}`);
    lines.push(`REQUIRED SKILLS: ${(job.parsed.requiredSkills || []).join(', ') || ''}`);
    lines.push(`PREFERRED SKILLS: ${(job.parsed.preferredSkills || []).join(', ') || ''}`);
  }
  return lines.join('\n');
};

/**
 * Runs the full resume+JD analysis and stores the result on the Resume document.
 */
const analyzeCareer = async ({ resumeModel, jobModel }) => {
  const gap = computeSkillGap({
    resumeSkills: resumeModel.parsed?.skills || [],
    requiredSkills: jobModel.parsed?.requiredSkills || [],
    preferredSkills: jobModel.parsed?.preferredSkills || [],
  });

  const strengths = gap.matched.length
    ? gap.matched.map((s) => `Strong match on ${s}`)
    : [];

  let summary = `You match ${gap.matchPercent}% of the ${jobModel.jobTitle || 'target'} requirements. ${
    gap.matched.length ? `You already cover: ${gap.matched.join(', ')}.` : ''
  } ${gap.missing.length ? `Focus next on: ${gap.missing.join(', ')}.` : ''}`;

  // Optional LLM polish of the summary (never changes the computed numbers).
  if (llmService.isConfigured()) {
    try {
      const context = buildUserContext({ resume: resumeModel, job: jobModel });
      const llmSummary = await llmService.complete({
        system: SKILL_GAP_SYSTEM,
        user: `${context}\n\nMATCH: ${gap.matchPercent}%\nMATCHED: ${gap.matched.join(', ')}\nMISSING: ${gap.missing.join(', ')}\n\nWrite a concise 2-3 sentence personalized analysis summary.`,
        temperature: 0.4,
        // Was 300: "2-3 sentences" of personalized analysis plus the matched /
        // missing skill lists regularly exceeded it and the sentence was cut off
        // mid-word. 600 gives the documented output real room.
        maxTokens: 600,
      });
      summary = llmSummary;
    } catch {
      // Keep the deterministic summary - the LLM is optional here.
    }
  }

  resumeModel.analysis = {
    jobTitle: jobModel.jobTitle,
    company: jobModel.company,
    matchPercent: gap.matchPercent,
    requiredSkills: jobModel.parsed?.requiredSkills || [],
    preferredSkills: jobModel.parsed?.preferredSkills || [],
    matchedSkills: gap.matched,
    missingSkills: gap.missing,
    prioritySkills: gap.priority,
    additionalSkills: gap.additional,
    strengths,
    summary,
    analyzedAt: new Date(),
  };
  await resumeModel.save();
  return resumeModel.analysis;
};

/** Generates (or regenerates) a personalized learning roadmap and persists it. */
const generateRoadmap = async ({ userId, resume, job }) => {
  const gap = computeSkillGap({
    resumeSkills: resume?.parsed?.skills || [],
    requiredSkills: job?.parsed?.requiredSkills || [],
    preferredSkills: job?.parsed?.preferredSkills || [],
  });

  // Real LLM generation only — llmService throws an honest 503 when there is no
  // configured provider, and a 502 when the provider fails.
  const context = buildUserContext({ resume, job });
  const json = await llmService.complete({
    system: ROADMAP_SYSTEM,
    user: `${context}\n\nMISSING SKILLS TO LEARN: ${gap.missing.join(', ') || '(none specified)'}\n\nGenerate the roadmap as JSON matching the required schema.`,
    temperature: 0.4,
    // Was 1600: a 7-phase roadmap with topics/description/practice for each is
    // routinely larger than that, so the JSON was cut mid-array and the whole
    // roadmap failed to parse. 3200 comfortably fits the documented schema.
    maxTokens: 3200,
  });
  const parsed = extractJson(json);
  const phases = parsed?.phases
    ? parsed.phases
        .slice(0, 7)
        .map((ph, i) => ({
          title: ph.title || `Phase ${i + 1}`,
          description: String(ph.description || '').slice(0, 300),
          topics: (ph.topics || []).slice(0, 8).map((t) => ({
            title: String(t.title || '').slice(0, 120),
            description: String(t.description || '').slice(0, 300),
            resources: [String(t.practice || '')].filter(Boolean),
            status: 'not-started',
          })),
        }))
        .filter((ph) => ph.topics.length)
    : [];

  if (!phases.length) {
    const err = new Error('AI provider returned an unparseable roadmap. Try again.');
    err.statusCode = 502;
    err.isOperational = true;
    throw err;
  }

  const doc = await Roadmap.findOneAndUpdate(
    { userId },
    {
      userId,
      targetRole: job?.jobTitle || '',
      targetCompany: job?.company || '',
      phases,
      progressPercent: 0,
      generatedAt: new Date(),
    },
    { upsert: true, new: true }
  );
  return doc;
};

const updateRoadmapProgress = async ({ userId, phaseIndex, topicIndex, status }) => {
  const doc = await Roadmap.findOne({ userId });
  if (!doc) {
    const err = new Error('No roadmap found. Generate a roadmap first.');
    err.statusCode = 404;
    err.isOperational = true;
    throw err;
  }
  if (!doc.phases[phaseIndex]?.topics[topicIndex]) {
    const err = new Error('Invalid roadmap phase or topic index.');
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
  doc.phases[phaseIndex].topics[topicIndex].status = status;

  const total = doc.phases.reduce((n, p) => n + p.topics.length, 0);
  const done = doc.phases.reduce(
    (n, p) => n + p.topics.filter((t) => t.status === 'completed').length,
    0
  );
  doc.progressPercent = total ? Math.round((done / total) * 100) : 0;
  await doc.save();
  return doc;
};

const generateCodingProblems = async ({ topic, difficulty, resume, job }) => {
  const context = buildUserContext({ resume, job });
  const json = await llmService.complete({
    system: CODING_SYSTEM,
    user: `${context}\n\nTOPIC: ${topic}\nDIFFICULTY: ${difficulty}\n\nGenerate the problems as a JSON array.`,
    temperature: 0.5,
    // Was 1200: six problems with description + example + techniques is larger
    // than that and the array was cut mid-object, failing the whole request.
    maxTokens: 2600,
  });
  const arr = extractJsonArray(json);
  const problems = arr?.length
    ? arr.slice(0, 6).map((p) => ({
        title: String(p.title || 'Problem'),
        difficulty: ['Easy', 'Medium', 'Hard'].includes(p.difficulty) ? p.difficulty : difficulty,
        description: String(p.description || ''),
        example: String(p.example || ''),
        techniques: (p.techniques || []).map(String),
      }))
    : [];
  if (!problems.length) {
    const err = new Error('AI provider returned an unparseable coding-problems response. Try again.');
    err.statusCode = 502;
    err.isOperational = true;
    throw err;
  }
  return problems;
};

const IMPROVE_FEATURES = ['summary', 'skills', 'project', 'experience', 'optimize', 'bullets'];

const improveResumeSection = async ({ feature, originalText, resume, job }) => {
  if (!IMPROVE_FEATURES.includes(feature)) {
    const err = new Error(`Unknown improvement feature: ${feature}`);
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }

  const system =
    feature === 'optimize'
      ? `${RESUME_IMPROVER_SYSTEM}\n\nYour goal: rewrite the section so it better matches the target job below, WITHOUT adding any fake facts.`
      : RESUME_IMPROVER_SYSTEM;

  if (llmService.isConfigured()) {
    const context = buildUserContext({ resume, job });
    const result = await llmService.complete({
      system,
      user: `TARGET JOB CONTEXT:\n${context}\n\nSECTION TO IMPROVE (${feature}):\n${originalText}\n\nReturn JSON: {"original": "...", "improved": "...", "reason": ["..."]}`,
      temperature: 0.4,
      // Was 900: an "improved" section that rewrites a whole experience block
      // with reasons was regularly cut, losing the whole JSON object.
      maxTokens: 1600,
    });
    const parsed = extractJson(result);
    if (parsed?.improved) {
      return {
        original: originalText,
        improved: parsed.improved,
        reason: Array.isArray(parsed.reason) ? parsed.reason.map(String) : [String(parsed.reason || '')],
      };
    }
    return {
      original: originalText,
      improved: result,
      reason: ['Improved with AI guidance.'],
    };
  }

  // No LLM configured: return honest, generic improvement guidance without rewriting content.
  return {
    original: originalText,
    improved: originalText,
    reason: [
      'AI provider is not configured, so no rewrite was performed.',
      'Generic tips: use strong action verbs, quantify impact where the original has numbers, keep each bullet to one idea, and mirror keywords from the job description.',
    ],
    aiConfigured: false,
  };
};

const extractJson = (text) => {
  const t = String(text || '');
  const match = t.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
};

const extractJsonArray = (text) => {
  const t = String(text || '');
  const match = t.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
};

module.exports = {
  computeSkillGap,
  analyzeCareer,
  buildUserContext,
  generateRoadmap,
  updateRoadmapProgress,
  generateCodingProblems,
  improveResumeSection,
};