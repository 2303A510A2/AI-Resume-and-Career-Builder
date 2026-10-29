// Curated skill dictionary used by the resume/JD parsers for extraction and
// skill-gap matching. Each entry declares its category so parsed skills can be
// grouped into languages, frameworks, databases, cloud/devops/tools, and data.
//
// Also exports `matchSkills(text)`, the single shared matcher used by both the
// resume parser and the job parser. It:
//   - matches longest names first ("Spring Boot" wins over "Spring"),
//   - tolerates simple plurals ("REST APIs" still matches "REST API",
//     "microservice" still matches "Microservices"),
//   - drops shorter names whose match is fully inside a longer match
//     ("Spring" inside "Spring Boot" is not reported separately).

const SKILL_DB = [
  // Languages
  ...[
    'JavaScript', 'TypeScript', 'Java', 'Python', 'C++', 'C#', 'Go', 'Rust',
    'Kotlin', 'Swift', 'Ruby', 'PHP', 'Scala', 'Perl', 'Dart', 'R', 'SQL',
    'HTML', 'CSS', 'Bash', 'PowerShell', 'MATLAB', 'Shell Scripting',
  ].map((name) => ({ name, categories: ['language'] })),

  // Frameworks & libraries
  ...[
    'React', 'React Native', 'Angular', 'Vue.js', 'Next.js', 'Node.js',
    'Express.js', 'Django', 'Flask', 'Spring Boot', 'Spring', 'Laravel',
    'Ruby on Rails', 'ASP.NET', '.NET Core', 'FastAPI', 'GraphQL', 'Redux',
    'jQuery', 'Bootstrap', 'Tailwind CSS', 'Svelte', 'Hibernate', 'MyBatis',
    'JUnit', 'Selenium', 'Cypress', 'Socket.io', 'Three.js', 'D3.js',
  ].map((name) => ({ name, categories: ['framework'] })),

  // Databases & storage
  ...[
    'MongoDB', 'MySQL', 'PostgreSQL', 'Oracle', 'SQLite', 'Redis',
    'Cassandra', 'DynamoDB', 'Elasticsearch', 'Firebase', 'Firestore',
    'Microsoft SQL Server', 'Neo4j', 'Kafka',
  ].map((name) => ({ name, categories: ['db', 'tool'] })),

  // Cloud, DevOps & tools
  ...[
    'AWS', 'Azure', 'Google Cloud', 'GCP', 'Docker', 'Kubernetes',
    'Terraform', 'Jenkins', 'GitHub Actions', 'CI/CD', 'Linux', 'Nginx',
    'Ansible', 'Git', 'Jira', 'Confluence', 'RabbitMQ', 'REST API',
    'Microservices', 'Agile', 'Scrum', 'OOP', 'Data Structures',
    'Algorithms', 'System Design', 'Webpack', 'Vite', 'Jest', 'Mocha',
    'Postman', 'Serverless', 'Lambda', 'S3', 'EC2',
  ].map((name) => ({ name, categories: ['tool', 'cloud'] })),

  // Data / AI / ML
  ...[
    'Machine Learning', 'Deep Learning', 'Natural Language Processing',
    'NLP', 'TensorFlow', 'PyTorch', 'Pandas', 'NumPy', 'Scikit-learn',
    'Data Analysis', 'Data Science', 'Big Data', 'Hadoop', 'Spark', 'Tableau',
    'Power BI', 'Excel', 'OpenCV', 'LangChain', 'LLM', 'RAG',
  ].map((name) => ({ name, categories: ['data', 'ai'] })),
];

// ---- Shared matcher -------------------------------------------------------

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Builds a plural-tolerant, word-boundary regex for a skill name.
 * - "REST API"        -> \brest apis?\b      (matches "REST API" / "REST APIs")
 * - "Microservices"   -> \bmicroservices?\b  (matches both for the base form)
 * - "Spring Boot"     -> \bspring boots?\b
 * Short names (C, R, Go, S3, ...) stay exact to avoid false positives.
 */
const buildPattern = (name) => {
  if (name === 'C') return /\bc\b/;
  if (name === 'C++') return /\bc\+\+\b/;
  if (name === 'C#') return /\bc#\b/;

  const words = String(name).toLowerCase().split(/\s+/);
  if (name.length < 3) {
    return new RegExp(`\\b${words.map(escapeRegExp).join('\\s+')}\\b`);
  }

  const last = words[words.length - 1];
  // Strip a trailing "s" so a plural dictionary entry also matches the singular
  // form ("structures" -> "structures?" matches "structure" and "structures").
  const base = /s$/.test(last) && last.length > 3 ? last.slice(0, -1) : last;
  const lastPat = `${escapeRegExp(base)}s?`;
  const body = [...words.slice(0, -1).map(escapeRegExp), lastPat].join('\\s+');
  return new RegExp(`\\b${body}\\b`);
};

const MATCHERS = [...new Map(SKILL_DB.map((e) => [e.name, e])).values()]
  .map((e) => ({ name: e.name, re: buildPattern(e.name) }))
  .sort((a, b) => b.name.length - a.name.length);

/**
 * Finds skill-dictionary matches in `text` (case-insensitive).
 * Returns unique skill names sorted alphabetically.
 */
const matchSkills = (text) => {
  const low = ` ${String(text || '').toLowerCase()} `;
  const hits = new Map(); // name -> array of [start, end] spans

  for (const { name, re } of MATCHERS) {
    const rx = new RegExp(re.source, 'g');
    const spans = [];
    let m;
    while ((m = rx.exec(low)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
    }
    if (spans.length) hits.set(name, spans);
  }

  // A name is reported only if it has at least one match span not fully covered
  // by a longer name's span ("Spring" inside "Spring Boot" is suppressed).
  const found = [];
  for (const [name, spans] of hits) {
    const independent = spans.some(([s, e]) => {
      for (const [other, otherSpans] of hits) {
        if (other === name) continue;
        if (otherSpans.some(([os, oe]) => os <= s && oe >= e && (os !== s || oe !== e))) {
          return false;
        }
      }
      return true;
    });
    if (independent) found.push(name);
  }

  return [...new Set(found)].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
};

module.exports = SKILL_DB;
module.exports.matchSkills = matchSkills;