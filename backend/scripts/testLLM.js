// Direct, safe LLM connectivity test — run: node scripts/testLLM.js
// Sends one real prompt to the configured provider. NEVER prints the API key.
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const llmService = require('../services/llmService');

const main = async () => {
  const c = llmService.getConfig();

  console.log('── LLM test ─────────────────────────────────────');
  console.log(`Provider:   ${c.provider}`);
  console.log(`Base URL:   ${c.baseUrl}`);
  console.log(`Model:      ${c.model}`);
  console.log(`API key:    ${c.apiKey ? `configured (…${c.apiKey.slice(-4)})` : 'NOT CONFIGURED'}`);

  if (!llmService.isConfigured()) {
    console.log('\nResult: AI provider is not configured.');
    console.log('Add LLM_API_KEY (or AI_API_KEY / GROQ_API_KEY) to backend/.env, e.g.:');
    console.log('  LLM_API_KEY=gsk_...');
    console.log('then restart the backend and re-run this script.');
    return 0;
  }

  try {
    const reply = await llmService.complete({
      system: 'You are a connectivity tester. Reply with exactly: AI CONNECTION WORKING',
      user: 'Reply with exactly: AI CONNECTION WORKING',
      temperature: 0,
      maxTokens: 50,
    });
    console.log('\nReal LLM reply:');
    console.log(reply);
    console.log('\nResult: AI CONNECTION WORKING ✅');
    return 0;
  } catch (err) {
    console.error('\nLLM request FAILED:');
    console.error(`  HTTP status: ${err.statusCode || 'n/a'}`);
    console.error(`  Diagnostic:  ${err.message}`);
    console.error(`  Base URL:    ${c.baseUrl}`);
    console.error(`  Model:       ${c.model}`);
    console.error('  (The API key was never printed.)');
    return 2;
  }
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('Test crashed:', err);
    process.exit(1);
  });