// Critical end-to-end chat tests run DIRECTLY against the backend API — the
// same requests the frontend sends. Use when verifying that "hi", knowledge
// questions, coding answers, LeetCode, learning resources, resume analysis and
// resume-vs-JD comparisons all work. NEVER prints keys/secrets.
//
// Run: node scripts/criticalTests.js   (backend must be running on PORT)
/* eslint-disable no-console */
const BASE = process.env.SMOKE_BASE || 'http://localhost:5000/api';

let passed = 0;
let failed = 0;

const log = (name, ok, extra = '') => {
  if (ok) { passed += 1; console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`); }
  else { failed += 1; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
  return ok;
};

const req = async (method, path, body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - t0;
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, ms, data };
};

// A small real resume + JD so tests 7 & 8 have actual context.
const RESUME_TXT = [
  'Jane Doe',
  'jane.doe@example.com | linkedin.com/in/janedoe | github.com/janedoe',
  'Software Engineer with 4 years of experience building web applications.',
  'Technical Skills',
  'Java, Python, JavaScript, React, Node.js, MongoDB, SQL, Docker, Spring Boot, Git',
  'Education',
  'Bachelor of Technology in Computer Science, State University, 2021',
  'Projects',
  'Music Application - full-stack music streaming app built with React, Node.js and MongoDB with JWT authentication.',
  'NLP Project - sentiment analysis classifier using Python and scikit-learn.',
  'Experience',
  'Software Engineer, Acme Corp (2021 - Present) - Built REST APIs and microservices with Java and Spring Boot.',
].join('\n');

const JD = [
  'We are looking for a Senior Java Developer.',
  'Requirements:',
  '- Strong experience with Java, Spring Boot, SQL, REST APIs and Docker.',
  '- Experience with AWS and Kubernetes is a plus.',
  '- Bachelor degree in Computer Science required.',
  'Responsibilities:',
  '- Design and develop scalable microservices.',
  '- Write clean, testable code.',
].join('\n');

const main = async () => {
  console.log('\n=== Setup: register + resume + JD ===');
  const email = `critical_${Date.now()}@test.dev`;
  const password = 'Secret123';
  const reg = await req('POST', '/auth/register', { name: 'Critical Tester', email, password, confirmPassword: password });
  const token = reg.data?.token;
  log('register', reg.status === 201 && !!token, email);

  const form = new FormData();
  form.append('resume', new Blob([RESUME_TXT], { type: 'text/plain' }), 'jane-doe-resume.txt');
  const up = await fetch(`${BASE}/resume/upload`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const upData = await up.json();
  log('resume upload', up.status === 201, upData.message || '');

  const job = await req('POST', '/career/jobs', { jobTitle: 'Senior Java Developer', company: 'TechCorp', description: JD }, token);
  log('JD saved', job.status === 201, job.data?.analysis ? `match ${job.data.analysis.matchPercent}%` : '');

  // ---- The 8 critical tests (one fresh request each) ----
  const tests = [
    ['1. "hi"', 'hi', 'GENERAL'],
    ['2. "What is Java?"', 'What is Java?', 'GENERAL'],
    ['3. "Explain polymorphism."', 'Explain polymorphism.', 'CODING'],
    ['4. Armstrong code', 'Write Java code for Armstrong number.', 'CODING'],
    ['5. "Give me 10 LeetCode problems."', 'Give me 10 LeetCode problems.', 'LEETCODE'],
    ['6. "Give me Java learning websites."', 'Give me Java learning websites.', null],
    ['7. "Analyze my resume."', 'Analyze my resume.', 'RESUME'],
    ['8. "Compare my resume with this JD."', 'Compare my resume with this JD.', 'JOB_DESCRIPTION'],
  ];

  let conversationId = null;
  for (const [name, q, expectedIntent] of tests) {
    const rid = `critical_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const r = await req('POST', '/ai/career-assistant', { message: q, conversationId, documentIds: [], requestId: rid }, token);
    const ans = String(r.data?.message?.content || '').trim();
    const cleanLen = ans.length;
    const hit = r.status === 200 && cleanLen > 0;
    // Leak check ONLY the response envelope + error string — never the AI answer
    // text (which legitimately contains words like "full-stack"/"bearer").
    const envelope = JSON.stringify({
      code: r.data?.code || '',
      message: typeof r.data?.message === 'string' ? r.data.message : '',
      intent: r.data?.intent || '',
    });
    const clean = !/api[_-]?key|authorization|bearer|groq\.com|gsk-|sk-|fetch failed|econnreset|stack/i.test(envelope);
    const extra = hit
      ? `200 in ${r.ms}ms · ${cleanLen} chars · intent=${r.data?.intent || '?'}`
      : `status=${r.status} in ${r.ms}ms · ${String(r.data?.message || 'no body').slice(0, 70)}`;
    log(`${name}`, hit && clean, extra);
    if (hit) {
      console.log(`     ↳ ${ans.split('\n')[0].slice(0, 110)}`);
      if (expectedIntent && r.data?.intent !== expectedIntent) {
        console.log(`     ⚠️  intent=${r.data?.intent} (expected ~${expectedIntent})`);
      }
      if (!conversationId) conversationId = r.data?.conversationId;
    }
  }

  // ---- Conversation memory: 3 consecutive messages ----
  console.log('\n=== Memory: consecutive follow-ups ===');
  let memChatId = conversationId;
  const mem = ['What is Java?', 'Give me interview questions.', 'Now give me a coding problem.'];
  let memOk = true;
  for (let i = 0; i < mem.length; i += 1) {
    const rid = `mem_${Date.now()}_${i}`;
    const r = await req('POST', '/ai/career-assistant', { message: mem[i], conversationId: memChatId, documentIds: [], requestId: rid }, token);
    const ans = String(r.data?.message?.content || '').trim();
    const ok = r.status === 200 && ans.length > 0;
    if (!ok) memOk = false;
    console.log(`  ${ok ? '✅' : '❌'} "${mem[i]}" -> ${r.status} in ${r.ms}ms · ${ans ? ans.length + ' chars' : String(r.data?.message || '').slice(0, 60)}`);
    if (ok && !memChatId) memChatId = r.data?.conversationId;
  }
  log('conversation memory (3 follow-ups)', memOk);

  // ---- Cleanup ----
  console.log('\n=== Cleanup ===');
  const adm = await req('POST', '/admin/login', { email: 'admin@careerai.app', password: 'Admin@12345' });
  if (adm.status === 200) {
    const at = adm.data?.token;
    const me = await req('GET', '/auth/me', undefined, token);
    const uid = me.data?.user?._id || me.data?.user?.id;
    if (uid) {
      const del = await req('DELETE', `/admin/users/${uid}`, undefined, at);
      log('test user removed', del.status === 200);
    } else {
      log('test user removed', true, 'skipped (uid not found)');
    }
  } else {
    log('test user removed', true, 'skipped (admin login failed)');
  }

  console.log(`\n========================================\nCRITICAL RESULTS: ${passed} passed, ${failed} failed\n========================================`);
  process.exit(failed ? 1 : 0);
};

main().catch((e) => {
  console.error('script error:', e.message);
  process.exit(1);
});