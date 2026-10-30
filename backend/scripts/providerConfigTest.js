// Offline tests for provider environment precedence and Groq configuration.
// Run: node scripts/providerConfigTest.js
/* eslint-disable no-console */

const providers = require('../services/providers');
const llmService = require('../services/llmService');

const names = [
  'LLM_PROVIDER',
  'AI_PROVIDER',
  'LLM_BASE_URL',
  'AI_BASE_URL',
  'LLM_MODEL',
  'AI_MODEL',
  'LLM_API_KEY',
  'AI_API_KEY',
  'GROQ_API_KEY',
  'OPENAI_API_KEY',
];
const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  if (condition) pass += 1;
  else fail += 1;
};

try {
  for (const name of names) delete process.env[name];
  process.env.LLM_PROVIDER = 'groq';
  process.env.LLM_BASE_URL = 'https://api.groq.com/openai/v1';
  process.env.LLM_MODEL = 'qwen/qwen3.8-27b';
  process.env.LLM_API_KEY = 'test-key-not-a-real-secret';

  const cfg = providers.primary();
  check('explicit Groq provider is selected', cfg.provider === 'groq', cfg.provider);
  check('Groq OpenAI-compatible base URL is selected', cfg.baseUrl === 'https://api.groq.com/openai/v1', cfg.baseUrl);
  check('Groq-supported application model is selected', cfg.model === 'qwen/qwen3.8-27b', cfg.model);
  check('LLM_API_KEY is the configured key source', cfg.apiKey === 'test-key-not-a-real-secret');

  process.env.AI_PROVIDER = 'openai';
  process.env.AI_BASE_URL = 'https://api.openai.com/v1';
  process.env.AI_MODEL = 'gpt-4o-mini';
  const stillPrimary = providers.primary();
  check('LLM_* values take precedence over compatibility aliases', stillPrimary.provider === 'groq' && stillPrimary.model === 'qwen/qwen3.8-27b');

  for (const name of names) delete process.env[name];
  process.env.LLM_API_KEY = 'gsk_test-key-not-a-real-secret';
  const inferred = providers.primary();
  check('Groq key infers Groq when provider settings are absent', inferred.provider === 'groq');
  check('inferred Groq configuration uses the Groq base URL', inferred.baseUrl === 'https://api.groq.com/openai/v1');
  check('Groq/provider mismatch is reported without exposing the key', providers.configurationIssue({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: 'gsk_test-key-not-a-real-secret',
  }).includes('Groq API key'));

  const healthShape = providers.describe();
  check(
    'safe provider diagnostics contain no API key value',
    !JSON.stringify(healthShape).includes('test-key-not-a-real-secret')
  );
  check('401 probe errors classify as authentication', llmService.probeErrorCategory(401) === 'authentication');
  check('404 probe errors classify as endpoint_or_model', llmService.probeErrorCategory(404) === 'endpoint_or_model');
  check('429 probe errors classify as rate_limited', llmService.probeErrorCategory(429) === 'rate_limited');
  check('503 probe errors classify as provider_server_error', llmService.probeErrorCategory(503) === 'provider_server_error');
} finally {
  for (const name of names) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
}

console.log(`\nproviderConfigTest: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
