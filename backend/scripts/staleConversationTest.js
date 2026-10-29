// Verifies what the backend returns for a conversationId that no longer exists
// (stale serverId in the browser localStorage after a DB reset/deletion), and
// what the frontend maps it to. No provider call happens (404 before the LLM).
/* eslint-disable no-console */
const BASE = 'http://localhost:5000/api';

const main = async () => {
  const email = `stale_${Date.now()}@test.dev`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Stale Tester', email, password: 'Secret123', confirmPassword: 'Secret123' }),
  });
  const regData = await reg.json().catch(() => ({}));
  const token = regData.token;
  if (!token) { console.log('register failed'); process.exit(1); }

  const fakeId = '64b000000000000000000000'; // valid ObjectId shape, nonexistent chat
  const r = await fetch(`${BASE}/ai/career-assistant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: 'hi', conversationId: fakeId, documentIds: [], requestId: `stale_${Date.now()}` }),
  });
  const data = await r.json().catch(() => ({}));
  console.log(`stale conversationId -> status=${r.status} body=${JSON.stringify(data)}`);

  // Frontend mapping: apiCall throws Error(data.message) -> backendErrorText
  const msg = String(data.message || '');
  const friendly = /temporary error|timed out|provider error|unreachable|empty response/i.test(msg);
  const knownCode = /AI_PROVIDER_UNAVAILABLE|AI_PROVIDER_ERROR|AI_NOT_FOUND/i.test(String(data.code || ''));
  const generic = !friendly && !knownCode;
  console.log(`frontend would show: ${generic ? '"Something went wrong while generating the response." (DEFAULT fallback)' : 'a specific friendly message'}`);
  process.exit(0);
};

main().catch((e) => { console.error('test crashed:', e.message); process.exit(1); });