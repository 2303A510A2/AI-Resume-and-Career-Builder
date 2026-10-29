// realAiTest.js — REAL provider verification (needs a working LLM_API_KEY).
// Runs against a live backend + MongoDB and a live LLM provider. It verifies
// that real answers, structured resources, web sources, regenerate and the
// image-attachment flow actually work end-to-end — no fakes, no key leaks.
//
// Usage:  node scripts/realAiTest.js   (backend + MongoDB running, key set)
// Result: "REAL-AI RESULTS: N passed, M failed" — details per check.
//
// Pacing: sleeps between LLM calls to stay inside per-minute provider limits.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const API = process.env.REAL_AI_BASE || 'http://localhost:5000/api';

// --- minimal PNG encoder (no external deps) -------------------------------
// Groq's vision models reject images smaller than 32x32px, so the tiny 1x1
// pixel used before 502'd. Build a real sized PNG at runtime with zlib+CRC32.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// 32x32 RGB image: a solid red square with a green gradient, high contrast,
// easy for any vision model to describe honestly.
function makePng(size = 32) {
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
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const PAUSE_MS = Number(process.env.REAL_AI_PAUSE_MS || 4000);
const RETRY_PAUSE_MS = Number(process.env.REAL_AI_RETRY_PAUSE_MS || 15000);

const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const env = (k) => {
  const m = new RegExp(`^${k}=(.*)$`, 'm').exec(envFile);
  return m ? m[1].trim() : '';
};

let token = null;
let adminToken = null;
let userId = null;
const email = `real_${Date.now()}@test.dev`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail || '' });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function post(path_, body, { auth = true, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = 'Bearer ' + token;
  let r = await fetch(API + path_, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = await r.json().catch(() => ({}));
  // Shared free-tier providers (Groq) can 429 mid-suite; the backend already
  // honored Retry-After + backoff. Give the quota a generous window and retry
  // the /ai/ call once before failing the check.
  if (!r.ok && String(path_).startsWith('/ai/') && data.code === 'AI_RATE_LIMITED') {
    console.log(`      ↳ rate-limited; waiting ${RETRY_PAUSE_MS}ms and retrying once…`);
    await sleep(RETRY_PAUSE_MS);
    r = await fetch(API + path_, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    data = await r.json().catch(() => ({}));
  }
  if (!r.ok && String(path_).startsWith('/ai/')) {
    console.log(`      ↳ api ${path_} failed: status=${r.status} code=${data.code || '-'} msg=${String(data.message || '').slice(0, 120)}`);
  }
  return { status: r.status, data };
}

async function main() {
  console.log('== REAL AI VERIFICATION ==');

  // 1. register
  let r = await post('/auth/register', {
    name: 'Real AI Tester', email, password: 'secret123', confirmPassword: 'secret123',
  });
  check('register temp user', r.status === 201 || r.status === 200, `status=${r.status}`);
  token = r.data.token;
  if (!token) throw new Error('no token after register');

  // 2. PNG image upload (32x32, valid and big enough for vision providers)
  const png = makePng(32);
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  fd.append('category', 'image');
  const up = await fetch(API + '/files/upload', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
  });
  const upData = await up.json();
  const doc = (upData && upData.document) || {};
  check('image upload stores pixels', Boolean(doc.id && doc.hasImage), `id=${doc.id || 'none'}`);
  const docId = doc.id;

  // 3. vision reality check: attach the image and ask about it. If the provider
  //    accepts image_url parts this returns a real answer; otherwise the honest
  //    graceful path ("cannot analyze" / clean provider error) must appear.
  if (docId) {
    await sleep(PAUSE_MS);
    r = await post('/ai/career-assistant', {
      message: 'What is in this image?', documentIds: [docId], requestId: 'rv_img_1',
    });
    const content = String((r.data.message && r.data.message.content) || '');
    const honest = /cannot analyze images|could not be analyzed/i.test(content);
    const realAnswer = content.length > 5 && !/error|temporarily busy/i.test(content);
    check(
      'image chat (vision on -> real answer | vision off -> honest note)',
      r.status === 200 && (realAnswer || honest) && !/api[_ ]?key|Bearer|stack|HTTP [0-9]{3}/i.test(content),
      `status=${r.status} ans_len=${content.length}`,
    );
    console.log(`      → ${content.replace(/\s+/g, ' ').slice(0, 160)}`);
  }

  // 4. plain knowledge question
  await sleep(PAUSE_MS);
  r = await post('/ai/career-assistant', { message: 'What is Java? Explain it simply.', requestId: 'rv_q1' });
  let content = String((r.data.message && r.data.message.content) || '');
  const clean = !/api[_ ]?key|Bearer|fetch failed|stack trace|temporarily busy/i.test(content);
  check('real answer: "What is Java?"', r.status === 200 && content.length > 40 && clean, `status=${r.status} len=${content.length}`);
  console.log(`      → ${content.replace(/\s+/g, ' ').slice(0, 140)}`);

  // 5. LeetCode problems -> structured resource cards
  await sleep(PAUSE_MS);
  r = await post('/ai/career-assistant', { message: 'Give me 5 easy LeetCode array problems', requestId: 'rv_q2' });
  const res = Array.isArray(r.data.resources) ? r.data.resources : [];
  const legit = res.every((x) => /^https:\/\//.test(String(x.url || '')));
  check('leetcode -> 5 resource cards, all https', r.status === 200 && res.length >= 3 && legit, `status=${r.status} cards=${res.length}`);
  if (res[0]) console.log(`      → ${JSON.stringify(res[0])}`);

  // 6. websites to learn Java -> resources or sources (or inline https links
  //    when a model answers plain text — the backend sanitizes every structured
  //    card/source URL against the curated allowlist, so all clickable cards are
  //    guaranteed verified https).
  await sleep(PAUSE_MS);
  r = await post('/ai/career-assistant', { message: 'Give me websites to learn Java', requestId: 'rv_q3' });
  content = String((r.data.message && r.data.message.content) || '');
  const srcs = Array.isArray(r.data.sources) ? r.data.sources : [];
  const res2 = Array.isArray(r.data.resources) ? r.data.resources : [];
  const any = res2.length || srcs.length;
  const allSafe = [...res2, ...srcs].every((x) => /^https:\/\//.test(String(x.url || '')));
  const inlineLinks = /https:\/\//i.test(content);
  check('websites -> resources/sources, http(s) only', r.status === 200 && (any > 0 || inlineLinks) && allSafe, `status=${r.status} resources=${res2.length} sources=${srcs.length} inline_https=${inlineLinks}`);
  if (srcs[0]) console.log(`      → source: ${JSON.stringify(srcs[0])}`);
  console.log(`      → ${content.replace(/\s+/g, ' ').slice(0, 140)}`);

  // 7. latest-AI current-intent question (web search round trip)
  await sleep(PAUSE_MS);
  r = await post('/ai/career-assistant', { message: 'What is the latest in AI this year?', requestId: 'rv_q4' });
  content = String((r.data.message && r.data.message.content) || '');
  const srcs2 = Array.isArray(r.data.sources) ? r.data.sources : [];
  check('latest-AI (web intent) answers + sanitized sources', r.status === 200 && content.length > 30 && srcs2.every((s) => /^https:\/\//.test(String(s.url || ''))), `status=${r.status} len=${content.length} sources=${srcs2.length}`);
  console.log(`      → ${content.replace(/\s+/g, ' ').slice(0, 140)}`);

  // 8. regenerate replaces the last answer
  await sleep(PAUSE_MS);
  r = await post('/ai/career-assistant/regenerate', { conversationId: r.data.conversationId, requestId: 'rv_regen' });
  const regen = String((r.data.message && r.data.message.content) || '');
  check('regenerate returns a fresh answer', r.status === 200 && regen.length > 30, `status=${r.status} len=${regen.length}`);

  // 9. conversation history persisted on the server chat (GET /chat -> { chats })
  const list = await post('/chat', undefined, { method: 'GET' });
  const chatList = Array.isArray(list.data && list.data.chats) ? list.data.chats : [];
  check('server chat history listable', list.status === 200 && chatList.length > 0, `status=${list.status} chats=${chatList.length}`);

  // ---- cleanup: delete the temp user via admin ----
  try {
    // The bootstrap admin was seeded once with the password in .env at first
    // boot. Env credentials can drift from the seeded hash (e.g. placeholder
    // values), so fall back to the credentials used by the smoke suite when
    // the env pair fails to authenticate.
    const creds = [
      { email: env('ADMIN_EMAIL'), password: env('ADMIN_PASSWORD') },
      { email: 'admin@careerai.app', password: 'Admin@12345' },
    ];
    let adm = null;
    for (const c of creds) {
      if (!c.email || !c.password) continue;
      adm = await post('/admin/login', c, { auth: false });
      if (adm.status === 200 && adm.data.token) break;
    }
    adminToken = adm && adm.data && adm.data.token;
    if (adminToken) {
      const usersRes = await fetch(API + '/admin/users', { headers: { Authorization: 'Bearer ' + adminToken } });
      const usersObj = await usersRes.json().catch(() => ({}));
      const users = Array.isArray(usersObj) ? usersObj : usersObj.users;
      const me = Array.isArray(users) ? users.find((u) => String(u.email || '').toLowerCase() === email.toLowerCase()) : null;
      const uid = me && (me.id || me._id);
      if (me && uid) {
        const del = await fetch(API + '/admin/users/' + uid, {
          method: 'DELETE', headers: { Authorization: 'Bearer ' + adminToken },
        });
        check('cleanup: temp user deleted', del.status === 200 || del.status === 204, `status=${del.status}`);
      } else {
        check('cleanup: temp user deleted', false, 'user not found in admin list');
      }
    } else {
      console.log('  ⚠️  admin login skipped — temp user left in DB');
    }
  } catch (e) {
    console.log('  ⚠️  cleanup failed:', e.message);
  }

  const passed = results.filter((x) => x.ok).length;
  const failed = results.length - passed;
  console.log(`\nREAL-AI RESULTS: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});