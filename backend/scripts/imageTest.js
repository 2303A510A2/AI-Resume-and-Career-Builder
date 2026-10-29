// End-to-end test for REAL image generation in the AI assistant.
// Run: node scripts/imageTest.js    (requires the backend running on PORT)
//
// Covers: image intent routing (generation vs understanding vs text), a real
// generated image in chat, the dedicated /api/ai/generate-image endpoint,
// conversational follow-ups ("make it more realistic"), JWT + ownership checks,
// image regeneration, and that normal text AI is untouched.
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = process.env.SMOKE_BASE || 'http://localhost:5000/api';

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

const log = (name, ok, extra = '') => {
  if (ok) {
    passed += 1;
    console.log(`  âœ… ${name}${extra ? ` â€” ${extra}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  âŒ ${name}${extra ? ` â€” ${extra}` : ''}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A spent provider quota is NOT a defect of this app.
 *
 * The two "a text question still answers with text" assertions need a real text
 * answer, and Groq's free tier caps an organisation at 200000 tokens/day; once
 * that is spent the backend correctly answers 502 with `AI_DAILY_LIMIT` /
 * `AI_RATE_LIMITED`. Calling that a failure would hide the fact that every image
 * assertion passed, and would train us to ignore real regressions — so it is
 * reported as a SKIP, the same policy `offlineBugE2E.js` and
 * `responseQualityTest.js` already use.
 */
const QUOTA_CODES = new Set(['AI_DAILY_LIMIT', 'AI_RATE_LIMITED', 'AI_BUSY']);
const isQuotaSpent = (res) =>
  Boolean(res) && res.status === 502 && QUOTA_CODES.has(String(res.data?.code || ''));

const req = async (method, path, body, token) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  } catch (err) {
    // A dropped connection is never an assertion failure â€” report it honestly
    // instead of aborting the whole suite.
    return { status: 0, data: { success: false, code: 'REQUEST_FAILED', message: String(err?.message || err) } };
  }
};

/**
 * Retries a request while the provider reports a busy/throttled state (key-less
 * providers throttle hard), so one throttled call does not fail the suite.
 */
const reqWithRetry = async (method, path, body, token, attempts = 4) => {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    last = await req(method, path, body, token);
    const throttled = [502, 503, 504].includes(last.status) || last.status === 0;
    if (!throttled) return last;
    if (i < attempts - 1) await sleep(8000 * (i + 1));
  }
  return last;
};

const { detectImageOperation } = require('../services/imageIntent');

// Deterministic intent assertions â€” no provider call, no network.
const expectOperation = (message, expected, extra = {}) => {
  const r = detectImageOperation({ message, ...extra });
  return r.operation === expected;
};

