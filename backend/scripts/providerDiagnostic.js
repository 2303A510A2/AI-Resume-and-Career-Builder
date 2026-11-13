// Explicit live inference diagnostics for every configured provider.
// Makes one fixed, low-token chat request per configured provider; never prints
// credentials, prompts, response content, or raw provider response bodies.
// Run: node scripts/providerDiagnostic.js
/* eslint-disable no-console */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const llmService = require('../services/llmService');

const main = async () => {
  const result = await llmService.runProviderDiagnostics();
  console.log(`Live provider inference diagnostics (cached=${result.cached})`);
  for (const provider of result.providers) {
    console.log(JSON.stringify({
      slot: provider.slot,
      provider: provider.provider,
      configured: provider.configurationStatus === 'configured',
      apiKeySource: provider.apiKeySource,
      missingKeyVariable: provider.missingKeyVariable || undefined,
      baseUrl: provider.baseUrl,
      model: provider.model,
      inference: provider.lastInferenceStatus,
      httpStatusCategory: provider.httpStatusCategory,
      httpStatus: provider.httpStatus,
      latencyMs: provider.responseLatencyMs,
      rateLimitStatus: provider.rateLimitStatus,
      lastErrorCategory: provider.lastErrorCategory,
    }));
  }
};

main().catch((err) => {
  console.error(`Provider diagnostics failed: ${String(err && err.code || 'internal_error')}`);
  process.exitCode = 1;
});
