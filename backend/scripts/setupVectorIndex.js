// Prints the MongoDB Atlas Vector Search index definition required for the
// RAGDocument collection. Run: npm run setup-vector-index
//
// This script does NOT modify your Atlas cluster - Atlas index creation requires
// the Atlas UI or the Atlas Admin API. Paste the JSON below into:
//   Atlas -> your cluster -> search/vector index -> Create Search Index -> JSON Editor
//
// Note: numDimensions must match your embedding provider (OpenAI text-embedding-3-small = 1536).

const indexDefinition = {
  name: process.env.VECTOR_INDEX_NAME || 'rag_vector_index',
  type: 'vectorSearch',
  fields: [
    {
      type: 'vector',
      path: 'embedding',
      numDimensions: 1536,
      similarity: 'cosine',
    },
    {
      type: 'filter',
      path: 'userId',
    },
    {
      type: 'filter',
      path: 'source',
    },
  ],
};

console.log('==============================================================');
console.log('MongoDB Atlas Vector Search index for the "ragdocuments" collection');
console.log('==============================================================\n');
console.log(JSON.stringify(indexDefinition, null, 2));
console.log('\n--------------------------------------------------------------');
console.log('NOTES');
console.log('1. numDimensions must match EMBEDDING_MODEL (text-embedding-3-small = 1536).');
console.log('   If you use a different model, update numDimensions accordingly.');
console.log('2. The app falls back to keyword search automatically when the vector search falls back');
console.log('   or fails, so the app keeps working until you create this index.');
console.log('--------------------------------------------------------------\n');