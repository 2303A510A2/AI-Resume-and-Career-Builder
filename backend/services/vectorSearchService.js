const RAGDocument = require('../models/RAGDocument');

const VECTOR_INDEX_NAME = process.env.VECTOR_INDEX_NAME || 'rag_vector_index';

/**
 * Semantic vector search via MongoDB Atlas $vectorSearch.
 * Requires the Atlas index below (create it in Atlas under the ragdocuments
 * collection - see scripts/setupVectorIndex.js and README):
 *
 * {
 *   "name": "rag_vector_index",
 *   "type": "vectorSearch",
 *   "fields": [
 *     { "type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine" },
 *     { "type": "filter", "path": "userId" },
 *     { "type": "filter", "path": "source" }
 *   ]
 * }
 */
const search = async ({ userId, embedding, topK = 6, sources = ['resume', 'job', 'document'] }) => {
  if (!embedding || !Array.isArray(embedding) || embedding.length === 0) return null;

  const filter = { userId };
  if (sources && sources.length) filter.source = { $in: sources };

  const pipeline = [
    {
      $vectorSearch: {
        index: VECTOR_INDEX_NAME,
        queryVector: embedding,
        path: 'embedding',
        limit: topK * 2,
        numCandidates: 50,
        filter,
      },
    },
    { $project: { text: 1, section: 1, source: 1, metadata: 1, score: { $meta: 'vectorSearchScore' } } },
    { $limit: topK },
  ];

  try {
    const results = await RAGDocument.aggregate(pipeline);
    return results.map((r) => ({
      text: r.text,
      section: r.section,
      source: r.source,
      score: r.score,
    }));
  } catch (err) {
    // Index missing / not ready on Atlas - caller falls back to keyword search.
    console.warn(`⚠️ Vector search unavailable (${err.message}). Using keyword fallback.`);
    return null;
  }
};

/** Keyword fallback when embeddings are not configured or vector index is missing. */
const keywordSearch = async ({ userId, query, topK = 6, sources = ['resume', 'job', 'document'] }) => {
  const tokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length > 2);

  if (!tokens.length) return [];

  const mongoQuery = {
    userId,
    ...(sources && sources.length ? { source: { $in: sources } } : {}),
    $or: tokens.map((t) => ({ text: new RegExp(escapeRegExp(t), 'i') })),
  };

  const docs = await RAGDocument.find(mongoQuery).select('text section source metadata').limit(30).lean();

  // Score by number of matched tokens, then choose the best topK.
  const scored = docs
    .map((d) => {
      const lower = d.text.toLowerCase();
      const matched = tokens.filter((t) => lower.includes(t)).length;
      return { text: d.text, section: d.section, source: d.source, score: matched / tokens.length };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { search, keywordSearch, escapeRegExp, VECTOR_INDEX_NAME };