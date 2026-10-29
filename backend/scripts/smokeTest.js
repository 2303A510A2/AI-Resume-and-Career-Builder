// Smoke test for the AI Resume & Career Builder backend.
// Run: node scripts/smokeTest.js   (requires the backend to be running on PORT)
/* eslint-disable no-console */
const BASE = process.env.SMOKE_BASE || 'http://localhost:5000/api';
const zlib = require('zlib');

// Minimal PNG encoder (no external deps): Groq's vision models reject images
// smaller than 32x32px, so a real-sized image is required for the vision path.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
};
const makePng = (size = 32) => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = row + 1 + x * 3;
      raw[p] = 210; // R
      raw[p + 1] = 40 + (x % 60); // G gradient
      raw[p + 2] = 40 + (y % 60); // B gradient
    }
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
};

let passed = 0;
let failed = 0;
const failures = [];

const log = (name, ok, extra = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

const req = async (method, path, body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
};

const main = async () => {
  console.log('\n=== 1. Health ===');
  const health = await req('GET', '/health');
  log('GET /api/health', health.status === 200 && health.data?.success);
  log('health reports aiProvider', ['not-configured', 'configured', 'checking', 'unreachable'].includes(health.data?.aiProvider), `aiProvider=${health.data?.aiProvider}`);
  log('health reports vision status', ['configured', 'not-configured'].includes(health.data?.services?.vision), `vision=${health.data?.services?.vision}`);
  log('health reports speechToText status', ['configured', 'not-configured'].includes(health.data?.services?.speechToText), `stt=${health.data?.services?.speechToText}`);
  log('health reports textToSpeech status', ['configured', 'not-configured'].includes(health.data?.services?.textToSpeech), `tts=${health.data?.services?.textToSpeech}`);

  console.log('\n=== 2. Auth: register ===');
  const email = `smoke_${Date.now()}@test.dev`;
  const password = 'Secret123';
  const reg = await req('POST', '/auth/register', {
    name: 'Smoke Tester', email, password, confirmPassword: password,
  });
  log('register', reg.status === 201 && !!reg.data.token, email);
  const userToken = reg.data?.token;

  console.log('\n=== 3. Auth: validation ===');
  const badReg = await req('POST', '/auth/register', { name: '', email: 'not-an-email', password: 'x', confirmPassword: 'x' });
  log('register rejects invalid input', badReg.status === 400);
  const dupReg = await req('POST', '/auth/register', { name: 'X', email, password: 'Secret123', confirmPassword: 'Secret123' });
  log('register rejects duplicate email', dupReg.status === 409);

  console.log('\n=== 4. Auth: login + me ===');
  const badLogin = await req('POST', '/auth/login', { email, password: 'WrongPass1' });
  log('login rejects wrong password', badLogin.status === 401);
  const loginRes = await req('POST', '/auth/login', { email, password });
  log('login', loginRes.status === 200 && !!loginRes.data.token);
  const meRes = await req('GET', '/auth/me', undefined, userToken);
  log('me (protected)', meRes.status === 200 && meRes.data.user?.email === email);
  const meNoToken = await req('GET', '/auth/me');
  log('me rejects missing token', meNoToken.status === 401);

  console.log('\n=== 5. Forgot password / OTP / reset ===');
  const forgot = await req('POST', '/auth/forgot-password', { email });
  log('forgot-password', forgot.status === 200, forgot.data?.message || '');
  const forgotGeneric = await req('POST', '/auth/forgot-password', { email: 'ghost@test.dev' });
  log('forgot-password hides account existence', forgotGeneric.status === 200);

  // Find the OTP from the server via a direct DB read is not possible here;
  // instead verify the OTP flow with a bad code, then confirm rate limiting works.
  const badOtp = await req('POST', '/auth/verify-otp', { email, otp: '000000' });
  log('verify-otp rejects wrong OTP', badOtp.status === 400, badOtp.data?.message || '');
  const noOtpReset = await req('POST', '/auth/reset-password', { resetToken: 'garbage', password: 'NewPass123', confirmPassword: 'NewPass123' });
  log('reset-password rejects bad token', noOtpReset.status === 400);

  console.log('\n=== 6. Resume upload (TXT) ===');
  const sample = [
    'Jane Doe',
    'jane.doe@example.com | +1 555 010 4242 | linkedin.com/in/janedoe | github.com/janedoe',
    'Software Engineer with 4 years of experience building web applications.',
    'Technical Skills',
    'Java, Python, JavaScript, React, Node.js, MongoDB, SQL, Docker, Spring Boot, Git',
    'Education',
    "Bachelor of Technology in Computer Science, State University, 2021",
    'Projects',
    'Music Application - A full-stack music streaming app built with React, Node.js and MongoDB with JWT authentication and file uploads.',
    'NLP Project - Sentiment analysis classifier using Python and scikit-learn.',
    'Experience',
    'Software Engineer, Acme Corp (2021 - Present) - Built REST APIs and microservices with Java and Spring Boot.',
  ].join('\n');

  const form = new FormData();
  form.append('resume', new Blob([sample], { type: 'text/plain' }), 'jane-doe-resume.txt');
  const upRes = await fetch(`${BASE}/resume/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: form,
  });
  const upData = await upRes.json();
  log('resume upload', upRes.status === 201, upData.message || '');
  const parsed = upData.resume?.parsed;
  log('resume parsed name', parsed?.name === 'Jane Doe', parsed?.name);
  log('resume parsed skills (has Java)', parsed?.skills?.includes('Java'));
  log('resume parsed projects', Array.isArray(parsed?.projects) && parsed.projects.length > 0);

  const getRes = await req('GET', '/resume', undefined, userToken);
  log('get resume (owner)', getRes.status === 200);

  console.log('\n=== 7. RAG knowledge base ===');
  const jobPayload = {
    jobTitle: 'Senior Java Developer',
    company: 'TechCorp',
    description: [
      'We are looking for a Senior Java Developer.',
      'Requirements:',
      '- Strong experience with Java, Spring Boot, SQL, REST APIs and Docker.',
      '- Experience with AWS and Kubernetes is a plus.',
      '- Bachelor degree in Computer Science required.',
      'Responsibilities:',
      '- Design and develop scalable microservices.',
      '- Write clean, testable code.',
    ].join('\n'),
  };
  const saveJob = await req('POST', '/career/jobs', jobPayload, userToken);
  log('save job + analyze', saveJob.status === 201, saveJob.data?.analysis ? `match ${saveJob.data.analysis.matchPercent}%` : '');
  const skillGap = await req('GET', '/career/skill-gap', undefined, userToken);
  const gap = skillGap.data?.gap;
  log('skill gap', skillGap.status === 200 && gap, `matched=${gap?.matched?.length} missing=${gap?.missing?.length} match=${gap?.matchPercent}%`);
  log('skill gap: Java matched', skillGap.status === 200 && gap?.matched?.includes('Java'));
  log('skill gap: Docker matched (resume contains Docker)', skillGap.status === 200 && gap?.matched?.includes('Docker'));
  log('skill gap: REST API matched (plural form)', skillGap.status === 200 && gap?.matched?.includes('REST API'));
  log('skill gap: full required coverage', skillGap.status === 200 && gap?.matchPercent === 100 && gap?.missing?.length === 0, `match=${gap?.matchPercent}% missing=${gap?.missing?.length}`);
  log('skill gap: preferred skills not counted as missing', skillGap.status === 200 && !gap?.missing?.includes('AWS') && (gap?.matchedPreferred || []).length >= 0);

  const analyze = await req('POST', '/career/analyze', {}, userToken);
  log('re-run analysis', analyze.status === 200 && analyze.data?.analysis);

  console.log('\n=== 8. Chat (graceful with or without an AI key) ===');
  const chatBefore = await req('POST', '/chat', { message: 'What should I prepare for this job?' }, userToken);
  const chatGraceful = [200, 400, 502, 503].includes(chatBefore.status);
  log('chat call handled gracefully', chatGraceful, `status=${chatBefore.status} — ${chatBefore.data?.message?.slice(0, 60) || ''}`);
  const chatAi = await req('POST', '/ai/career-assistant', { message: 'Hi', documentIds: [] }, userToken);
  const chatAiOk = [200, 400, 502, 503].includes(chatAi.status);
  const chatAiExtra = chatAi.status === 200 ? ` resources=${(chatAi.data?.resources || []).length}` : '';
  log('/ai/career-assistant handled gracefully', chatAiOk, `status=${chatAi.status}${chatAiExtra}`);

  // Regenerate endpoint: deterministic 400/404 guards, then graceful when a real
  // conversation exists (with an AI key the answer is genuinely re-run).
  const regenNoBody = await req('POST', '/ai/career-assistant/regenerate', {}, userToken);
  log('regenerate requires conversationId', regenNoBody.status === 400, `status=${regenNoBody.status}`);
  const regenUnknown = await req('POST', '/ai/career-assistant/regenerate', { conversationId: '000000000000000000000000' }, userToken);
  log('regenerate rejects unknown conversation', regenUnknown.status === 404, `status=${regenUnknown.status}`);
  const regenChatId = chatAi.status === 200 ? chatAi.data?.conversationId : undefined;
  if (regenChatId) {
    const regen = await req('POST', '/ai/career-assistant/regenerate', { conversationId: regenChatId }, userToken);
    log('regenerate handled gracefully', [200, 502, 503].includes(regen.status), `status=${regen.status}`);
  } else {
    log('regenerate handled gracefully', true, 'skipped (no AI conversation available)');
  }

  console.log('\n=== 8c. Image generation contract (no provider key needed) ===');
  // These assert the CONTRACT only — auth, validation, ownership and the fact
  // that ordinary text AI is never routed to the image path. They must pass with
  // no image key at all (CI included). The real generation pipeline, including
  // follow-ups and regeneration, is covered by scripts/imageTest.js.
  log(
    'health reports image generation status',
    ['configured', 'not-configured', 'misconfigured'].includes(health.data?.services?.imageGeneration),
    `imageGeneration=${health.data?.services?.imageGeneration} provider=${health.data?.services?.imageProvider} model=${health.data?.services?.imageModel}`
  );
  const imgNoAuth = await req('POST', '/ai/generate-image', { prompt: 'a red car' });
  log('POST /ai/generate-image requires auth', imgNoAuth.status === 401, `status=${imgNoAuth.status}`);
  const imgBlank = await req('POST', '/ai/generate-image', { prompt: '   ' }, userToken);
  log('POST /ai/generate-image rejects an empty prompt', imgBlank.status === 400, `status=${imgBlank.status}`);
  const imgBytesNoAuth = await req('GET', '/ai/images/000000000000000000000000');
  log('GET /ai/images/:id requires auth', imgBytesNoAuth.status === 401, `status=${imgBytesNoAuth.status}`);
  const imgBytesUnknown = await req('GET', '/ai/images/000000000000000000000000', undefined, userToken);
  log('GET /ai/images/:id 404s for an unknown image', imgBytesUnknown.status === 404, `status=${imgBytesUnknown.status}`);
  // A text question must NEVER come back with an image.
  const textNoImage = await req('POST', '/ai/career-assistant', { message: 'What is Java?', documentIds: [] }, userToken);
  if ([200, 502, 503].includes(textNoImage.status)) {
    log(
      'a normal text question is never answered with an image',
      !textNoImage.data?.image,
      `status=${textNoImage.status} image=${textNoImage.data?.image ? 'present' : 'none'}`
    );
  } else {
    log('a normal text question is never answered with an image', true, `skipped (status=${textNoImage.status})`);
  }

  console.log('\n=== 8d. Duplicate request protection (requestId dedup) ===');
  // The frontend sends a unique requestId per message. A genuine duplicate
  // (double-click / re-render / client retry) must NOT trigger a second LLM
  // call, and the second response must say deduped:true.
  const rid = `smoke_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const dedupA = await req('POST', '/ai/career-assistant', { message: 'Hi', documentIds: [], requestId: rid }, userToken);
  if (dedupA.status === 200) {
    const dedupB = await req('POST', '/ai/career-assistant', { message: 'Hi', documentIds: [], requestId: rid }, userToken);
    log('duplicate requestId is deduped (no 2nd LLM call)', dedupB.status === 200 && dedupB.data?.deduped === true, `status=${dedupB.status} deduped=${dedupB.data?.deduped}`);
    log('deduped response still returns the answer + requestId', dedupB.status === 200 && !!dedupB.data?.message?.content && dedupB.data?.requestId === rid, `status=${dedupB.status} hasContent=${!!dedupB.data?.message?.content}`);
  } else {
    log('duplicate requestId is deduped (no 2nd LLM call)', true, `skipped (first call status=${dedupA.status}, no LLM key/graceful mode)`);
  }
  // A DIFFERENT requestId must always be treated as a fresh message.
  const freshRid = `${rid}_fresh`;
  const freshRes = await req('POST', '/ai/career-assistant', { message: 'Hi', documentIds: [], requestId: freshRid }, userToken);
  log('different requestId is a fresh message', freshRes.status === 200 ? freshRes.data?.deduped === false : true, `status=${freshRes.status}`);

  console.log('\n=== 8c. Voice endpoints (graceful, no secrets leaked) ===');
  const noAudio = await req('POST', '/ai/transcribe', {}, userToken);
  log('transcribe rejects missing audio', noAudio.status === 400, `status=${noAudio.status}`);
  const badAudioForm = new FormData();
  badAudioForm.append('audio', new Blob([Buffer.from('this is definitely not valid audio bytes')], { type: 'audio/webm' }), 'bad.wav');
  const badAudio = await fetch(`${BASE}/ai/transcribe`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: badAudioForm,
  });
  const badAudioData = await badAudio.json().catch(() => ({}));
  const msgLower = String(badAudioData.message || '').toLowerCase();
  const noSecretLeak = !/api[_-]?key|authorization|bearer|groq\.com|llm_api|sk-/.test(msgLower);
  log('transcribe with invalid audio fails gracefully (no secrets)', [400, 422, 502, 503].includes(badAudio.status) && noSecretLeak, `status=${badAudio.status} msg="${String(badAudioData.message || '').slice(0, 60)}"`);
  const speechNoText = await req('POST', '/ai/speech', {}, userToken);
  log('speech requires text', speechNoText.status === 400, `status=${speechNoText.status}`);
  const speechRes = await req('POST', '/ai/speech', { text: 'Hello from the smoke test' }, userToken);
  const speechOk = speechRes.status === 200 || [502, 503].includes(speechRes.status);
  log('speech handled gracefully (TTS off -> 503, TTS on -> audio)', speechOk, `status=${speechRes.status}${speechRes.status === 200 ? ' (audio bytes)' : ''}`);
  const transcribeNoAuth = await req('POST', '/ai/transcribe', {});
  log('transcribe requires auth', transcribeNoAuth.status === 401, `status=${transcribeNoAuth.status}`);

  console.log('\n=== 9. Roadmap / coding / interview (REAL AI when configured) ===');
  // Roadmap create returns 201 (resource created); a provider/graceful failure
  // path may return 400/502/503 — both are acceptable outcomes of the endpoint.
  const roadmap = await req('POST', '/career/roadmap/generate', {}, userToken);
  const roadmapCreated = [200, 201].includes(roadmap.status) && !!roadmap.data?.roadmap;
  log('roadmap endpoint handled gracefully', roadmapCreated || [400, 502, 503].includes(roadmap.status), `status=${roadmap.status} — ${roadmap.data?.message?.slice(0, 50) || ''}`);
  const prog = await req('PUT', '/career/roadmap/progress', { phaseIndex: 0, topicIndex: 0, status: 'completed' }, userToken);
  const progOk = roadmapCreated ? prog.status === 200 : prog.status === 404;
  log('roadmap progress behaves (needs existing roadmap)', progOk, `status=${prog.status}`);
  if (roadmapCreated) await req('DELETE', '/career/roadmap', undefined, userToken);
  const coding = await req('POST', '/career/coding/generate', { topic: 'Arrays', difficulty: 'Easy' }, userToken);
  const codingOk = coding.status === 200 || [400, 502, 503].includes(coding.status);
  log('coding problems endpoint handled gracefully', codingOk, `status=${coding.status} — ${coding.data?.message?.slice(0, 50) || ''}`);
  const interview = await req('POST', '/interview/generate', { category: 'java', count: 4 }, userToken);
  log('interview questions endpoint handled gracefully', [200, 201, 400, 502, 503].includes(interview.status), `status=${interview.status}`);
  const mock = await req('POST', '/interview/mock/start', { category: 'technical', count: 3 }, userToken);
  log('mock interview endpoint handled gracefully', [200, 201, 400, 502, 503].includes(mock.status), `status=${mock.status}`);

  const improve = await req('POST', '/resume/improve', { feature: 'summary', text: 'I worked on web apps using Java.' }, userToken);
  const improveOk = (improve.status === 200 && improve.data?.improved) || [502, 503].includes(improve.status);
  log('resume improve (graceful)', improveOk, improve.status === 200 && improve.data?.aiConfigured === false ? 'aiConfigured=false (no key)' : `status=${improve.status}`);

  console.log('\n=== 10. Chat history ===');
  const chats = await req('GET', '/chat', undefined, userToken);
  log('list chats', chats.status === 200 && Array.isArray(chats.data?.chats));

  console.log('\n=== 11. Cross-user isolation ===');
  const otherReg = await req('POST', '/auth/register', {
    name: 'Other User', email: `other_${Date.now()}@test.dev`, password: 'Secret123', confirmPassword: 'Secret123',
  });
  const otherToken = otherReg.data?.token;
  const otherChatId = chats.data?.chats?.[0]?._id;
  const crossAccess = otherChatId
    ? await req('GET', `/chat/${otherChatId}`, undefined, otherToken)
    : null;
  log('user cannot read another user\'s chat', crossAccess ? crossAccess.status === 404 : true);

  // File/document isolation: user B must never see, read, or delete user A's files.
  const fileForm = new FormData();
  fileForm.append('file', new Blob(['user A secret document'], { type: 'text/plain' }), 'a-secret.txt');
  const fileUp = await fetch(`${BASE}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: fileForm,
  });
  const fileUpData = await fileUp.json();
  const docId = fileUpData.document?.id || fileUpData.document?._id;
  log('generic file upload', fileUp.status === 201 && !!docId, docId ? '' : (fileUpData.message || ''));
  const otherFiles = await req('GET', '/files', undefined, otherToken);
  log('user B sees no user A documents', otherFiles.status === 200 && (otherFiles.data?.documents || []).length === 0);
  const docDel = docId ? await req('DELETE', `/files/${docId}`, undefined, otherToken) : null;
  log('user B cannot delete user A document', docDel ? docDel.status === 404 : true);

  console.log('\n=== 11b. Image upload + vision endpoints ===');
  // 32x32 valid PNG -> stored with real pixels (hasImage:true) for AI vision.
  // (Groq's vision models reject images under 32px per dimension with a 400.)
  const png = makePng(32);
  const imgForm = new FormData();
  imgForm.append('file', new Blob([png], { type: 'image/png' }), 'vision.png');
  const imgUp = await fetch(`${BASE}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
    body: imgForm,
  });
  const imgUpData = await imgUp.json();
  const imgId = imgUpData.document?.id || imgUpData.document?._id;
  log('image upload stores pixels (hasImage)', imgUp.status === 201 && imgUpData.document?.hasImage === true, imgUpData.document?.hasImage == null ? (imgUpData.message || '') : '');

  // GET /files/:id/image -> owner 200 (real PNG bytes); no token 401; other user 404.
  if (imgId) {
    const imgOwner = await fetch(`${BASE}/files/${imgId}/image`, { headers: { Authorization: `Bearer ${userToken}` } });
    const imgBytes = Buffer.from(await imgOwner.arrayBuffer());
    log('owner can fetch image bytes', imgOwner.status === 200 && imgBytes.length > 0 && imgBytes[0] === 0x89, `status=${imgOwner.status} bytes=${imgBytes.length}`);
    const imgNoAuth = await fetch(`${BASE}/files/${imgId}/image`);
    log('image requires auth', imgNoAuth.status === 401, `status=${imgNoAuth.status}`);
    const imgOther = await fetch(`${BASE}/files/${imgId}/image`, { headers: { Authorization: `Bearer ${otherToken}` } });
    log('other user cannot read the image', imgOther.status === 404, `status=${imgOther.status}`);
    // Chat with the image attached: must be handled gracefully and never leak
    // provider internals (vision ON -> 200 real analysis; vision OFF -> clean note).
    const chatWithImg = await req('POST', '/ai/career-assistant', { message: 'What is in this image?', documentIds: [imgId] }, userToken);
    const chatImgOk = [200, 400, 502, 503].includes(chatWithImg.status);
    const chatImgMsg = String(chatWithImg.data?.message?.content || chatWithImg.data?.message || '').toLowerCase();
    const chatImgClean = !/api[_-]?key|authorization|bearer|groq\.com|llm_api|sk-|fetch failed|econnreset/.test(chatImgMsg);
    log('chat with image attachment handled gracefully (no secrets)', chatImgOk && chatImgClean, `status=${chatWithImg.status}`);
  } else {
    log('owner can fetch image bytes', true, 'skipped (image upload failed)');
    log('image requires auth', true, 'skipped (image upload failed)');
    log('other user cannot read the image', true, 'skipped (image upload failed)');
    log('chat with image attachment handled gracefully (no secrets)', true, 'skipped (image upload failed)');
  }

  console.log('\n=== 12. Admin ===');
  // Admin identities now live on the User collection (roles user / co_admin /
  // main_admin). The old separate `admin@careerai.app` document is unused and
  // must no longer authenticate.
  const legacyAdmin = await req('POST', '/admin/login', { email: 'admin@careerai.app', password: 'Admin@12345' });
  log('legacy separate-admin login rejected', legacyAdmin.status === 401 || legacyAdmin.status === 403, `status=${legacyAdmin.status}`);

  const badAdmin = await req('POST', '/admin/login', { email, password: 'WrongPass1' });
  log('admin login rejects wrong password', badAdmin.status === 401);

  const userDenied = await req('GET', '/admin/stats', undefined, userToken);
  log('normal user blocked from admin', userDenied.status === 403);

  // A normal account that tries the admin portal must be told it has NO admin
  // access and MAY request it — a request alone grants no session/permissions.
  const notAdmin = await req('POST', '/admin/login', { email, password });
  log('normal account is told it has no admin access', notAdmin.status === 403 && notAdmin.data?.code === 'NOT_ADMIN' && notAdmin.data?.canRequest === true, `code=${notAdmin.data?.code}`);
  const reqStatus = await req('GET', '/admin/request/status', undefined, userToken);
  log('ordinary user reads own admin-request status', reqStatus.status === 200 && reqStatus.data?.request === null && reqStatus.data?.canRequest === true);

  // There is deliberately NO "make me an admin" API, so to exercise the
  // listing/delete endpoints we promote a throwaway account DIRECTLY in the
  // database, then sign in through the normal admin login. It is removed again
  // in section 13. (MongoDB is a documented requirement for this suite.)
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  let adminToken = null;
  let adminUsers = { data: { users: [] } };
  let testAdmin = null; // { mongoose, User, adminId }
  if (!MONGO_URI) {
    log('admin listing endpoints (needs a test admin)', false, 'MONGO_URI is not set on the backend');
  } else {
    const mongoose = require('mongoose');
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    const User = require('../models/User');

    // Register through the PUBLIC API so the password is hashed normally, then
    // grant the role directly (a real admin is only ever created by the Main
    // Admin Leader's approval flow).
    const makeCoAdmin = async (label) => {
      const email = `${label}_${Date.now()}_${Math.floor(Math.random() * 1e4)}@test.dev`;
      const r = await req('POST', '/auth/register', { name: label, email, password, confirmPassword: password });
      const id = r.data?.user?._id;
      const d = await User.findById(id).select('+password');
      d.role = 'co_admin';
      d.mustChangePassword = false;
      d.adminPermissions = { manageUsers: true, deleteUsers: true, manageResumes: true, manageRequests: true, viewAudit: true, manageSettings: true };
      await d.save();
      return { id, email };
    };
    const adminA = await makeCoAdmin('smoke_admin');
    const adminB = await makeCoAdmin('smoke_admin2');
    const adminEmail = adminA.email;

    const adminLogin = await req('POST', '/admin/login', { email: adminEmail, password });
    adminToken = adminLogin.data?.token;
    log('approved admin can sign in', adminLogin.status === 200 && !!adminToken && adminLogin.data?.admin?.role === 'co_admin');

    const adminStats = await req('GET', '/admin/stats', undefined, adminToken);
    log('admin stats', adminStats.status === 200, `users=${adminStats.data?.stats?.totalUsers}`);
    adminUsers = await req('GET', '/admin/users?limit=50', undefined, adminToken);
    log('admin list users', adminUsers.status === 200 && adminUsers.data?.users?.length > 0);
    const adminResumes = await req('GET', '/admin/resumes', undefined, adminToken);
    log('admin list resumes', adminResumes.status === 200 && adminResumes.data?.resumes?.length > 0);

    const userForAdmin = adminUsers.data?.users?.find((u) => u.email === email);
    if (userForAdmin) {
      const detail = await req('GET', `/admin/users/${userForAdmin._id}`, undefined, adminToken);
      log('admin user detail (no password, no chat content)', detail.status === 200 && detail.data?.chatCount != null && detail.data?.user?.password === undefined);
    }
    // Server-side RBAC: a co-admin must NEVER be able to delete ANY administrator
    // account (only the Main Admin Leader may). Target a DIFFERENT co-admin so
    // this exercises the role check, not the "cannot delete yourself" guard.
    const delAdmin = await req('DELETE', `/admin/users/${adminB.id}`, { confirm: true }, adminToken);
    log('co-admin cannot delete an administrator', delAdmin.status === 403 && delAdmin.data?.code === 'PROTECTED_ACCOUNT', `status=${delAdmin.status} code=${delAdmin.data?.code}`);

    testAdmin = { mongoose, User, adminIds: [adminA.id, adminB.id] };
  }

  console.log('\n=== 13. Orphan cleanup: delete created users ===');
  if (adminToken) {
    const list = adminUsers.data?.users || [];
    const smokeUser = list.find((u) => u.email === email);
    if (smokeUser) {
      const del = await req('DELETE', `/admin/users/${smokeUser._id}`, { confirm: true }, adminToken);
      log('admin deletes user + cascade', del.status === 200);
    }
    const otherUser = list.find((u) => u.email === otherReg.data?.user?.email);
    if (otherUser) {
      const del = await req('DELETE', `/admin/users/${otherUser._id}`, { confirm: true }, adminToken);
      log('admin deletes secondary test user', del.status === 200);
    }
  }
  if (testAdmin) {
    try { await testAdmin.User.deleteMany({ _id: { $in: testAdmin.adminIds } }); } catch { /* ignore */ }
    try { await testAdmin.mongoose.disconnect(); } catch { /* ignore */ }
  }
  // If no test admin was available, still remove our own accounts through the
  // user-facing self-service deletion so the database is never left dirty.
  if (!adminToken) {
    const selfA = await req('DELETE', '/settings/account', { password }, userToken);
    const selfB = await req('DELETE', '/settings/account', { password: 'Secret123' }, otherToken);
    log('self-service cleanup (no admin available)', selfA.status === 200 && selfB.status === 200, `a=${selfA.status} b=${selfB.status}`);
  }

  console.log(`\n========================================`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  if (failures.length) console.log('Failed:', failures.join(', '));
  console.log('========================================\n');
  process.exit(failed ? 1 : 0);
};

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});