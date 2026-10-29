// Heuristic resume parser. Extracts only information actually present in the file.
// Never invents name, contact, skills, projects, or experience.

const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const mammoth = require('mammoth');

const SKILL_DB = require('./skillData');
const { matchSkills } = require('./skillData');

const parseTextFromBuffer = async ({ buffer, extension }) => {
  const ext = String(extension || '').toLowerCase();
  if (ext === 'pdf') {
    const data = await pdfParse(buffer);
    return data.text || '';
  }
  if (ext === 'docx' || ext === 'doc') {
    // mammoth handles .docx; .doc falls back to raw UTF-8 text extraction attempt.
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value || '';
    } catch {
      // fall through to raw text
    }
  }
  return buffer.toString('utf8');
};

const SECTION_HEADER = /^\s*(education|academic)\s*:?\s*$/i;
const EDUCATION_RE = /(b\.?tech|bachelor|b\.?sc|master|m\.?tech|m\.?sc|ph\.?d|mba|be\s|b\.?e\.?|diploma|bachelor of technology|bachelor of science)/i;
const EXPERIENCE_SECTION_RE = /^\s*(work experience|professional experience|employment|experience)\s*:?\s*$/i;
const PROJECT_SECTION_RE = /^\s*(projects?|academic projects?|personal projects?)\s*:?\s*$/i;
const CERT_SECTION_RE = /^\s*(certifications?|licenses?)\s*:?\s*$/i;
const INTERNSHIP_SECTION_RE = /^\s*(internships?|traineeships?)\s*:?\s*$/i;
const ACHIEVEMENT_SECTION_RE = /^\s*(achievements?|awards?|honors?)\s*:?\s*$/i;
const SKILLS_SECTION_RE = /^\s*(technical skills|skills|core skills|key skills)\s*:?\s*$/i;
const SUMMARY_SECTION_RE = /^\s*(summary|profile|about|objective|carrer objective|career objective)\s*:?\s*$/i;

const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;
const PHONE_RE = /(\+?\d[\d\s().-]{8,17}\d)/;
const LINKEDIN_RE = /(linkedin\.com\/[^\s|]+)/i;
const GITHUB_RE = /(github\.com\/[^\s|]+)/i;

