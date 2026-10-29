const notFound = (req, res, next) => {
  res.status(404).json({ success: false, message: `Not found: ${req.method} ${req.originalUrl}` });
};

// Centralized error handler. Never leaks stack traces to clients.
const errorHandler = (err, req, res, next) => {
  const status = err.statusCode || res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;
  const statusCode = err.statusCode || (err.name === 'ValidationError' ? 400 : status >= 500 ? status : 500);

  if (err.name === 'CastError') {
    return res.status(400).json({ success: false, message: 'Invalid id format' });
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return res.status(409).json({ success: false, message: `Duplicate value for ${field}` });
  }

  console.error(`[${new Date().toISOString()}] ${err.message}`);
  // Server-side diagnostics (never includes API keys / Authorization headers —
  // llmService and webSearchService construct `detail` without secrets).
  if (err.detail && err.detail !== err.message) {
    console.error(`   ↳ ${err.detail}`);
  }
  res.status(statusCode).json({
    success: false,
    message: err.expose || err.isOperational ? err.message : 'Something went wrong',
    ...(err.code ? { code: err.code } : {}),
    // Honest retry hint for AI errors: the provider layer already decided whether
    // a retry could help (a spent daily quota -> false; transient 5xx/network ->
    // true). The frontend uses it to gate its Retry button per error, so a
    // Retry is never offered when it cannot work.
    ...(err.retryable !== undefined ? { retryable: err.retryable } : {}),
  });
};

module.exports = { notFound, errorHandler };