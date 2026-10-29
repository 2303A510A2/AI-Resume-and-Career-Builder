// Repro test: ONE "hi" through the real POST /api/ai/career-assistant endpoint.
// Registers a throwaway user, sends "hi", prints the full response + timing,
// then deletes the user via admin. Run only when the backend is already up.
/* eslint-disable no-console */
const BASE = process.env.REPRO_BASE || 'http://localhost:5000/api';

const main = async () => {
  const email = `repro_${Date.now()}@test.dev`;
  const reg = await fetch(`${BASE}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Repro Tester', email, password: 'Secret123', confirmPassword: 'Secret123' }),
  });
  const regData = await reg.json().catch(() => ({}));
  const token = regData.token;
  console.log('register:', reg.status, token ? 'token OK' : `NO TOKEN ${JSON.stringify(regData).slice(0, 200)}`);
  if (!token) process.exit(1);

  const t0 = Date.now();
  const r = await fetch(`${BASE}/ai/career-assistant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: process.env.REPRO_MSG || 'hi', documentIds: [], requestId: `repro_${Date.now()}` }),
  });
  const ms = Date.now() - t0;
  const data = await r.json().catch(() => ({}));
  const content = String((data.message && data.message.content) || '');
  console.log(`career-assistant "${process.env.REPRO_MSG || 'hi'}": status=${r.status} in ${ms}ms`);
  console.log(`code=${data.code || '-'} intent=${data.intent || '-'}`);
  console.log(`answer=${JSON.stringify(content.slice(0, 300))}`);

  // cleanup via admin (best-effort)
  try {
    const adm = await fetch(`${BASE}/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@careerai.app', password: 'Admin@12345' }),
    });
    const admData = await adm.json().catch(() => ({}));
    if (admData.token) {
      const me = await fetch(`${BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
      const meData = await me.json().catch(() => ({}));
      const uid = meData.user && (meData.user._id || meData.user.id);
      if (uid) await fetch(`${BASE}/admin/users/${uid}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${admData.token}` },
      });
    }
  } catch { /* ignore cleanup */ }
  process.exit(r.ok ? 0 : 1);
};

main().catch((e) => { console.error('test crashed:', e.message); process.exit(1); });