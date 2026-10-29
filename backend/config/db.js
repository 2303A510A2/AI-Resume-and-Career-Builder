const mongoose = require('mongoose');

// Connection state shared with /api/health. MongoDB is NEVER reported as
// connected unless mongoose really is. When the database is down the API stays
// online and reports `mongodb: disconnected` (see server.js health endpoint).

let healthy = false;
let lastError = null;
let retryTimer = null;

const dbState = () => ({
  connected: healthy === true && mongoose.connection.readyState === 1,
  readyState: mongoose.connection.readyState,
  label: healthy === true && mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  error: lastError,
});

const logConnected = () => {
  healthy = true;
  lastError = null;
  const host = mongoose.connection.host || 'localhost';
  const name = mongoose.connection.name || '';
  console.log('🗄️  MongoDB connected successfully');
  console.log(`    ${host}/${name}`);
};

// Keeps trying until MongoDB is reachable, so the backend can be started before
// or alongside the database and heals itself instead of crashing.
const scheduleRetry = () => {
  if (retryTimer) return;
  const delayMs = Number(process.env.MONGO_RETRY_MS || 10000);
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    try {
      mongoose.set('strictQuery', true);
      await mongoose.connect(getUri(), { serverSelectionTimeoutMS: 5000 });
      logConnected();
    } catch (err) {
      healthy = false;
      lastError = err.message;
      console.error(`❌ MongoDB still unreachable (${err.message}). Retrying in ${delayMs / 1000}s …`);
      scheduleRetry();
    }
  }, delayMs);
};

// Render/production uses MONGODB_URI. MONGO_URI remains the local-development
// alias so local configuration and production configuration stay independent.
const getUri = () => process.env.MONGODB_URI || process.env.MONGO_URI;

const connectDB = async () => {
  const uri = getUri();
  if (!uri) {
    lastError = 'MONGO_URI is not set. Create backend/.env from .env.example and set a MongoDB connection string (Atlas or local).';
    console.error(`❌ MongoDB connection failed: ${lastError}`);
    scheduleRetry();
    return dbState();
  }

  try {
    mongoose.set('strictQuery', true);

    mongoose.connection.on('connected', logConnected);
    mongoose.connection.on('error', (err) => {
      healthy = false;
      lastError = err.message;
    });
    mongoose.connection.on('disconnected', () => {
      healthy = false;
      lastError = lastError || 'MongoDB disconnected';
    });

    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    logConnected();
  } catch (err) {
    healthy = false;
    lastError = err.message;
    console.error(`❌ MongoDB connection failed: ${err.message}`);
    console.error('   The API stays online, but /api/health will report mongodb: disconnected.');
    console.error('   Start MongoDB (or fix MONGO_URI) — the backend will reconnect automatically.');
    scheduleRetry();
  }
  return dbState();
};

module.exports = connectDB;
module.exports.dbState = dbState;