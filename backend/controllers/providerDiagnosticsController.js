const llmService = require('../services/llmService');

const getProviderDiagnostics = (req, res) => {
  res.json({
    success: true,
    providers: llmService.getProviderDiagnostics(),
  });
};

const testProviderInference = async (req, res) => {
  const result = await llmService.runProviderDiagnostics();
  res.json({
    success: true,
    ...result,
  });
};

module.exports = { getProviderDiagnostics, testProviderInference };
