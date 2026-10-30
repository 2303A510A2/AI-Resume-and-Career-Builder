const RAGDocument = require('../models/RAGDocument');
const { buildAllChunks, chunkLongText } = require('./chunkingService');
const embeddingService = require('./embeddingService');
const vectorSearch = require('./vectorSearchService');
const llmService = require('./llmService');
const webSearch = require('./webSearchService');
const { detectIntent } = require('./intentService');
const { CAREER_ASSISTANT_SYSTEM, RESOURCE_GUIDE_SYSTEM } = require('./prompts');
const { parseStructuredResponse, sanitizeUrl, liftInlineLinks } = require('./resourceService');
const {
  analyzeRequest,
  planOutput,
  buildDirective,
  checkCompleteness,
  buildContinuationPrompt,
  mergeContinuation,
} = require('./outputRequirements');

// ---------------------------------------------------------------------------
// Output budget
//
// The chat used to pick a FIXED, tiny budget per intent (GENERAL 600, CODING 800,
// INTERVIEW 800, LEETCODE/DSA 1500 tokens). That single table was the main reason
// long answers were silently cut off: "tables 1 to 10" stopped at table 8, "20
// LeetCode problems" stopped at 12, "explain Java in 1000 words" came back at
// 250 words. It is gone — the budget is now computed from what the user actually
// requested (count / range / word count / format) by outputRequirements.js.
//
// Per intent we only keep a MINIMUM floor for the structured JSON replies that
// must round-trip through parseStructuredResponse (resources/roadmap/coding JSON),
// because those have a known, small size. Everything free-form uses the dynamic
// plan. `cap` is the absolute ceiling, clamped again inside llmService.
const STRUCTURED_JSON_MIN = { RESOURCE_SEARCH: 1400, LEARNING: 1400, WEB_SEARCH: 900 };
// Document analysis answers are paragraph-rich, so they get more room than the
// small conversational floor.
const DOCUMENT_INTENT_FLOOR = { RESUME: 1200, JOB_DESCRIPTION: 1200, DOCUMENT_ANALYSIS: 1200 };
const MIN_BUDGET = 500;
const MAX_BUDGET_CAP = Number(process.env.LLM_MAX_OUTPUT_TOKENS || 32768);

// Bounded auto-continuation. A provider can still hit its own output ceiling even
// with a correct budget; rather than shipping a cut-off answer we ask for the
// remainder and merge it. Bounded and internal — never shown to the user.
const MAX_CONTINUATIONS = Math.max(0, Math.min(6, Number(process.env.LLM_MAX_CONTINUATIONS || 5)));
const MAX_CONTINUATION_RATE_RETRIES = Math.max(0, Math.min(3, Number(process.env.LLM_CONTINUATION_RATE_RETRIES || 2)));
const CONTINUATION_RATE_LIMIT_MAX_WAIT_MS = Math.max(
  0,
  Number(process.env.LLM_CONTINUATION_RATE_LIMIT_MAX_WAIT_MS || process.env.LLM_RATE_LIMIT_MAX_WAIT_MS || 40000)
);
const CONTINUATION_RETRY_BASE_MS = 800;

const continuationRetryDelay = (attempt, retryAfterMs = 0) => {
  const exponential = CONTINUATION_RETRY_BASE_MS * (2 ** attempt);
  const jitter = Math.round(Math.random() * 250);
  const hinted = Number(retryAfterMs) > 0 ? Number(retryAfterMs) : 0;
  return Math.min(Math.max(exponential, hinted) + jitter, CONTINUATION_RATE_LIMIT_MAX_WAIT_MS);
};

const waitForContinuationRetry = (attempt, error) => {
  const delay = continuationRetryDelay(attempt, error && error.retryAfterMs);
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
};

const isAutoContinuationRetryable = (error) =>
  Boolean(error && error.retryable !== false && [
    'AI_RATE_LIMITED',
    'AI_PROVIDER_ERROR',
    'AI_PROVIDER_UNAVAILABLE',
    'AI_UNREACHABLE',
  ].includes(String(error.code || '')));

// History trimming. The old code clipped EVERY message to 1200 chars, which threw
// away the previous answer's items — "make it 20" / "10 more" / "explain number 5"
// then had nothing to continue. Assistant answers are now kept large; user messages
// stay short.
const HISTORY_TURNS = 8;
const USER_MESSAGE_CHARS = 1500;
const ASSISTANT_MESSAGE_CHARS = 9000;
const TOTAL_HISTORY_CHARS = 32000;

