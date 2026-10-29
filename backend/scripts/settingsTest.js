// Offline unit suite for the User Settings feature.
//
// No MongoDB, no network, no AI key — it exercises the PURE helpers in
// settingsController.js (requiring the module is safe; nothing connects) plus a
// few source-pins that guarantee the routes stay protected and the saved chat
// preferences keep reaching the AI pipeline.
const fs = require('fs');
const path = require('path');
const {
  normalizeSettings,
  validateAvatar,
  DEFAULT_SETTINGS,
} = require('../controllers/settingsController');
const { pickMaxTokens } = require('../services/ragService');

let passed = 0;
let failed = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};
const eq = (name, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, same, same ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (same) console.log(`  OK   ${name} -> ${JSON.stringify(actual)}`);
};

console.log('\n1) Settings normalization (complete, well-typed object from anything)');
eq('empty input yields the documented defaults', normalizeSettings(undefined), DEFAULT_SETTINGS);
eq('null yields defaults', normalizeSettings(null), DEFAULT_SETTINGS);
eq('garbage yields defaults', normalizeSettings({ appearance: 'nope', chat: 42 }), DEFAULT_SETTINGS);
{
  const s = normalizeSettings({ appearance: { theme: 'dark', accent: 'pink' } });
  ok('valid theme is kept', s.appearance.theme === 'dark');
  ok('valid accent is kept', s.appearance.accent === 'pink');
  ok('missing chat fields get defaults', s.chat.responseStyle === 'balanced' && s.chat.enterToSend === true);
}
{
  const s = normalizeSettings({ appearance: { theme: 'neon' }, chat: { responseStyle: 'essay', language: '   ' } });
  ok('invalid theme falls back to system', s.appearance.theme === 'system');
  ok('invalid responseStyle falls back to balanced', s.chat.responseStyle === 'balanced');
  ok('blank language falls back to auto', s.chat.language === 'auto');
}
{
  const s = normalizeSettings({ chat: { enterToSend: false, confirmDelete: false, voicePlayback: true, language: 'Telugu' } });
  ok('boolean prefs are preserved', s.chat.enterToSend === false && s.chat.confirmDelete === false && s.chat.voicePlayback === true);
  ok('language string is preserved', s.chat.language === 'Telugu');
}

console.log('\n2) Avatar validation (type + size + real-image magic bytes)');
{
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',
        jpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ',
        webp = 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAv';
  ok('empty string clears the avatar', validateAvatar('').ok && validateAvatar('').value === '');
  ok('null clears the avatar', validateAvatar(null).ok);
  ok('valid PNG is accepted', validateAvatar(png).ok);
  ok('valid JPG is accepted', validateAvatar(jpg).ok);
  ok('valid WebP is accepted', validateAvatar(webp).ok);
  ok('wrong mime is rejected', !validateAvatar('data:image/gif;base64,R0lGODlh').ok);
  ok('non-base64 data URL is rejected', !validateAvatar('data:image/png,x').ok);
  ok('a text file relabelled as an image is rejected (magic bytes)', !validateAvatar('data:image/png;base64,SGVsbG8gd29ybGQ=').ok);
  ok('a non-string is rejected', !validateAvatar(12345).ok);
  {
    const huge = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(700 * 1024);
    const r = validateAvatar(huge);
    ok('an oversized avatar is rejected', !r.ok && /too large/i.test(r.message), r.message);
  }
}

console.log('\n3) Response-style preference changes the budget only without an explicit request');
{
  const plain = { wordCount: null, itemCount: null, wantsAll: false };
  const balanced = pickMaxTokens('GENERAL', plain, { responseStyle: 'balanced' });
  const detailed = pickMaxTokens('GENERAL', plain, { responseStyle: 'detailed' });
  const concise = pickMaxTokens('GENERAL', plain, { responseStyle: 'concise' });
  ok('detailed > balanced', detailed > balanced, `${detailed} vs ${balanced}`);
  ok('concise < balanced', concise < balanced, `${concise} vs ${balanced}`);

  const explicit = { wordCount: 1000, itemCount: null, wantsAll: false };
  const a = pickMaxTokens('GENERAL', explicit, { responseStyle: 'concise' });
  const b = pickMaxTokens('GENERAL', explicit, { responseStyle: 'detailed' });
  eq('an explicit word count overrides the style preference (same budget)', a, b);
  ok('an explicit 1000-word request gets a real budget', a > 1500, String(a));
}

console.log('\n4) Source-pins: routes exist, are protected, and are mounted');
{
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'settingsRoutes.js'), 'utf8');
  ok('GET / is protected', /router\.get\('\/',\s*protect/.test(routes));
  ok('PUT /profile is protected', /router\.put\('\/profile',\s*protect/.test(routes));
  ok('PUT /preferences is protected', /router\.put\('\/preferences',\s*protect/.test(routes));
  ok('POST /change-password is protected', /router\.post\('\/change-password',\s*protect/.test(routes));
  ok('GET /export is protected', /router\.get\('\/export',\s*protect/.test(routes));
  ok('POST /clear-chats is protected', /router\.post\('\/clear-chats',\s*protect/.test(routes));
  ok('DELETE /account is protected', /router\.delete\('\/account',\s*protect/.test(routes));

  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok('server mounts /api/settings', /app\.use\('\/api\/settings',\s*settingsRoutes\)/.test(server));
  ok('server requires the settings routes', /require\('\.\/routes\/settingsRoutes'\)/.test(server));

  const model = fs.readFileSync(path.join(__dirname, '..', 'models', 'User.js'), 'utf8');
  ok('User model has a settings block', /settings:\s*\{/.test(model));
  ok('User model has responses style enum', /responseStyle:\s*\{\s*type:\s*String,\s*enum:\s*\['concise',\s*'balanced',\s*'detailed'\]/.test(model));
  ok('User model has profile.avatar', /avatar:\s*\{\s*type:\s*String/.test(model));
}

console.log('\n5) Source-pins: saved chat preferences reach the AI and shape the prompt');
{
  const ai = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'aiController.js'), 'utf8');
  const count = (ai.match(/settings\s*&&\s*req\.userRecord\.settings\.chat/g) || []).length;
  ok('handleCareerAssistant and regenerate both pass preferences', count >= 2, `found ${count}`);

  const rag = fs.readFileSync(path.join(__dirname, '..', 'services', 'ragService.js'), 'utf8');
  ok('ragService accepts a preferences option', /preferences = \{\}/.test(rag));
  ok('ragService builds a USER PREFERENCES block', /USER PREFERENCES/.test(rag));
  ok('preference block is injected into the system prompt', /\$\{preferenceBlock\}\$\{directiveBlock\}/.test(rag));
  ok('both token-budget call sites pass prefs', (rag.match(/pickMaxTokens\(intent, req, prefs\)/g) || []).length === 2);
  ok('explicit request shape disables the style override', /const explicitShape = Boolean\(/.test(rag));
}

console.log(`\n${passed} passed / ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log(` - ${f}`));
  process.exit(1);
}
