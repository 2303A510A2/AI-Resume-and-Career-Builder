const AUTH_SECRET_NAMES = ['JWT_SECRET', 'JWT_RESET_SECRET'];

const missingAuthSecrets = (env = process.env) =>
  AUTH_SECRET_NAMES.filter((name) => typeof env[name] !== 'string' || !env[name].trim());

const validateAuthConfig = (env = process.env) => {
  const missing = missingAuthSecrets(env);
  if (missing.length) {
    const error = new Error(`Missing required authentication environment variable(s): ${missing.join(', ')}`);
    error.code = 'AUTH_CONFIG_MISSING';
    error.statusCode = 503;
    error.isOperational = true;
    throw error;
  }
  return true;
};

const getAuthSecret = (env = process.env) => {
  validateAuthConfig(env);
  return env.JWT_SECRET;
};

const getResetSecret = (env = process.env) => {
  validateAuthConfig(env);
  return env.JWT_RESET_SECRET;
};

module.exports = {
  AUTH_SECRET_NAMES,
  missingAuthSecrets,
  validateAuthConfig,
  getAuthSecret,
  getResetSecret,
};
