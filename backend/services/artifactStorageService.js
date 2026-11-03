const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(
  process.env.ARTIFACT_STORAGE_DIR || path.join(__dirname, '..', 'storage', 'artifacts')
);

const safeKey = (key) => {
  const value = String(key || '');
  if (!value || value.includes('..') || path.isAbsolute(value) || value.includes('/') || value.includes('\\')) {
    throw new Error('Invalid artifact object key');
  }
  return value;
};

const put = async (buffer, extension) => {
  await fs.mkdir(ROOT, { recursive: true });
  const objectKey = `${crypto.randomUUID()}.${String(extension || 'bin').toLowerCase()}`;
  await fs.writeFile(path.join(ROOT, safeKey(objectKey)), buffer, { flag: 'wx' });
  return { objectKey, storageProvider: 'local' };
};

const read = async (objectKey) => fs.readFile(path.join(ROOT, safeKey(objectKey)));

const remove = async (objectKey) => {
  try {
    await fs.unlink(path.join(ROOT, safeKey(objectKey)));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
};

module.exports = { put, read, remove, ROOT };