// ---- Conversational style + personal-fact memory ---------------------------
// The user can ask the assistant to change how it talks to them ("talk to me
// like my girlfriend", "talk like my friend", "talk normally"). Nothing about
// any style is hard-coded as a reply — only the STYLE is recognised, and the
// real behaviour comes from the system prompt. The active style is re-derived
// from the conversation on every request, so it survives follow-ups and needs
// no stored state (and no new MongoDB field).
//
// Order matters WITHIN a single message: a reset ("talk normally", "stop the
// romantic style") is listed first so "stop girlfriend style, talk normally"
// resolves to normal rather than to girlfriend.
const STYLE_COMMAND_RE = [
  {
    style: 'normal — clear, warm, natural, no forced affection',
    re: /\b(?:talk|be|speak)\s+(?:to\s+me\s+)?(?:normally|normal|professional(?:ly)?|formal(?:ly)?)\b|\b(?:normal|professional)\s+mode\b|\b(?:stop|end|drop|quit)\s+(?:the\s+|being\s+)?(?:romantic|flirty|flirting|partner|girlfriend|boyfriend)\b/i,
  },
  {
    style: 'casual — relaxed, natural, friendly',
    re: /\b(?:talk|speak|be)\s+(?:to\s+me\s+)?(?:in\s+a\s+)?casual(?:ly)?\b|\bcasual\s+mode\b/i,
  },
  {
    style: 'partner (girlfriend-style) — warm, caring, affectionate, playful and supportive, natural emoji use, honest that you are an AI if directly asked',
    re: /\b(?:talk|speak|be|act)\s+(?:to\s+me\s+)?like\s+(?:my|your|a|the)\s+(?:girl\s?friend|wife)\b|\b(?:act|be|pretend)\s+like\s+(?:my\s+)?girl\s?friend\b|\b(?:be|become)\s+my\s+girl\s?friend\b|\bgirl\s?friend\s+(?:style|mode|persona)\b|\b(?:romantic|love)\s+mode\b/i,
  },
  {
    style: 'partner (boyfriend-style) — warm, caring, affectionate, playful and supportive, natural emoji use, honest that you are an AI if directly asked',
    re: /\b(?:talk|speak|be|act)\s+(?:to\s+me\s+)?like\s+(?:my|your|a|the)\s+(?:boy\s?friend|husband)\b|\b(?:act|be|pretend)\s+like\s+(?:my\s+)?boy\s?friend\b|\b(?:be|become)\s+my\s+boy\s?friend\b|\bboy\s?friend\s+(?:style|mode|persona)\b/i,
  },
  {
    style: 'partner — warm, caring, affectionate, playful and supportive, honest that you are an AI if directly asked',
    re: /\b(?:talk|speak|be|act)\s+(?:to\s+me\s+)?like\s+(?:my|your|a|the)\s+(?:partner|significant\s+other|lover|soul\s?mate)\b|\b(?:be|become)\s+my\s+partner\b|\bpartner\s+(?:style|mode|persona)\b|\b(?:flirt|be\s+flirty)\b/i,
  },
  {
    style: 'friend — warm, casual, playful, supportive, like a close friend',
    re: /\b(?:talk|speak|be|act)\s+(?:to\s+me\s+)?like\s+(?:my|your|a|the)\s+(?:friends?|buddy|bestie|brother|sister|pal)\b|\b(?:act|be)\s+like\s+(?:my\s+)?friends?\b|\b(?:be|become)\s+my\s+friends?\b|\bfriends?\s+(?:style|mode)\b|\b(?:buddy|bestie)\s+mode\b/i,
  },
];

