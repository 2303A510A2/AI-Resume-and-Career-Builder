/* Quick live probe: does the running backend expose the NEW admin contract?
   (profile.avatar/bio on /admin/me, mainAdminEmail, pendingAdminRequests,
   unreadNotifications, and the notification endpoints.) Read-only: it does not
   change the Main Admin Leader's password. */
const BASE = process.env.API_BASE || 'http://localhost:5000/api';
const EMAIL = process.env.INITIAL_ADMIN_EMAIL || 'metebharath4@gmail.com';
const PW = process.env.INITIAL_ADMIN_PASSWORD || '141414';

(async () => {
  const post = (p, body, token) => fetch(BASE + p, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body || {}),
  });
  const get = (p, token) => fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });

  const lr = await post('/admin/login', { email: EMAIL, password: PW });
  const lj = await lr.json();
  if (!lr.ok || !lj.token) { console.log('LOGIN FAILED', lr.status, JSON.stringify(lj)); process.exit(1); }
  console.log('login ok; role=', lj.admin && lj.admin.role, 'mustChangePassword=', lj.admin && lj.admin.mustChangePassword);

  const mr = await get('/admin/me', lj.token);
  const mj = await mr.json();
  console.log('/admin/me status', mr.status);
  console.log('  has mainAdminEmail:', 'mainAdminEmail' in mj, '->', mj.mainAdminEmail);
  console.log('  has unreadNotifications:', 'unreadNotifications' in mj, '->', mj.unreadNotifications);
  console.log('  has pendingAdminRequests:', 'pendingAdminRequests' in mj, '->', mj.pendingAdminRequests);
  console.log('  admin.profile present:', !!(mj.admin && mj.admin.profile), '->', JSON.stringify(mj.admin && mj.admin.profile));

  const nr = await get('/admin/notifications', lj.token);
  console.log('/admin/notifications status', nr.status, '(403 expected while mustChangePassword=true)');

  process.exit(0);
})().catch((e) => { console.log('PROBE ERROR', e.message); process.exit(1); });
