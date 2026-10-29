// Job description parser. Extracts structured info from pasted JD text using
// the curated skill dictionary and lightweight line heuristics. Only content
// actually present in the JD is captured.
//
// Required vs preferred: skills found on must-have lines of the
// requirements/qualifications zone become `requiredSkills`; skills on lines
// marked as preferred/"is a plus" go to `preferredSkills`.

const { matchSkills } = require('./skillData');

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Kept as an alias so existing callers keep working with the old name.
const matchSkillsFull = matchSkills;

const REQUIRED_ZONE_START = /^(preferred\s+)?(qualification|requirement|who you are|about you|skills you(‘|')?ll need|what we(‘|')?re looking|what you(‘|')?ll bring)/i;
const RESPONSIBILITY_HEADER = /^(responsibilit|what you'?ll do|key responsibilities|duties|what you(‘|')?ll do)/i;
const PREFERRED_LINE = /(preferred|is a plus|a plus|nice.to.have|nice to have|good.to.have|good to have|would be( a)?( nice| great| advantageous)?|beneficial|desired|advantage|bonus|extra credit)/i;

// Line heuristics to find where bulk text can safely be ignored.
const QUALIFICATION_HEADER = /^(qualification|requirement|who you are|about you|what we(‘|')?re looking)/i;

const parseResponsibilities = (lines) => {
  const out = [];
  let capturing = false;
  for (const line of lines) {
    const l = clean(line.replace(/^[-•*]\s*|\d+[.)]\s*/, ''));
    if (!l) continue;
    if (RESPONSIBILITY_HEADER.test(l)) { capturing = true; continue; }
    // Once we are capturing, a qualifications block ends the responsibilities.
    if (/^(qualification|requirement|who you are|about you|what we(‘|')?re looking)/i.test(l)) {
      if (capturing) break;
      continue;
    }
    if (!capturing) continue;
    // A responsibility line usually starts with an action verb.
    if (/^(design|develop|build|manage|lead|collaborate|work|own|drive|create|implement|maintain|support|write|test|deploy|optimize|analyze|architect|mentor|coordinate|participate|ensure|deliver|improve|own)/i.test(l) && l.length < 200) {
      out.push(l.charAt(0).toUpperCase() + l.slice(1));
    }
  }
  return out.slice(0, 12);
};

const parseQualifications = (lines) => {
  const out = [];
  for (const line of lines) {
    const l = clean(line.replace(/^[-•*]\s*|\d+[.)]\s*/, ''));
    if (!l) continue;
    if (RESPONSIBILITY_HEADER.test(l)) continue;
    if (QUALIFICATION_HEADER.test(l)) continue;
    if (l.length < 200 && /(degree|bachelor|master|ph\.?d|year|experience|strong|proficiency|familiar|knowledge|understanding|ability|communication|problem|portfolio|degree in)/i.test(l)) {
      out.push(l.charAt(0).toUpperCase() + l.slice(1));
    }
  }
  return out.slice(0, 12);
};

const parseJob = ({ jobTitle = '', company = '', description = '' }) => {
  const text = clean(description);
  const lines = String(description || '')
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);

  const allSkills = matchSkills(text);

  // Walk the document and split the requirements zone into must-have lines and
  // preferred/"is a plus" lines so AWS/Kubernetes in "- X is a plus." bullets
  // are correctly classified as preferred instead of required.
  const reqLines = [];
  const prefLines = [];
  let inReqZone = false;
  for (const l of lines) {
    if (REQUIRED_ZONE_START.test(l)) inReqZone = true;
    else if (RESPONSIBILITY_HEADER.test(l)) inReqZone = false;
    else if (inReqZone) {
      if (PREFERRED_LINE.test(l)) prefLines.push(l);
      else reqLines.push(l);
    }
  }

  let requiredSkills, preferredSkills;
  const reqCoreSkills = matchSkills(reqLines.join(' '));
  const prefLineSkills = matchSkills(prefLines.join(' '));

  if (reqCoreSkills.length) {
    requiredSkills = reqCoreSkills;
    preferredSkills = [...new Set([
      ...prefLineSkills,
      ...allSkills.filter((s) => !reqCoreSkills.includes(s)),
    ])];
  } else {
    // No requirements section detected: treat explicitly-preferred lines as
    // "preferred" and everything else as "required" (best-effort heuristic).
    requiredSkills = allSkills.filter((s) => !prefLineSkills.includes(s));
    preferredSkills = [...prefLineSkills];
  }

  const experienceMatch = text.match(/(\d+\s*\+?\s*years?)(?:\s*of)?\s*(?:relevant\s*)?(?:professional\s*)?experience/i);
  const experienceLevel = experienceMatch
    ? `${experienceMatch[1]} experience`
    : /fresher|entry.level|0-1 year/i.test(text)
    ? 'Entry level'
    : '';

  const educationMatch = text.match(/(bachelor|master|ph\.?d|b\.?tech|m\.?tech|b\.?sc|m\.?sc|mba|degree)[^.\n]*/i);

  return {
    requiredSkills,
    preferredSkills,
    responsibilities: parseResponsibilities(lines),
    qualifications: parseQualifications(lines),
    technologies: allSkills,
    experienceLevel,
    educationRequirement: educationMatch ? clean(educationMatch[0]).slice(0, 160) : '',
  };
};

module.exports = { parseJob, matchSkillsFull };