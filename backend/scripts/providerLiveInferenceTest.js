// Opt-in live inference tests; these consume real provider tokens.
// Run with RUN_PROVIDER_LIVE=1 node scripts/providerLiveInferenceTest.js
// Mocked transport/fallback tests live in providerFallbackTest.js and
// providerErrorTest.js and never contact a provider.
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

if (process.env.RUN_PROVIDER_LIVE !== '1') {
  console.log('SKIP live provider calls. Set RUN_PROVIDER_LIVE=1 to run real inference tests.');
  process.exit(0);
}

const llmService = require('../services/llmService');

const examples = [
  ['Java explanation', 'Explain what Java is in simple terms and give one short example.'],
  ['LeetCode request', 'Suggest three beginner LeetCode array problems and briefly explain each.'],
  ['Timetable request', 'Create a one-day Java study timetable with four focused study blocks.'],
];

const main = async () => {
  const diagnostics = await llmService.runProviderDiagnostics();
  let pass = 0;
  let fail = 0;
  const successful = diagnostics.providers.filter((provider) =>
    provider.configurationStatus === 'configured' && provider.lastInferenceStatus === 'success'
  );
  for (const provider of diagnostics.providers) {
    if (provider.configurationStatus !== 'configured') {
      console.log(`SKIP ${provider.provider}: missing API key (${provider.missingKeyVariable || 'provider key'})`);
    } else {
      console.log(
        `${provider.lastInferenceStatus === 'success' ? 'PASS' : 'FAIL'} ${provider.provider}/${provider.model}: ` +
        `${provider.lastErrorCategory || 'inference successful'}; ${provider.responseLatencyMs ?? 0}ms`
      );
      if (provider.lastInferenceStatus === 'success') pass += 1;
      else fail += 1;
    }
  }

  if (!successful.length) {
    for (const [label] of examples) console.log(`SKIP ${label}: no configured provider passed live inference.`);
  } else {
    for (const [label, prompt] of examples) {
      const startedAt = Date.now();
      try {
        const answer = await llmService.chat({
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 400,
          maxRetries: 0,
          returnMeta: true,
        });
        const valid = typeof answer.content === 'string' && answer.content.trim().length >= 20;
        if (valid) pass += 1;
        else fail += 1;
        console.log(
          `${valid ? 'PASS' : 'FAIL'} ${label}: provider=${answer.provider || 'unknown'} ` +
          `model=${answer.model || 'unknown'} chars=${String(answer.content || '').length} ` +
          `latencyMs=${Date.now() - startedAt}`
        );
      } catch (err) {
        fail += 1;
        console.log(`FAIL ${label}: category=${String(err && err.code || 'provider_error')}`);
      }
    }
  }

  console.log(`providerLiveInferenceTest: ${pass} passed, ${fail} failed (real inference)`);
  if (fail) process.exitCode = 1;
};

main().catch((err) => {
  console.error(`providerLiveInferenceTest aborted: ${String(err && err.code || 'internal_error')}`);
  process.exitCode = 1;
});