const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const extractStructured = (text) => {
  const trimmed = normalize(text);
  const lines = text.split(/\r?\n/);

  const parsed = {
    name: '',
    contact: { email: '', phone: '', linkedin: '', github: '', location: '' },
    summary: '',
    skills: [],
    programmingLanguages: [],
    frameworks: [],
    libraries: [],
    tools: [],
    education: [],
    projects: [],
    experience: [],
    internships: [],
    certifications: [],
    achievements: [],
  };

  // Contact info from anywhere in the text.
  const emailMatch = trimmed.match(EMAIL_RE);
  const phoneMatch = trimmed.match(PHONE_RE);
  const linkedinMatch = trimmed.match(LINKEDIN_RE);
  const githubMatch = trimmed.match(GITHUB_RE);
  if (emailMatch) parsed.contact.email = emailMatch[1];
  if (phoneMatch) parsed.contact.phone = phoneMatch[1].trim();
  if (linkedinMatch) parsed.contact.linkedin = linkedinMatch[1];
  if (githubMatch) parsed.contact.github = githubMatch[1];

  // Name: first plausible standalone line.
  for (const raw of lines.slice(0, 8)) {
    const line = normalize(raw);
    if (!line || line.length > 60) continue;
    if (/@|education|experience|project|skill|summary|profile|objective|resume|cv/i.test(line)) continue;
    if (/^[\d+\-().\s]+$/.test(line)) continue;
    const letters = (line.match(/[a-zA-Z]/g) || []).length;
    const isCapitalizedName = /^[A-Z][a-z]+(\s[A-Z][a-z]+){1,3}(\s[A-Z]\.)?$/.test(line);
    if ((isCapitalizedName || (letterCount(line) >= 3 && letters / line.length > 0.6)) && words(line).length <= 5) {
      parsed.name = line;
      break;
    }
  }

  // Walk lines, capture section data.
  let currentSection = '';
  const bullets = [];

  for (let i = 0; i < lines.length; i++) {
    const line = normalize(lines[i]);
    if (!line) continue;

    if (SKILLS_SECTION_RE.test(line)) { currentSection = 'skills'; continue; }
    if (EXPERIENCE_SECTION_RE.test(line)) { currentSection = 'experience'; continue; }
    if (PROJECT_SECTION_RE.test(line)) { currentSection = 'projects'; continue; }
    if (CERT_SECTION_RE.test(line)) { currentSection = 'certifications'; continue; }
    if (INTERNSHIP_SECTION_RE.test(line)) { currentSection = 'internships'; continue; }
    if (ACHIEVEMENT_SECTION_RE.test(line)) { currentSection = 'achievements'; continue; }
    if (SUMMARY_SECTION_RE.test(line)) { currentSection = 'summary'; continue; }
    if (SECTION_HEADER.test(line)) { currentSection = 'education'; continue; }
    if (/^\s*(references?|declaration|hobbies?|languages? known)\s*:?\s*$/i.test(line)) { currentSection = 'misc'; continue; }

    if (/^[-•*]\s*/.test(line)) {
      bullets.push(line.replace(/^[-•*]\s*/, ''));
      continue;
    }
    if (/^\d+[.)]\s*/.test(line)) {
      bullets.push(line.replace(/^\d+[.)]\s*/, ''));
      continue;
    }

    // Education line detection
    if (EDUCATION_RE.test(line) && currentSection !== 'summary') {
      const year = line.match(/(20\d{2}|19\d{2})/g);
      parsed.education.push({
        degree: line,
        institution: '',
        year: year ? year[year.length - 1] : '',
      });
      currentSection = 'education';
      continue;
    }

    // Certification line
    if (currentSection === 'certifications') {
      if (certLooksLike(line)) parsed.certifications.push(line);
      else if (!/^\d/.test(line) && line.length < 100) parsed.certifications.push(line);
      continue;
    }

    // Achievement line
    if (currentSection === 'achievements') {
      if (line.length < 160) parsed.achievements.push(line);
      continue;
    }

    // Experience lines
    if (currentSection === 'experience') {
      const roleMatch = line.match(/^(.*?)\s*[-–|]\s*(.*?)(?:\s*[-–|]\s*(.*))?$/);
      if (line.length < 120 && words(line).length <= 12) {
        const last = parsed.experience[parsed.experience.length - 1];
        if (last && (!last.role || !last.company) && !line.includes('http')) {
          if (!last.role) last.role = line;
          else if (!last.company) last.company = line;
        } else {
          parsed.experience.push({ role: line, company: '', duration: '', description: '' });
        }
      }
      continue;
    }

    // Projects
    if (currentSection === 'projects') {
      if (line.length < 140 && !line.includes('•')) {
        parsed.projects.push({ name: line, description: '', technologies: [] });
      }
      continue;
    }

    // Summary
    if (currentSection === 'summary' && !parsed.summary) {
      parsed.summary = line.length < 400 ? line : line.slice(0, 397) + '...';
      continue;
    }
  }

  // Bullets: attach relevant ones to the most recent project/experience entry.
  const attachBullets = (holder) => {
    const target = holder[holder.length - 1];
    if (!target) return;
    const joined = [...(target.description ? [target.description] : []), ...bullets].join(' ');
    target.description = joined.slice(0, 400);
  };
  if (parsed.projects.length) attachBullets(parsed.projects);
  else if (parsed.experience.length) attachBullets(parsed.experience);

  // Skills from skills section + whole text.
  const allSkillsMatched = matchSkills(trimmed);
  const sectionSkillsMatched = new Set();
  for (const raw of lines) {
    const line = normalize(raw);
    if (SKILLS_SECTION_RE.test(line)) continue;
    matchSkills(line).forEach((s) => sectionSkillsMatched.add(s));
  }
  const skillsArr = [...allSkillsMatched].sort();

  // Categorize matched skills.
  const langs = [], frameworks = [], tools = [];
  for (const s of skillsArr) {
    const entry = SKILL_DB.find((e) => e.name === s);
    if (!entry) { tools.push(s); continue; }
    if (entry.categories.includes('language') || entry.categories.includes('data-lang')) langs.push(s);
    else if (entry.categories.includes('db') || entry.categories.includes('cloud') || entry.categories.includes('tool') || entry.categories.includes('data')) tools.push(s);
    else frameworks.push(s);
  }

  parsed.skills = skillsArr;
  parsed.programmingLanguages = [...new Set(langs)];
  parsed.frameworks = [...new Set(frameworks)];
  parsed.tools = [...new Set(tools)];

  // Education: add empty-name entries that got created without years.
  parsed.education = parsed.education.filter((e) => e.degree).slice(0, 6);

  // Location guess from contact area lines (first 6 lines containing a city pattern).
  if (!parsed.contact.location) {
    const loc = lines
      .slice(0, 6)
      .map(normalize)
      .find((l) => /^[A-Z][a-zA-Z\s]+,?\s*[A-Z]{2}\b/.test(l) && !l.includes('@'));
    if (loc) parsed.contact.location = loc;
  }

  return parsed;
};

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);
const letterCount = (s) => (s.match(/[a-zA-Z]/g) || []).length;

const certLooksLike = (line) =>
  /(certif|coursera|udemy|udacity|aws certified|oracle|google|microsoft|coursera|freecodecamp|hackerrank|leetcode|linkedin learning|edx)/i.test(line);

/**
 * Full pipeline: buffer -> text -> structured data.
 * @returns {{text: string, parsed: object, extension: string}}
 */
const parseResume = async ({ buffer, extension, mimetype }) => {
  const ext = extension || (mimetype === 'application/pdf' ? 'pdf' : mimetype.includes('word') ? 'docx' : 'txt');
  const text = await parseTextFromBuffer({ buffer, extension: ext });
  if (!text || !text.trim()) {
    const err = new Error('Could not extract any text from the file. Please upload a text-based PDF, DOCX, or TXT resume.');
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
  const parsed = extractStructured(text);
  return { text, parsed, extension: ext };
};

module.exports = { parseResume, extractStructured, matchSkills, parseTextFromBuffer };