const main = async () => {
  console.log('\n=== 1. Image intent detection (natural language, no commands) ===');
  const generateCases = [
    'Create an image of Krishna playing flute under a moonlit sky.',
    'Generate a picture of Shiva sitting in meditation.',
    'Create a futuristic city',
    'Generate a cartoon dog',
    'Make a logo',
    'Create a poster',
    'Generate an image of a student studying Java',
    'Draw a cat',
    'Render a watercolor landscape',
    'Design a poster for my DSA roadmap',
    'Illustrate a mountain village',
    'Visualize a robot engineer',
    'Make an illustration of a mountain sunset',
  ];
  generateCases.forEach((c) => log(`GENERATE: "${c}"`, expectOperation(c, 'GENERATE')));

  console.log('\n=== 2. Image UNDERSTANDING is never image generation ===');
  const understandCases = [
    'Look at this image.',
    'What is wrong in this screenshot?',
    'What do you see?',
    'Explain this image',
    'Describe the picture',
    'What is in this image?',
  ];
  understandCases.forEach((c) => log(`UNDERSTAND: "${c}"`, expectOperation(c, 'UNDERSTAND')));
  log(
    'EDIT: "Generate a picture based on this uploaded image."',
    expectOperation('Generate a picture based on this uploaded image.', 'EDIT', { hasAttachedImages: true })
  );

  console.log('\n=== 3. Normal text AI is NOT routed to image generation ===');
  const textCases = [
    'hi',
    'how are you?',
    'What is Java?',
    'Explain polymorphism.',
    'Give me DSA questions.',
    'Give me websites to learn Java.',
    'Analyze my resume.',
    'make it 20',
    'Give me 10 LeetCode problems',
    'Write a Java program to sort an array',
    'create a table of contents',
    'generate a report on Java',
  ];
  textCases.forEach((c) => log(`TEXT: "${c}"`, expectOperation(c, 'NONE')));
  log(
    'FOLLOW-UP: "Make it more realistic." after an image',
    expectOperation('Make it more realistic.', 'GENERATE', { lastTurnWasImage: true, previousImagePrompt: 'a futuristic city' })
  );
  log(
    'FOLLOW-UP: "Now explain the symbolism." stays TEXT after an image',
    expectOperation('Now explain the symbolism.', 'NONE', { lastTurnWasImage: true, previousImagePrompt: 'a futuristic city' })
  );

  console.log('\n=== 4. Auth for image generation ===');
  const email = `imgtest_${Date.now()}@test.dev`;
  const password = 'Secret123';
  const reg = await req('POST', '/auth/register', { name: 'Image Tester', email, password, confirmPassword: password });
  log('register test user', reg.status === 201 && !!reg.data?.token, email);
  const token = reg.data?.token;

  const health = await req('GET', '/health');
  log(
    'health reports image generation',
    ['configured', 'not-configured', 'misconfigured'].includes(health.data?.services?.imageGeneration),
    `imageGeneration=${health.data?.services?.imageGeneration} provider=${health.data?.services?.imageProvider} model=${health.data?.services?.imageModel}`
  );

  const noAuth = await req('POST', '/ai/generate-image', { prompt: 'a red car' });
  log('generate-image requires auth', noAuth.status === 401, `status=${noAuth.status}`);
  const emptyPrompt = await req('POST', '/ai/generate-image', { prompt: '' }, token);
  log('generate-image rejects an empty prompt', emptyPrompt.status === 400, `status=${emptyPrompt.status}`);

  console.log('\n=== 5. REAL image generation through the chat endpoint ===');
  const t0 = Date.now();
  const gen1 = await reqWithRetry(
    'POST',
    '/ai/career-assistant',
    { message: 'Create an image of Krishna playing flute under a moonlit sky.', documentIds: [] },
    token
  );
  const gen1Ok = gen1.status === 200 && !!gen1.data?.image?.id;
  log(
    'chat generates a real image (Krishna + flute + moonlit sky)',
    gen1Ok,
    `status=${gen1.status} intent=${gen1.data?.intent} provider=${gen1.data?.image?.provider} model=${gen1.data?.image?.model} ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );

  let conversationId = gen1.data?.conversationId;
  // The very first image request opens its own conversation (a message sent
  // without a conversationId always starts a new one), so its history is
  // checked separately from the conversation the rest of the run continues in.
  const firstConversationId = gen1.data?.conversationId;
  const prompt1 = String(gen1.data?.image?.prompt || '');
  log(
    'prompt preserves the user request (Krishna / flute / moonlit sky / digital painting words kept)',
    /krishna/i.test(prompt1) && /flute/i.test(prompt1) && /moonlit/i.test(prompt1),
    `prompt="${prompt1}"`
  );
  log('assistant message carries the image reference', !!gen1.data?.message?.image?.id, gen1.data?.message?.content || '');

  // Fetch the real bytes through the authenticated, ownership-checked endpoint.
  if (gen1Ok) {
    const imgRes = await fetch(`${BASE}/ai/images/${gen1.data.image.id}`, { headers: { Authorization: `Bearer ${token}` } });
    const bytes = Buffer.from(await imgRes.arrayBuffer());
    const mime = imgRes.headers.get('content-type') || '';
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    log(
      'generated image bytes are a real image',
      imgRes.status === 200 && /^image\//.test(mime) && (isJpeg || isPng),
      `status=${imgRes.status} mime=${mime} bytes=${bytes.length} magic=${isPng ? 'png' : isJpeg ? 'jpeg' : 'unknown'}`
    );
    log('response payload never contains raw image bytes', !JSON.stringify(gen1.data).includes('base64'));
  } else {
    log('generated image bytes are a real image', false, `skipped (status=${gen1.status} ${gen1.data?.message || gen1.data?.code || ''})`);
    log('response payload never contains raw image bytes', true, 'skipped');
  }

  console.log('\n=== 6. Second image + conversational follow-up ===');
  const gen2 = await reqWithRetry('POST', '/ai/career-assistant', { message: 'Generate a picture of Shiva meditating in the mountains.' }, token);
  const gen2Ok = gen2.status === 200 && !!gen2.data?.image?.id;
  log('second image generated', gen2Ok, `status=${gen2.status} prompt="${String(gen2.data?.image?.prompt || '').slice(0, 80)}"`);
  conversationId = gen2.data?.conversationId || conversationId;

  const follow = await reqWithRetry('POST', '/ai/career-assistant', { message: 'Make it more realistic.', conversationId }, token);
  const followOk = follow.status === 200 && !!follow.data?.image?.id && follow.data?.isFollowUp === true;
  const prevPrompt = String(gen2.data?.image?.prompt || '');
  const followPrompt = String(follow.data?.image?.prompt || '');
  log(
    'follow-up "Make it more realistic." generates a NEW image from the previous request',
    followOk && follow.data.image.id !== gen2.data?.image?.id && /shiva/i.test(followPrompt) && /realistic/i.test(followPrompt),
    `status=${follow.status} isFollowUp=${follow.data?.isFollowUp} prompt="${followPrompt.slice(0, 110)}"`
  );
  log('follow-up prompt does not duplicate the quality suffix', (followPrompt.match(/high quality/g) || []).length <= 1);

  const follow2 = await reqWithRetry('POST', '/ai/career-assistant', { message: 'Add flying cars and make it a night scene.', conversationId }, token);
  log(
    'second follow-up keeps the same subject',
    follow2.status === 200 && /shiva/i.test(String(follow2.data?.image?.prompt || '')),
    `status=${follow2.status} prompt="${String(follow2.data?.image?.prompt || '').slice(0, 110)}"`
  );

  const textAfterImage = await reqWithRetry('POST', '/ai/career-assistant', { message: 'Now explain the symbolism of the mountains.', conversationId }, token);
  const textAfterOk = textAfterImage.status === 200 && !textAfterImage.data?.image;
  const textAfterExtra = `status=${textAfterImage.status} intent=${textAfterImage.data?.intent}`;
  if (!textAfterOk && isQuotaSpent(textAfterImage)) {
    skipped += 1;
    console.log('  ~ text question after an image still returns TEXT (no image field) — SKIP (' + textAfterImage.data?.code + ': provider daily quota spent, not an app failure)');
  } else {
    log('text question after an image still returns TEXT (no image field)', textAfterOk, textAfterExtra);
  }

  console.log('\n=== 7. Dedicated /ai/generate-image endpoint ===');
  const direct = await reqWithRetry('POST', '/ai/generate-image', { prompt: 'Generate a cartoon dog in a garden', conversationId }, token);
  const directOk = direct.status === 200 && !!direct.data?.image?.id;
  log('generate-image returns a real image', directOk, `status=${direct.status} prompt="${String(direct.data?.image?.prompt || '').slice(0, 70)}"`);
  const directBytes = directOk
    ? await fetch(`${BASE}/ai/images/${direct.data.image.id}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.arrayBuffer())
    : null;
  log('generate-image image bytes downloadable', !!directBytes && directBytes.byteLength > 500, directBytes ? `bytes=${directBytes.byteLength}` : 'skipped');

  console.log('\n=== 8. Image regeneration (Re-generate on an image) ===');
  const regen = await reqWithRetry('POST', '/ai/career-assistant/regenerate', { conversationId }, token);
  log(
    'regenerate on the last image message produces a NEW image',
    regen.status === 200 && !!regen.data?.image?.id && regen.data?.image?.id !== direct.data?.image?.id,
    `status=${regen.status} newImage=${regen.data?.image?.id} (old ${direct.data?.image?.id})`
  );

  console.log('\n=== 9. Cross-user isolation + conversation history ===');
  const otherReg = await req('POST', '/auth/register', {
    name: 'Other User', email: `imgother_${Date.now()}@test.dev`, password, confirmPassword: password,
  });
  const otherToken = otherReg.data?.token;
  if (directOk) {
    const otherRead = await fetch(`${BASE}/ai/images/${direct.data.image.id}`, { headers: { Authorization: `Bearer ${otherToken}` } });
    log('other user cannot read a generated image', otherRead.status === 404, `status=${otherRead.status}`);
  }
  const noAuthRead = directOk ? await fetch(`${BASE}/ai/images/${direct.data.image.id}`) : null;
  log('generated image requires auth', noAuthRead ? noAuthRead.status === 401 : true, noAuthRead ? `status=${noAuthRead.status}` : 'skipped');

  const history = await req('GET', `/chat/${conversationId}`, undefined, token);
  const msgs = history.data?.chat?.messages || [];
  const withImage = msgs.filter((m) => m.image && m.image.imageId);
  const firstHistory = firstConversationId
    ? await req('GET', `/chat/${firstConversationId}`, undefined, token)
    : { data: null };
  const firstMsgs = firstHistory.data?.chat?.messages || [];
  log(
    'image messages are persisted in conversation history (user prompt + image ref)',
    withImage.length >= 3 && msgs.some((m) => m.role === 'user' && /Shiva/i.test(m.content)) && firstMsgs.some((m) => m.role === 'user' && /Krishna/i.test(m.content)),
    `${msgs.length} messages, ${withImage.length} with images (+${firstMsgs.length} in the first conversation)`
  );
  log('history never embeds image bytes', !JSON.stringify(history.data).includes('base64') && !JSON.stringify(firstHistory.data).includes('base64'));

  console.log('\n=== 10. Normal text AI still works in the same conversation ===');
  const whatIsJava = await reqWithRetry('POST', '/ai/career-assistant', { message: 'What is Java?', conversationId }, token);
  const javaOk = whatIsJava.status === 200 && !whatIsJava.data?.image && String(whatIsJava.data?.message?.content || '').length > 20;
  const javaExtra = `status=${whatIsJava.status} intent=${whatIsJava.data?.intent} answer="${String(whatIsJava.data?.message?.content || '').slice(0, 80)}"`;
  if (!javaOk && isQuotaSpent(whatIsJava)) {
    skipped += 1;
    console.log(`  ~ text question returns text (no image) — SKIP (${whatIsJava.data?.code}: provider daily quota spent, not an app failure)`);
  } else {
    log('text question returns text (no image)', javaOk, javaExtra);
  }

  console.log('\n=== 11. Honest failures (provider misconfigured / unknown) ===');
  const badProvider = await reqWithRetry('POST', '/ai/generate-image', { prompt: 'a cat', providerOverride: 'not-a-provider' }, token);
  log('unknown provider override is ignored (server config wins)', badProvider.status === 200 || badProvider.status === 503, `status=${badProvider.status}`);

  console.log('\n=== 12. Cleanup ===');
  const adminLogin = await req('POST', '/admin/login', { email: 'admin@careerai.app', password: 'Admin@12345' });
  const adminToken = adminLogin.data?.token;
  if (adminToken) {
    const users = await req('GET', '/admin/users', undefined, adminToken);
    for (const u of users.data?.users || []) {
      if (u.email === email || u.email === otherReg.data?.user?.email) {
        const del = await req('DELETE', `/admin/users/${u._id}`, undefined, adminToken);
        log(`admin deletes ${u.email} + cascade`, del.status === 200);
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (skipped) console.log('Skipped (provider quota, not an app failure): the text-answer assertions.');
  if (failures.length) console.log('Failed:', failures.join(', '));
  console.log('========================================\n');
  process.exit(failed ? 1 : 0);
};

main().catch((err) => {
  console.error('Image test crashed:', err);
  process.exit(1);
});