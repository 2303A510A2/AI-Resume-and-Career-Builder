// Embedding provider abstraction (OpenAI-compatible /embeddings endpoint).
// When no embedding key is configured, embeddings are unavailable and the RAG
// layer transparently falls back to keyword search.

const getConfig = () => {
  const provider = (process.env.LLM_PROVIDER || process.env.AI_PROVIDER || 'openai').toLowerCase();
  // Providers without an embeddings API (Groq, local Ollama) should not borrow
  // the chat key for embedding calls — retrieval then uses honest keyword search.
  const noEmbeddingProvider = ['groq', 'ollama'].includes(provider);
  const key =
    process.env.EMBEDDING_API_KEY ||
    (noEmbeddingProvider && !process.env.AI_API_KEY ? '' : process.env.LLM_API_KEY) ||
    '';
  return {
    baseUrl: (process.env.EMBEDDING_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
    apiKey: key,
  };
};

const isConfigured = () => Boolean(getConfig().apiKey);

const embedText = async (text) => {
  const c = getConfig();
  if (!c.apiKey) return null;

  let resp;
  try {
    resp = await fetch(`${c.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ model: c.model, input: String(text).slice(0, 8000) }),
    });
  } catch (err) {
    console.warn(`⚠️ Embedding provider unreachable (${c.baseUrl}): ${err.message}`);
    return null;
  }

  if (!resp.ok) {
    console.warn(`⚠️ Embedding provider error (${resp.status}), falling back to keyword search.`);
    return null;
  }

  const data = await resp.json();
  return data?.data?.[0]?.embedding || null;
};

const embedMany = async (texts) => {
  const c = getConfig();
  if (!c.apiKey) {
    return { embeddings: texts.map(() => null), configured: false };
  }

  const results = [];
  for (const text of texts) {
    // Sequential batching keeps memory low and simplicity high; fine for resume-scale docs.
    const emb = await embedText(text);
    results.push(emb);
  }
  return { embeddings: results, configured: true };
};

module.exports = { embedText, embedMany, isConfigured };