// Personal facts the user states about their own life. These are extracted
// (never invented) and re-stated to the model on every turn of the same
// conversation, which is what makes "what's my friend's name?" answerable even
// when the fact has scrolled out of the trimmed history window. Keys are stable
// so a later correction replaces an earlier value instead of duplicating it.
const FACT_PATTERNS = [
  { key: 'the user\'s name', re: /\bmy\s+name\s+is\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i },
  { key: 'name the user asked you to call them', re: /\b(?:call\s+me|my\s+nickname\s+is|you\s+can\s+call\s+me|everyone\s+calls\s+me)\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i },
  { key: 'nickname the user gave the assistant', re: /\b(?:i(?:'?ll|\s+will)?\s+call\s+you|your\s+nickname\s+is|i(?:'?ll|\s+will)?\s+name\s+you)\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i },
  { key: 'user\'s friend name', re: /\bmy\s+friend(?:'?s)?\s+(?:name\s+)?is\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i },
  { key: 'user\'s girlfriend name', re: /\bmy\s+girl\s?friend(?:'?s)?\s+(?:name\s+)?is\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i },
  { key: 'user\'s boyfriend name', re: /\bmy\s+boy\s?friend(?:'?s)?\s+(?:name\s+)?is\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i },
  { key: 'user\'s pet name', re: /\bmy\s+(?:dog|cat|pet|puppy|kitten)(?:'?s)?\s+(?:name\s+)?is\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i },
  { key: 'user\'s age', re: /\bmy\s+age\s+is\s+(\d{1,3})\b/i },
  { key: 'user\'s role', re: /\bi(?:'m|\s+am)\s+(?:a|an)\s+([A-Za-z][A-Za-z.'\- ]{1,40})/i },
];

// A captured fact value is a NAME, not a sentence: cut at the first word that
// continues the original message ("My friend is Karri and I love cricket" ->
// "Karri") and drop trailing punctuation.
const FACT_VALUE_STOP_RE =
  /\s+(?:and|but|because|so|then|however|though|which|who|that|he|she|they|is|was|are|were|will|would|can|could|should|i|my|we|the|a|an)\b|[.,;:!?]/i;

/** Trim a captured fact to a clean name. Returns '' when nothing usable is left. */
const cleanFactValue = (raw) => {
  const cut = String(raw || '').split(FACT_VALUE_STOP_RE)[0];
  const value = cut.trim().replace(/[\s'.-]+$/, '');
  return value.length >= 2 && value.length <= 40 ? value : '';
};

// Intents where the user's OWN documents are genuinely the subject of the answer.
const DOCUMENT_INTENTS = new Set(['RESUME', 'JOB_DESCRIPTION', 'DOCUMENT_ANALYSIS']);
// Explicit in-question references to "the document", used as a second signal.
const DOCUMENT_HINT_RE =
  /\b(?:my|your|the|this|that)\s+(?:resume|cv|curriculum vitae|job description|jd|profile|document|documents|upload|uploaded file|attached file|career profile)\b|\banalyze\s+(?:my|the|this)\b|\breview\s+(?:my|the|this)\b|\bwhat\s+(?:skills|experience)\s+(?:am i|do i)\b|\bgap\s+analysis\b/i;

/** Continuation answers are plain markdown — no JSON, no cards, nothing to merge around. */
const CONTINUATION_SYSTEM_TAIL = `

CONTINUATION TURN — the previous reply was cut off because it hit the output limit.
Write ONLY the missing continuation of your previous answer, as plain markdown.
- Start immediately with the next item / next paragraph. No preamble, no "Sure", no "Continuing…".
- Do NOT repeat, re-list, or summarise anything you already wrote.
- Do NOT restart numbering; keep the same numbering and the same format.
- No JSON, no resources block, no closing question, no "..." and no "and so on".
- Every single remaining item must be written out.`;

/**
 * Rebuilds the user's canonical knowledge base (resume + job description chunks).
 * Old resume/job/career chunks are replaced; independently indexed documents
 * (source: 'document') are left untouched so they keep serving chat context.
 */
const syncKnowledgeBase = async ({ userId, resume, job }) => {
  await RAGDocument.deleteMany({ userId, source: { $in: ['resume', 'job', 'career'] } });

  const chunks = buildAllChunks({ resume, job });
  if (!chunks.length) {
    return { chunkCount: 0, embeddingStatus: 'none', vectorSearch: false };
  }

  const { embeddings, configured } = await embeddingService.embedMany(chunks.map((c) => c.text));

  const docs = chunks.map((c, i) => ({
    userId,
    source: c.source,
    section: c.section,
    text: c.text,
    metadata: { source: c.source, section: c.section },
    embedding: embeddings[i] || undefined,
  }));

  await RAGDocument.insertMany(docs, { ordered: false });

  return {
    chunkCount: docs.length,
    embeddingStatus: configured ? 'embedded' : 'plain-text',
    vectorSearch: configured,
  };
};

/**
 * Indexes the extracted text of an uploaded document into the user's knowledge
 * base (source: 'document', section: 'full-text'). Honest about embeddings:
 * without an embedding key the chunks are stored as plain text and retrieval
 * falls back to keyword search.
 */
const indexDocumentText = async ({ userId, documentId, fileName, text }) => {
  if (!text || !String(text).trim()) {
    return { chunkCount: 0, status: 'no-text' };
  }

  const chunks = chunkLongText(String(text));
  if (!chunks.length) return { chunkCount: 0, status: 'no-text' };

  const { embeddings, configured } = await embeddingService.embedMany(chunks);

  const docs = chunks.map((t, i) => ({
    userId,
    source: 'document',
    section: 'full-text',
    text: t,
    metadata: { documentId: String(documentId), fileName },
    embedding: embeddings[i] || undefined,
  }));

  await RAGDocument.insertMany(docs, { ordered: false });

  return {
    chunkCount: docs.length,
    status: configured ? 'embedded' : 'plain-text',
  };
};

const hasKnowledge = async (userId) =>
  (await RAGDocument.countDocuments({ userId })) > 0;

const buildContext = (chunks) =>
  chunks
    .filter(Boolean)
    .map((c, i) => `[${i + 1}] (${c.source}/${c.section})\n${c.text}`)
    .join('\n\n');

/**
 * The output-token budget for one chat turn.
 *
 * Dynamic: sized by what the user actually asked for (count / range / word count
 * / format) via outputRequirements.js, then floored per intent for the replies
 * that must round-trip through parseStructuredResponse as JSON, and finally
 * clamped to the absolute ceiling (clamped again inside llmService).
 *
 * This replaces the old fixed per-intent table (GENERAL 600, CODING 800,
 * INTERVIEW 800, LEETCODE/DSA 1500) which silently truncated long answers.
 */
const pickMaxTokens = (intent, req = {}, prefs = {}) => {
  // Structured-JSON replies must fit; document analysis deserves more than the
  // small conversational floor (a resume/JD answer is a paragraph-rich reply).
  const floor = Math.max(STRUCTURED_JSON_MIN[intent] || 0, DOCUMENT_INTENT_FLOOR[intent] || 0);
  const planned = planOutput(req, { cap: MAX_BUDGET_CAP });
  let budget = planned.maxTokens;

  // The saved response-style preference nudges the budget ONLY when the user did
  // not themselves state a count / word count / "everything" — an explicit
  // instruction ("explain in 1000 words") always wins over the preference.
  const explicitShape = Boolean(req.wordCount || req.itemCount || req.wantsAll);
  const style = prefs && prefs.responseStyle;
  if (!explicitShape && style === 'detailed') budget += 500;
  else if (!explicitShape && style === 'concise') budget = Math.max(MIN_BUDGET, budget - 200);

  return Math.min(MAX_BUDGET_CAP, Math.max(MIN_BUDGET, budget, floor));
};

/**
 * Output budget for ONE continuation turn, sized to what is actually MISSING
 * (not to the original request), so completing "tables 1 to 10" after table 8
 * does not pay for 10 tables again.
 */
const continuationBudget = (req, check, cap) => {
  if (check.kind === 'partialRow') {
    // A cut product row ("20: … 20x10=200" of ×20): pay only for the missing
    // multipliers, never for the whole original request again.
    const missing = Math.max(1, (check.partialBound || 0) - (check.partialMaxK || 0));
    return Math.min(cap, Math.max(MIN_BUDGET, missing * 16 + 300));
  }
  if (check.kind === 'words') {
    const missing = Math.max(120, (check.target || 0) - (check.words || 0));
    return Math.min(cap, Math.max(MIN_BUDGET, Math.round(missing * 1.75) + 400));
  }
  if (check.nextIndex != null && check.target != null) {
    const missingItems = Math.max(1, check.target - check.nextIndex + 1);
    const perItem = (req.unitCost || 55) + 12;
    return Math.min(cap, Math.max(MIN_BUDGET, missingItems * perItem + 400));
  }
  return Math.min(cap, 1600);
};

/**
 * Full RAG ask: embed question -> retrieve relevant chunks -> construct context ->
 * detect intent -> call the LLM (with live web when appropriate) -> return answer,
 * resources and sources. Uses the authenticated userId for every query.
 *
 * Retrieval is GATED: it only runs for questions that are genuinely about the
 * user's own documents. The output budget is DYNAMIC (see pickMaxTokens), the
 * fulfilment directive is injected into the system prompt, and the answer is
 * verified for completeness and continued (internally) if the provider cut it off.
 *
 * @param {{ userId, question, history, extraDocuments, attachedImages, userName, requestId }} opts
 *   extraDocuments: verbatim text of the documents the caller explicitly attached
 *   (ownership already validated upstream). Always included so the LLM sees the
 *   actual file content, not only retrieval hits.
 *   attachedImages: [{ fileName, dataUrl }] of vision-ready images the caller
 *   attached (ownership validated). Sent as OpenAI-style image_url content parts
 *   ONLY when vision is configured for the primary provider; otherwise the AI is
 *   honestly told the image could not be analyzed.
 *   userName: the authenticated user's name (from MongoDB, via the JWT) so the AI
 *   can greet the real user naturally.
 *   requestId: unique per user message; used only for safe diagnostics/dedup.
 */

const askCareerAssistant = async ({
  userId,
  question,
  history = [],
  extraDocuments = null,
  attachedImages = [],
  userName = '',
  requestId = '',
  preferences = {},
  onDelta,
  abortSignal,
}) => {
  // ---- Requirement analysis FIRST (pure text, no I/O) -----------------------
  // Everything downstream depends on it: whether retrieval is even relevant, how
  // big the output budget is, what the directive says, and whether the finished
  // answer is actually complete.
  const req = analyzeRequest({ question, history });

  // ---- Automatic intent detection (no manual selection; history-aware) ----
  const intentInfo = detectIntent(question, history);
  const intent = intentInfo.intent;
  // Private routing hint for the model only. Bracketed + explicit so the model
  // never repeats it to the user (scrubInternal also strips any echo).
  const intentLine = `[INTERNAL NOTE - for your own routing only, NEVER mention or quote this to the user: detected intent = ${intent}]`;

  // ---- RAG GATING ----------------------------------------------------------
  // Retrieval used to run for EVERY question and its hits were pasted into the
  // prompt for "hi", "what is Java?" and "explain polymorphism" — so general
  // questions were answered out of the user's resume instead of from the model's
  // own knowledge. It is now gated to questions that are genuinely about the
  // user's own documents (resume / JD / attachments / explicit document wording).
  const wantsDocuments =
    DOCUMENT_INTENTS.has(intent) ||
    Boolean(extraDocuments) ||
    DOCUMENT_HINT_RE.test(String(question || ''));

  let mode = 'none';
  let context = '';
  let chunkCount = 0;
  let sections = [];

  if (wantsDocuments) {
    const topK = Number(process.env.RAG_TOP_K || 6);
    const embedding = await embeddingService.embedText(question);

    const results = embedding
      ? await vectorSearch.search({ userId, embedding, topK })
      : await vectorSearch.keywordSearch({ userId, query: question, topK });

    const chunks = results || [];
    mode = embedding && results ? 'vector' : 'keyword';
    context = buildContext(chunks);
    chunkCount = chunks.length;
    sections = [...new Set(chunks.map((c) => `${c.source}/${c.section}`))].slice(0, 8);

  // Honest full-document fallback: keyword/vector retrieval can legitimately miss
  // even though the user HAS uploaded documents (e.g. "analyze my resume" shares
  // no literal tokens with the resume text when embeddings are not configured).
  // In that case we ground the answer in the user's FULL resume + job text instead
  // of pretending they uploaded nothing.
  if (!chunks.length) {
    const full = await RAGDocument.find({ userId, source: { $in: ['resume', 'job'] } })
      .select('text source section')
      .lean();
    if (full.length) {
      context = full
        .map((c, i) => `[${i + 1}] (${c.source}/${c.section})\n${c.text}`)
        .join('\n\n')
        .slice(0, 12000);
      chunkCount = full.length;
      sections = [...new Set(full.map((c) => `${c.source}/${c.section}`))].slice(0, 8);
      mode = 'full-docs';
    }
  }
  } // end of RAG gating (retrieval only when documents are actually relevant)

  // The fulfilment directive: the exact quantity / length / format the user asked
  // for, rendered as explicit instructions. This is the FIRST line of defence
  // against a short answer; the budget and the continuation loop are the others.
  const directiveBlock = `
OUTPUT REQUIREMENTS FOR THIS REPLY (mandatory — they override your default habits):
${buildDirective(req)}`;

  const extraBlock = extraDocuments
    ? `\n\nATTACHED DOCUMENTS (verbatim text of the files you uploaded with this message):\n${String(extraDocuments).slice(0, 16000)}`
    : '';

  // The real signed-in user's name (from MongoDB) is passed as context so the AI
  // can use it when appropriate — e.g. "Hi Bharath! 👋". Never fabricated.
  const nameBlock = userName
    ? `\n\nThe authenticated signed-in user's name is ${userName}. If the user greets you, respond naturally and use their name when appropriate.`
    : '';

  // ---- Real-time web / resource discovery -----------------------------------
  // Strategy (never faked):
  //   1. Tavily configured        -> pre-search once, inject VERIFIED results,
  //                                  single LLM call (cheapest, deterministic).
  //   2. Tavily NOT configured but
  //      LLM is Groq (browser_search) -> Groq-native round trip inside llmService;
  //                                  the model decides when to search.
  //   3. Otherwise                -> verified registry only (HONEST, no invented links).
  let webBlock = '';
  let useBrowserSearch = false;
  let browserUrls = [];

  if (intentInfo.needsWeb && webSearch.isConfigured()) {
    const web = await webSearch.search(question, { maxResults: 5 });
    if (web.available && web.results.length) {
      webBlock = `\n\nWEB SEARCH RESULTS (VERIFIED URLS):\n${web.results
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
        .join('\n\n')}\n\nUse the URLs above for any resource cards and sources. Do not invent other URLs.`;
    }
  } else if (intentInfo.needsWeb && llmService.supportsBrowserSearch()) {
    useBrowserSearch = true;
  }

  // ---- Conversational style + personal-fact memory -------------------------
  // Both are derived from the conversation ITSELF (the user's own words), so the
  // style survives every later turn and the facts never leave the chat: nothing
  // is stored in MongoDB and nothing is hard-coded about any subject. Only the
  // USER's messages are scanned — the assistant must never be able to switch its
  // own style by echoing "talk like my girlfriend" back at the user.
  const userTurns = [...history, { role: 'user', content: question }].filter(
    (m) => m && (m.role === 'user' || m.role === 'human')
  );

  // Style: the LATEST explicit user preference wins, and it keeps applying until
  // the user changes it. Order matters only inside one message ("stop girlfriend
  // style, talk normally" resolves to normal because the reset patterns run
  // first).
  let styleBlock = '\n\nCURRENT CONVERSATION STYLE: normal';
  for (let i = userTurns.length - 1; i >= 0; i--) {
    const text = String(userTurns[i].content || '');
    let matched = null;
    for (const rule of STYLE_COMMAND_RE) {
      if (rule.re.test(text)) { matched = rule.style; break; }
    }
    if (matched) {
      styleBlock =
        `\n\nCURRENT CONVERSATION STYLE (set by the user in this conversation): ${matched}` +
        ' Follow it in tone, warmth and phrasing, and keep using it until the user' +
        ' explicitly asks for a different style. The style changes HOW you answer —' +
        ' never WHAT you know or how accurate you are.';
      break;
    }
  }

  // Personal facts the user stated about themselves ("my friend's name is Karri").
  // Keyed so a later correction replaces an earlier value instead of duplicating.
  const facts = new Map();
  for (const turn of userTurns) {
    for (const { re, key } of FACT_PATTERNS) {
      const m = String(turn.content || '').match(re);
      if (!m) continue;
      const value = cleanFactValue(m[1]);
      if (value) facts.set(key, `${key} = ${value}`);
    }
  }
  const factsBlock = facts.size
    ? `\n\nKNOWN PERSONAL FACTS (the user already told you these in this conversation):\n${[...facts.values()].join('\n')}\nAnswer questions about them directly.`
    : '';

  // The shared system prompt WITHOUT the structured-JSON resource guide. The
  // continuation turns reuse it, so a continuation can never come back as a JSON
  // fragment that would have to be merged around.
  // ---- Per-intent layer -----------------------------------------------------
  // Layered prompt architecture: BASE instructions + personality style +
  // personal-fact memory + THIS intent tail + output-requirement directive +
  // (history / RAG / web / file / image context on the user turn). Only one
  // conditional tail exists today — emotional moments — because those are the
  // one case where the default "helpful assistant" tone is wrong. Everything
  // else stays inside the shared base prompt, so the assistant keeps answering
  // as a general assistant first, always.
  const intentTail =
    intent === 'EMOTIONAL_SUPPORT'
      ? `\n\nTHIS IS A PERSONAL, EMOTIONAL MOMENT (the user shared a feeling or a difficult personal situation, or just had a hard day). Lead with genuine warmth and empathy — acknowledge what they said first, in their tone, before anything else. Then, if it helps and only if appropriate, offer short, concrete, non-preachy help or a natural follow-up question. Do NOT turn this into career advice, a checklist, a lecture, a sales pitch for app features, or a generic "I'm here to help". Keep it human, brief, and warm.`
      : '';

  // ---- User preference layer (from the user's saved Settings) ---------------
  // These are the user's OWN saved preferences. They only shape HOW an answer is
  // delivered; they NEVER override an explicit instruction in the current message
  // ("explain in 1000 words", "give me 20", "only the code") — that is checked
  // via `explicitShape` so a saved "concise/detailed" style can never fight a
  // direct request.
  const prefs = preferences && typeof preferences === 'object' ? preferences : {};
  const stylePref = ['concise', 'balanced', 'detailed'].includes(prefs.responseStyle) ? prefs.responseStyle : 'balanced';
  const prefLang = typeof prefs.language === 'string' ? prefs.language.trim() : '';
  const explicitShape = Boolean(
    req.wordCount || req.itemCount || req.wantsAll || req.codeOnly ||
    (req.format && req.format !== 'auto' && req.format !== 'explanation')
  );
  const prefLines = [];
  if (!explicitShape && stylePref === 'concise') {
    prefLines.push(
      'The user set their preferred reply style to CONCISE. Keep answers tight and to the point with no padding. If the current message explicitly asks for more detail or a specific length, follow that instead.'
    );
  }
  if (!explicitShape && stylePref === 'detailed') {
    prefLines.push(
      'The user set their preferred reply style to DETAILED. Give a thorough, well-developed answer with context and examples where useful. If the current message explicitly asks for a short answer or a specific length, follow that instead.'
    );
  }
  if (prefLang && prefLang !== 'auto') {
    prefLines.push(
      `The user selected ${prefLang} as their preferred language. Reply in ${prefLang} unless the current message is clearly written in another language, in which case match that language.`
    );
  }
  const preferenceBlock = prefLines.length
    ? `\n\nUSER PREFERENCES (saved in the user's settings — respect them unless the current message says otherwise):\n${prefLines.join('\n')}`
    : '';

  const baseSystem = `${CAREER_ASSISTANT_SYSTEM}${nameBlock}${styleBlock}${factsBlock}${intentTail}${preferenceBlock}${directiveBlock}`;

  // ---- History window ------------------------------------------------------
  // The old code clipped EVERY message to 1200 chars. That is what destroyed
  // follow-ups: after "give me 20 questions", the 1200-char slice of the answer
  // only held items 1-4, so "make it 20" / "10 more" / "explain number 5" had
  // nothing to continue. Assistant answers are now kept (largely) intact while
  // the TOTAL window stays bounded, so a long answer can still be followed up on
  // without blowing the prompt budget.
  const trimmedHistory = (() => {
    const out = [];
    let budget = TOTAL_HISTORY_CHARS;
    for (const m of (history || []).slice(-HISTORY_TURNS).reverse()) {
      const isAssistant = m && (m.role === 'ai' || m.role === 'assistant');
      const limit = isAssistant ? ASSISTANT_MESSAGE_CHARS : USER_MESSAGE_CHARS;
      const text = String((m && m.content) || '').trim();
      if (!text) continue;
      const kept = text.length > limit
        ? (isAssistant ? text.slice(-limit) : text.slice(0, limit))
        : text;
      const cost = kept.length;
      if (cost > budget) {
        // Still include a short assistant tail rather than nothing at all, so
        // "10 more" keeps its anchor.
        if (isAssistant && budget > 400) {
          const tail = kept.slice(-budget);
          out.push({ role: 'assistant', content: tail });
        }
        break;
      }
      budget -= cost;
      out.push({ role: isAssistant ? 'assistant' : 'user', content: kept });
    }
    return out.reverse();
  })();

  const messages = [
    { role: 'system', content: `${baseSystem}\n\n${RESOURCE_GUIDE_SYSTEM}` },
    ...trimmedHistory,
  ];

  // ---- Vision (image attachments) -------------------------------------------
  // When an image is attached, the REAL pixels are sent as OpenAI-style content
  // parts against a vision-capable model. The primary text model may be text-only
  // (e.g. gpt-oss on Groq → 400 on image parts), so LLM_VISION_MODEL (default
  // qwen/qwen3.8-27b) is used ONLY for requests that actually carry images —
  // plain chat keeps using the faster/generous primary model. If no vision model
  // is available, the AI is honestly told the image could not be analyzed and
  // still answers the text question naturally without claiming it saw the image.
  const images = (Array.isArray(attachedImages) ? attachedImages : []).filter(
    (img) => img && img.dataUrl && String(img.fileName || '').trim()
  );
  const VISION_MODEL = String(process.env.LLM_VISION_MODEL || 'qwen/qwen3.8-27b').trim();
  const visionFlag = ['1', 'true'].includes(String(process.env.LLM_VISION || '').trim().toLowerCase());
  const visionOn = images.length > 0 && visionFlag && llmService.supportsVisionModel(VISION_MODEL);
  let userContent;
  // The knowledge-base block is only rendered when retrieval actually ran. For a
  // general question ("what is Java?") there is deliberately NO "USER KNOWLEDGE
  // BASE" section at all — the old code always injected it, which pushed the model
  // to answer general questions out of the user's resume.
  const knowledgeBlock = wantsDocuments
    ? `USER KNOWLEDGE BASE (from my uploaded resume, job description and documents):\n${
        context || '(no knowledge base yet - the user has not provided resume/job documents)'
      }`
    : '';
  const textContent = `${intentLine}${knowledgeBlock ? `\n\n${knowledgeBlock}` : ''}${extraBlock}${webBlock}${images.length && !visionOn
    ? `\n\nNOTE: ${images.length} image file(s) were attached (${images.map((i) => i.fileName).join(', ')}), but the currently configured AI model cannot analyze images. Do not claim you saw or read the image. If the user needs the image analyzed, suggest uploading it as a PDF/text or ask the admin to enable a vision-capable provider.`
    : ''}\n\nMY QUESTION: ${question}`;

  if (images.length && visionOn) {
    userContent = [
      { type: 'text', text: textContent },
      ...images.map((img) => ({
        type: 'image_url',
        image_url: { url: img.dataUrl },
        // The file name is an honest label only (never parsed as instructions).
      })),
    ];
  } else {
    userContent = textContent;
  }
  messages.push({ role: 'user', content: userContent });

  // Whether this request has a countable/length target at all. Only such
  // requests can pay for the completeness check + continuation loop.
  const plan = planOutput(req, { cap: MAX_BUDGET_CAP });

  // ---- Real LLM call -------------------------------------------------------
  // Casual chat (GENERAL) answers warmest; coding-mentor intents (CODING/DSA/
  // LEETCODE/LEARNING) get a friendly-but-accurate tone; analytical intents stay
  // more deterministic. Personality changes with intent; accuracy never drops.
  // (0.6 keeps personal-fact recall reliable while staying warm — 0.7 drifted.)
  const temperature = ['GENERAL', 'EMOTIONAL_SUPPORT'].includes(intent) ? 0.6 : ['CODING', 'DSA', 'LEETCODE', 'LEARNING'].includes(intent) ? 0.6 : 0.4;
  let raw;
  let providerTruncated = false;
  let providerCancelled = false;
  let providerFinishReason = '';
  // The provider that actually answered (primary or fallback). Continuation
  // turns are pinned to it ("same provider first where appropriate"): a long
  // answer is never re-sent to a provider that just failed mid-answer.
  let activeProvider = '';
  let activeModel = '';
  try {
    if (useBrowserSearch && typeof onDelta !== 'function') {
      const r = await llmService.chatWithBrowserSearch({
        messages,
        temperature,
        maxTokens: pickMaxTokens(intent, req, prefs),
        requestId,
      });
      raw = r.content;
      providerTruncated = Boolean(r.truncated);
      providerCancelled = Boolean(r.cancelled);
      providerFinishReason = String(r.finishReason || '');
      if (r.toolUsed && r.urls.length) browserUrls = r.urls;
      if (r.provider) activeProvider = r.provider;
      if (r.model) activeModel = r.model;
    } else {
      // Image requests go to the vision-capable LLM_VISION_MODEL; text stays on
      // the primary model (best free-tier token budget for conversation).
      const r = await llmService.chat({
        messages,
        temperature,
        maxTokens: pickMaxTokens(intent, req, prefs),
        requestId,
        onDelta,
        abortSignal,
        returnMeta: true,
        ...(visionOn ? { model: VISION_MODEL, noFallback: true } : {}),
      });
      raw = r.content;
      providerTruncated = Boolean(r.truncated);
      providerCancelled = Boolean(r.cancelled);
      providerFinishReason = String(r.finishReason || '');
      if (r.provider) activeProvider = r.provider;
      if (r.model) activeModel = r.model;
    }
  } catch (err) {
    // Propagate the clean provider error untouched (the controller turns it into
    // a user-friendly Retry bubble). Never leak provider internals here.
    if (err && err.isOperational) throw err;
    throw err;
  }

  // If the model returned the structured { answer, resources, sources } form,
  // parse and sanitize it. Any other reply is used as-is (plain text).
  // First scrub any leaked internal markers ("DETECTED INTENT: X", "[INTERNAL...]")
  // the model might echo back — such internals must never reach the user.
  const scrubInternal = (t) =>
    String(t || '')
      .replace(/^\[?DETECTED INTENT: [A-Z_]+[\]:\s.,!-]*/i, '')
      .replace(/^\[INTERNAL[^\]]*\]\s*/i, '')
      .trim();
  const cleanRaw = scrubInternal(raw);
  const structured = parseStructuredResponse(cleanRaw);
  let resources = structured ? structured.resources : [];
  let answer = structured ? structured.answer : cleanRaw;

  // ---- Automatic continuation (never a visible message) --------------------
  // Three independent defences protect the user from a short answer:
  //   1. the DYNAMIC budget above (sized to the request), and
  //   2. the fulfilment DIRECTIVE injected into the system prompt, and
  //   3. this loop: verify the delivered answer against the request and, if it is
  //      still short, ask the provider for the missing remainder.
  // The instruction is sent as an extra provider-only turn; it is NEVER persisted
  // to the chat and never rendered, so the user sees one seamless answer. It is
  // bounded (LLM_MAX_CONTINUATIONS, hard cap 6) and every merge is
  // de-duplicated, so nothing is repeated and nothing loops forever.
  let completionState = { continuationAttempts: 0 };
  if (!providerCancelled && MAX_CONTINUATIONS > 0 && plan.needsContinuation) {
    let guard = 0;
    let continuationAttempts = 0;
    let continuationFailure = '';
    let continuationStopped = '';
    while (guard < MAX_CONTINUATIONS) {
      guard += 1;
      const check = checkCompleteness(answer, req);
      // The provider ADMITTING it hit the output ceiling is decisive: item
      // markers can all be present while a row's CONTENT is still cut off
      // ("20: … 20x10=200"), so trust truncation over a verdict that only
      // counted markers. (A check-complete + truncated answer continues once;
      // the merge's no-growth guard stops it if nothing new arrives.)
      if (check.complete && !providerTruncated) break;
      // Nothing measurable is missing (e.g. a 1-item request that came back
      // complete) — do not spend another provider call.
      if (check.kind !== 'none' && check.nextIndex === null && check.kind === 'words' && (check.words || 0) > (check.target || 0)) break;

      const contBudget = continuationBudget(req, check, MAX_BUDGET_CAP);
      let extra = '';
      let continuationError = null;
      const contMessages = [
        { role: 'system', content: `${baseSystem}${CONTINUATION_SYSTEM_TAIL}` },
        ...messages.slice(1),
        { role: 'assistant', content: answer },
        { role: 'user', content: buildContinuationPrompt({ req, check, question }) },
      ];
      for (let retry = 0; retry <= MAX_CONTINUATION_RATE_RETRIES; retry += 1) {
        try {
          continuationAttempts += 1;
          const r = await llmService.chat({
            messages: contMessages,
            temperature,
            maxTokens: contBudget,
            requestId,
            onDelta,
            abortSignal,
            returnMeta: true,
            // Continue on the SAME provider that produced the partial answer —
            // the primary is not re-probed if the fallback rescued the first pass.
            ...(activeProvider ? { preferProvider: activeProvider, preferModel: activeModel || undefined } : {}),
          });
          extra = String(r.content || '');
          providerTruncated = Boolean(r.truncated);
          providerCancelled = Boolean(r.cancelled);
          providerFinishReason = String(r.finishReason || '');
          continuationError = null;
          break;
        } catch (err) {
          continuationError = err;
          if (!isAutoContinuationRetryable(err) || retry >= MAX_CONTINUATION_RATE_RETRIES) break;
          await waitForContinuationRetry(retry, err);
        }
      }
      if (continuationError) {
        // A continuation failure must NEVER destroy an answer we already have.
        continuationFailure = continuationError.requestTooLarge
          ? 'AI_REQUEST_TOO_LARGE'
          : String(continuationError.code || 'AI_PROVIDER_ERROR');
        console.warn(
          `[AI] continuation ${guard}/${MAX_CONTINUATIONS} failed, keeping the existing answer (${continuationFailure})`
        );
        break;
      }
      const merged = mergeContinuation(answer, extra);
      // No growth means the provider only repeated what we already had — stop.
      if (merged.length <= answer.length + 20) {
        continuationStopped = 'no_progress';
        break;
      }
      answer = merged;
    }
    const afterContinuations = checkCompleteness(answer, req);
    if (
      guard >= MAX_CONTINUATIONS &&
      !continuationFailure &&
      !continuationStopped &&
      (!afterContinuations.complete || providerTruncated)
    ) {
      continuationStopped = 'attempt_limit';
    }

    if (continuationFailure || continuationStopped) {
      console.warn(
        `[AI] continuation stopped requestId=${requestId || '-'} attempts=${continuationAttempts}` +
          `${continuationFailure ? ` failure=${continuationFailure}` : ''}` +
          `${continuationStopped ? ` reason=${continuationStopped}` : ''}`
      );
    }

    completionState = {
      continuationAttempts,
      ...(continuationFailure ? { continuationFailure } : {}),
      ...(continuationStopped ? { continuationStopped } : {}),
    };
  }

  const finalCheck = checkCompleteness(answer, req);
  const completion = (plan.needsContinuation || providerCancelled)
    ? {
        complete: finalCheck.complete && !providerTruncated && !providerCancelled,
        kind: finalCheck.kind,
        requested: req.itemCount || req.wordCount || null,
        produced: finalCheck.produced,
        nextIndex: finalCheck.nextIndex,
        target: finalCheck.target,
        ...(finalCheck.duplicates?.length ? { duplicates: finalCheck.duplicates } : {}),
        ...(finalCheck.missing?.length ? { missing: finalCheck.missing } : {}),
        finishReason: providerFinishReason,
        providerTruncated,
        ...(providerCancelled ? { stopped: 'cancelled' } : {}),
        continuationAttempts: completionState.continuationAttempts,
        ...(completionState.continuationFailure ? { failure: completionState.continuationFailure } : {}),
        ...(completionState.continuationStopped ? { stopped: completionState.continuationStopped } : {}),
        reason: providerTruncated && finalCheck.complete
          ? 'The provider stopped before the full response was confirmed.'
          : finalCheck.reason,
      }
    : null;

  // Sources: prefer the LLM-declared, sanitized list; fall back to the real URLs
  // returned by the Groq browser_search round trip when the answer text cites them.
  let sources = structured && structured.sources ? structured.sources : [];
  if (!sources.length && browserUrls.length) {
    // These URLs came back from the provider's grounded `browser_search` round
    // trip, not from the model's imagination, so they are already verified and
    // are allowed through regardless of the curated host allowlist.
    const seen = new Set();
    sources = browserUrls
      .map((u) => sanitizeUrl(u, { verified: true }))
      .filter((u) => u && !seen.has(u) && (seen.add(u), true))
      .slice(0, 6)
      .map((u) => {
        let domain = '';
        try { domain = new URL(u).hostname.replace(/^www\./, ''); } catch { /* keep empty */ }
        return { title: domain, url: u, domain, snippet: '' };
      });
  }

  // Any URL the model wrote INLINE in the answer is clickable in the chat UI.
  // Lift those into Sources chips (and into cards when it returned none), so a
  // plain-text "here are 10 websites to learn Java" reply still hands the user
  // real, openable links instead of a bare list of names.
  ({ resources, sources } = liftInlineLinks(answer, resources, sources));

  // Never expose raw internals; limit metadata returned to the client.
  return {
    answer,
    resources,
    sources,
    completion,
    mode,
    chunkCount,
    sections,
    intent,
  };
};

// pickMaxTokens / continuationBudget are exported so the deterministic suites can
// assert the REAL budget path (and not just planOutput in isolation).
module.exports = {
  syncKnowledgeBase,
  indexDocumentText,
  hasKnowledge,
  buildContext,
  askCareerAssistant,
  pickMaxTokens,
  continuationBudget,
  DOCUMENT_INTENTS,
  DOCUMENT_HINT_RE,
};