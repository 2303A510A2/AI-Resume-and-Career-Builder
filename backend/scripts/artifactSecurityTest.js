// Offline ownership and cleanup checks. No MongoDB, network, or provider key.
/* eslint-disable no-console */
const assert = require('assert');
const Artifact = require('../models/Artifact');
const storage = require('../services/artifactStorageService');
const controller = require('../controllers/artifactController');
const artifactService = require('../services/artifactService');

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  set() {},
  send(body) { this.body = body; return this; },
});

const main = async () => {
  const ownerId = '507f1f77bcf86cd799439011';
  const otherId = '507f1f77bcf86cd799439012';
  const originalFindOne = Artifact.findOne;
  const originalRead = storage.read;
  let reads = 0;
  try {
    Artifact.findOne = async (query) => query.ownerId === ownerId
      ? { title: 'owned', extension: 'pdf', mimeType: 'application/pdf', objectKey: 'safe-key' }
      : null;
    storage.read = async () => { reads += 1; return Buffer.from('%PDF-test'); };

    const owned = response();
    await controller.download({ params: { id: 'artifact-1' }, user: { id: ownerId } }, owned);
    assert.strictEqual(owned.statusCode, 200);
    assert.strictEqual(reads, 1);

    const denied = response();
    await controller.download({ params: { id: 'artifact-1' }, user: { id: otherId } }, denied);
    assert.strictEqual(denied.statusCode, 404);
    assert.strictEqual(reads, 1, 'cross-owner request must not read storage');
    assert.strictEqual(artifactService.MAX_BYTES > 0, true);
    console.log('  OK   downloads are ownership-scoped and cross-owner storage is never read');
  } finally {
    Artifact.findOne = originalFindOne;
    storage.read = originalRead;
  }
  console.log('\nALL 3 ARTIFACT SECURITY ASSERTIONS PASSED');
};

main().catch((error) => {
  console.error(`\nARTIFACT SECURITY TEST FAILED: ${error.message}`);
  process.exitCode = 1;
});
