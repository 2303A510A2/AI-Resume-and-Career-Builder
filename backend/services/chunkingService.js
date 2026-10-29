// Turns parsed resume / job description data into small, searchable chunks with
// metadata (userId, source, section). No text outside the user's own documents
// ever enters the knowledge base.

const DEFAULT_MAX = Number(process.env.RAG_CHUNK_SIZE || 800);
const DEFAULT_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP || 120);

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Splits long text into overlapping chunks on paragraph/sentence boundaries. */
const chunkLongText = (text, { maxLength = DEFAULT_MAX, overlap = DEFAULT_OVERLAP } = {}) => {
  const t = clean(text);
  if (!t) return [];
  if (t.length <= maxLength) return [t];

  const paragraphs = t.split(/(?<=\.)\s+|\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + ' ' + para).length <= maxLength) {
      current = current ? `${current} ${para}` : para;
    } else {
      if (current) chunks.push(current);
      // Split oversized paragraphs themselves.
      if (para.length > maxLength) {
        let rest = para;
        while (rest.length > maxLength) {
          const cut = rest.lastIndexOf(' ', maxLength);
          const boundary = cut > maxLength * 0.6 ? cut : maxLength;
          chunks.push(rest.slice(0, boundary));
          rest = rest.slice(boundary - overlap);
        }
        current = rest;
      } else {
        current = para;
      }
    }
  }
  if (current) chunks.push(current);

  // Add overlap context to each chunk for continuity.
  return chunks;
};

const buildResumeChunks = ({ parsed, originalText }) => {
  const chunks = [];
  if (!parsed) return chunks;

  if (parsed.summary) {
    chunkLongText(`Resume Summary: ${parsed.summary}`, {}).forEach((text) =>
      chunks.push({ source: 'resume', section: 'summary', text })
    );
  }

  if (parsed.skills && parsed.skills.length) {
    chunks.push({
      source: 'resume',
      section: 'skills',
      text: `Skills on my resume: ${parsed.skills.join(', ')}`,
    });
  }
  if (parsed.programmingLanguages && parsed.programmingLanguages.length) {
    chunks.push({
      source: 'resume',
      section: 'programming-languages',
      text: `Programming languages: ${parsed.programmingLanguages.join(', ')}`,
    });
  }
  if (parsed.frameworks && parsed.frameworks.length) {
    chunks.push({
      source: 'resume',
      section: 'frameworks',
      text: `Frameworks, databases and tools: ${parsed.frameworks.join(', ')}`,
    });
  }

  (parsed.projects || []).forEach((p, i) => {
    const title = clean(p.name) || `Project ${i + 1}`;
    const desc = clean(p.description) || '';
    const tech = (p.technologies || []).join(', ');
    const text = `Project: ${title}. ${desc}${tech ? ` Technologies: ${tech}.` : ''}`;
    chunks.push({ source: 'resume', section: 'projects', text });
  });

  (parsed.experience || []).forEach((e, i) => {
    const role = clean(e.role) || `Position ${i + 1}`;
    const company = clean(e.company) ? ` at ${clean(e.company)}` : '';
    const dur = clean(e.duration) ? ` (${clean(e.duration)})` : '';
    const desc = clean(e.description) || '';
    chunks.push({
      source: 'resume',
      section: 'experience',
      text: `Work experience: ${role}${company}${dur}. ${desc}`,
    });
  });

  (parsed.internships || []).forEach((e, i) => {
    const role = clean(e.role) || `Internship ${i + 1}`;
    const company = clean(e.company) ? ` at ${clean(e.company)}` : '';
    const desc = clean(e.description) || '';
    chunks.push({ source: 'resume', section: 'internships', text: `Internship: ${role}${company}. ${desc}` });
  });

  (parsed.education || []).forEach((e, i) => {
    const degree = clean(e.degree) || `Degree ${i + 1}`;
    const inst = clean(e.institution) ? ` from ${clean(e.institution)}` : '';
    const yr = clean(e.year) ? ` (${clean(e.year)})` : '';
    chunks.push({ source: 'resume', section: 'education', text: `Education: ${degree}${inst}${yr}` });
  });

  if (parsed.certifications && parsed.certifications.length) {
    chunks.push({
      source: 'resume',
      section: 'certifications',
      text: `Certifications: ${parsed.certifications.join(', ')}`,
    });
  }
  if (parsed.achievements && parsed.achievements.length) {
    chunks.push({
      source: 'resume',
      section: 'achievements',
      text: `Achievements: ${parsed.achievements.join(', ')}`,
    });
  }

  // Raw resume text as a catch-all (bounded).
  if (originalText) {
    chunkLongText(originalText, { maxLength: 1500, overlap: 0 }).forEach((text) =>
      chunks.push({ source: 'resume', section: 'full-resume', text })
    );
  }

  return chunks;
};

const buildJobChunks = ({ job }) => {
  const chunks = [];
  if (!job) return chunks;

  const title = clean(job.jobTitle);
  const company = clean(job.company);
  const header = `Target job: ${title}${company ? ` at ${company}` : ''}.`;
  chunks.push({ source: 'job', section: 'overview', text: header });

  if (job.parsed) {
    const p = job.parsed;
    if (p.requiredSkills && p.requiredSkills.length) {
      chunks.push({
        source: 'job',
        section: 'requirements-skills',
        text: `Required skills for the job: ${p.requiredSkills.join(', ')}.`,
      });
    }
    if (p.preferredSkills && p.preferredSkills.length) {
      chunks.push({
        source: 'job',
        section: 'preferred-skills',
        text: `Preferred/nice-to-have skills: ${p.preferredSkills.join(', ')}.`,
      });
    }
    if (p.responsibilities && p.responsibilities.length) {
      chunks.push({
        source: 'job',
        section: 'responsibilities',
        text: `Job responsibilities:\n${p.responsibilities.map((r) => `- ${r}`).join('\n')}`,
      });
    }
    if (p.qualifications && p.qualifications.length) {
      chunks.push({
        source: 'job',
        section: 'qualifications',
        text: `Job qualifications:\n${p.qualifications.map((q) => `- ${q}`).join('\n')}`,
      });
    }
    if (p.experienceLevel) {
      chunks.push({ source: 'job', section: 'experience', text: `Required experience level: ${p.experienceLevel}.` });
    }
  }

  if (job.description) {
    chunkLongText(job.description, {}).forEach((text) =>
      chunks.push({ source: 'job', section: 'full-job-description', text })
    );
  }

  return chunks;
};

const buildAllChunks = ({ resume, job }) => {
  const chunks = [];
  if (resume) chunks.push(...buildResumeChunks({ parsed: resume.parsed, originalText: resume.originalText }));
  if (job) chunks.push(...buildJobChunks({ job }));
  return chunks;
};

module.exports = { buildAllChunks, buildResumeChunks, buildJobChunks, chunkLongText };