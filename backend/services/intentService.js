// Internal intent classification layer for the career assistant.
//
// The chat endpoint uses this to understand what a user wants WITHOUT any manual
// feature selection: greetings, resume analysis, job-description comparisons,
// coding problems, LeetCode requests, DSA prep, learning resources, travel,
// current information, or general follow-up questions.
//
// Detection is deliberately conservative and keyword/dictionary-based. It never
// touches the LLM (no extra token cost) and failures fall back to GENERAL so the
// assistant always keeps answering. The result is used to:
//   - decide whether live web search should be attempted (needsWeb),
//   - give the LLM a hint about the detected intent inside the prompt,
//   - keep the conversation natural for follow-ups ("Give me interview questions"
//     after "What is Java?" is resolved using the history).

const INTENTS = [
  'GENERAL',
  'EMOTIONAL_SUPPORT',
  'CODING',
  'LEETCODE',
  'DSA',
  'CAREER',
  'RESUME',
  'JOB_DESCRIPTION',
  'INTERVIEW',
  'LEARNING',
  'RESOURCE_SEARCH',
  'WEB_SEARCH',
  'TRAVEL',
  'DOCUMENT_ANALYSIS',
  'CURRENT_INFORMATION',
];

// RESUME routing has to be TIGHT. The old pattern matched bare generic nouns
// ("skills", "projects", "education", "summary", "highlight"), so ordinary
// questions like "give me 20 java projects", "list 10 skills to learn" or
// "explain project management" were classified as resume work — which then
// injected the user's resume into the prompt and dragged the answer off-topic.
// Two explicit tiers instead:
//   RESUME_DOC_RE  — the document is named outright (resume / CV / ATS / …).
//   RESUME_FIELD_RE— a resume SECTION is referenced in the user's own words
//                    ("my skills", "work experience section", "project section").
const RESUME_DOC_RE =
  /(\bresumes?\b|\bcv\b|\bcurriculum\s+vitae\b|\bats\b|scannable|objective statement)/i;
const RESUME_FIELD_RE =
  /(work experience|professional summary|achievements?)\b|((?:my|your)\s+(?:skills?|projects?|education|experience|resume|cv)\b)|(skills?|projects?|education|experience)\s+section\b/i;
const RESUME_RE = new RegExp(`${RESUME_DOC_RE.source}|${RESUME_FIELD_RE.source}`, 'i');
const JOB_RE =
  /(job description|jd\b|job posting|role requirements|qualifications|target role|position|compare .* (job|jd|role)|matching|gap analysis|skill gap|does my (resume|profile) (match|fit))/i;
const LEETCODE_RE =
  /(leetcode|hackerrank|codeforces|competitive programming|codechef|problem [sn]?\d|practice (problem|questions?)|coding (problems?|questions?|challenges?)|solve\b)/i;
const DSA_RE =
  /(dsa|data structures?|algorithms?|time complexity|space complexity|sorting|searching|binary search|hash.?map|graph\b|tree\b|linked list|stack\b|queue\b|heap\b|sliding window|two pointers|dynamic programming|recursion|backtracking|greedy|arrays?|string manipulation)/i;
const CODING_RE =
  /(code|coding|program|write|implement|function|script|bug|debug|fix|language|syntax|snippet|armstrong|fibonacci|fizzbuzz|palindrome|anagram|regex|sql|query|database|polymorphism|inheritance|oop)/i;
const INTERVIEW_RE =
  /(interview|rounds?\b|hr question|behavioral|technical questions?|mock|screening|telephonic|onsite)/i;
const LEARNING_RE =
  /(learn|learning|study|course|courses|tutorial|roadmap|syllabus|how (to )?(learn|start|study|prepare)|beginner|advanced|certification|udemy|coursera|edx|freecodecamp|documentation|docs\b|guide|practice)/i;
const RESOURCE_RE =
  /(websites?|resources|platforms?|tools?|best \w+|top \d+|recommend|suggest|list of|where can i|find|discover|links?|youtube|videos?|playlists?|channels?|repos?|github|books?|articles?|papers?)/i;
const TRAVEL_RE =
  /(places? to visit|things to do|tourist|travel\b|trip\b|holiday|vacation|restaurants?|food\b|eat\b|cafes?|attractions|sightseeing|weekend get|hera?ge|bangalore|hyderabad|mumbai|delhi|chennai|kolkata|goa|jaipur|agra|singapore|dubai|london|paris|new york|san francisco|austin)/i;
const CURRENT_RE =
  /(latest|news\b|news today|this year|2026|current|recent|update|announcement|release|version|salary trends|price\b|market trends)/i;
const CAREER_RE =
  /(career|job\b|jobs\b|role\b|position\b|promotion|salary|interview|offer\b|resignation|notice|linkedin|hr\b|portfolio|cover letter|networking|mentor|remote|freelance|startup)/i;
const ANALYSIS_RE =
  /(analy|assess|review|evaluate|improve|critique|feedback|strength|weakness|missing|gap)/i;

// FIRST-PERSON EMOTIONAL / PERSONAL-MOMENT statements. These BEAT topic
// classification: "I failed my interview today" is a personal moment (empathy
// first), NOT the INTERVIEW intent — the old ladder matched INTERVIEW_RE on the
// word "interview" and steered the reply toward career coaching. "I had an
// incident today", "I'm so stressed", "my dog died today" all belong here. A
// request like "give me 10 interview questions" shares that word but has no
// first-person emotion, so it still resolves as a technical intent. Nothing
// here is a canned reply — this classifier only ROUTES; the system prompt
// supplies the actual empathetic behaviour.
const EMOTIONAL_FIRST_RE = /\b(?:i|me|my|mine|we|us|our)\b/i;
const EMOTIONAL_RE =
  /\b(?:failed|failure|incident)\b|\bbroke\s*(?:up|down)\b|\b(?:lost|losing)\b|\b(?:scared|afraid|anxious|anxiety|panic|panicking|worried|worry|worries)\b|\b(?:depressed|depression|down|low|hopeless|unhappy)\b|\b(?:stressed|stress|overwhelmed|burn(?:t|ed)\s*out|burnt\s*out|exhausted|drained|tired)\b|\b(?:lonely|lonesome|alone|no\s+friends)\b|\b(?:sad|sorrow|miserable|hurt|heartbroken|upset|crying|cried|cry)\b|\b(?:angry|anger|frustrated|frustrating|mad|annoyed)\b|\b(?:disappointed|disappointing|embarrassed|humiliated|ashamed|guilty|guilt)\b|\b(?:terrible|awful|horrible|rough|worst)\s+day\b|\bbad\s+day\b|\b(?:regret|regretted|regrets)\b|\b(?:died|death|passed\s+away)\b|\b(?:rejected|rejection|dumped|cheated\s+on|betrayed)\b|\b(?:nervous|shy|insecure|self-?doubt|doubting)\b|\bstruggl(?:e|ing|ed)\b|\b(?:breakdown|meltdown)\b|\bfeel(?:s|ing)?\s+(?:so|very|really|just|a\s+bit|a\s+little|too|extremely|totally|bad|awful|terrible|horrible|sad|lonely|down|upset|sick|unwell|good|great|happy)\b/i;

// Entity lookups ("who is Jonathan Gaming?") need CURRENT / OUTSIDE information.
// A capitalized name is the trigger — "who is my friend" never matches, and a
// name the user already told us about ("who is Karri?" after "my friend's name
// is Karri") stays MEMORY-first and must NEVER become a web search.
const WHO_IS_RE = /\bwho\s+(?:is|are|was|were)\s+(?:(?:a|an|the)\s+)?([A-Z][A-Za-z'’\- .]{1,60})\b/i;

// IDENTITY / SELF questions are about the ASSISTANT itself, so they must never
// be treated as an entity lookup ("Who are you?" used to become a web search for
// the word "you"!). They are answered from the shared identity instructions in
// prompts.js — never from the web, never from the user's documents.
const IDENTITY_RE =
  /\bwho\s+are\s+you\b|\bwhat\s+are\s+you\b|\bare\s+you\s+(?:a\s+|an\s+)?(?:human|real\s+person|real|robot|bot|machine|ai|artificial intelligence|chatgpt|gpt|openai|gemini|claude|llama|copilot|bing)\b|\bwhat(?:'s| is)\s+your\s+name\b|\bdo\s+you\s+have\s+a\s+name\b|\bwhat\s+should\s+i\s+call\s+you\b|\byour\s+name\b|\bintroduce\s+yourself\b|\btell\s+me\s+about\s+yourself\b|\bwho\s+am\s+i\s+talking\s+to\b|\bare\s+you\s+(?:my\s+)?friend\b|\bcan\s+you\s+be\s+my\s+friend\b|\bwill\s+you\s+be\s+my\s+friend\b|\bwho\s+made\s+you\b|\bwho\s+created\s+you\b|\bwho\s+built\s+you\b|\bare\s+you\s+human\b|\bare\s+you\s+real\b/i;

// Study / exam register ("explain for exam", "5 marks answer", "important
// questions", "previous year paper") routes to the LEARNING intent so the
// answer is exam-ready; the exact FORMAT directive comes from outputRequirements.
const EXAM_STUDY_RE =
  /\b(?:exam|exams|examination|examinations|question\s+paper|model\s+paper|previous\s+years?|important\s+questions?|important\s+topics?|expected\s+questions?|numerical\s+problems?)\b|\b\d{1,2}\s*[- ]?marks?\s+(?:answer|question|note|problem|essay)\b|\b(?:for|in|during)\s+(?:the\s+)?(?:exam|test|examination)\b/i;

// First-person / social / emotional statements are CONVERSATIONAL, never
// resource/travel/web-search intents. Without this guard, "my best friend came
// today" would hit RESOURCE_RE ("best \w+") and wrongly turn into a web search.
const CONVERSATIONAL_RE =
  /(^(hi|hey|hello|yo|hola|namaste|sup)\b|^how are you[?!.]*$|^how'?s (it going|your day|everything)[?!.]*$|^what'?s up[?!.]*$|^what is up[?!.]*$|nothing much|i'?m (so |very |really |just )?(happy|sad|tired|bored|stressed|excited|angry|down|anxious|depressed|low|good|great|fine|ok|okay|sick|unwell)|i (am|feel|felt|was|am feeling) (so |very |really |just )?(happy|sad|tired|bored|stressed|excited|angry|down|anxious|depressed|low|good|great|fine|ok|okay)|i (am|'?m) (learning|practicing|studying|preparing for)\b|i (got|had|have) (selected|placed|an offer|a job|bad news|good news|a rank)|failed (my|the|an|a)? (exam|test|interview|subject)|(my|our) (best )?(friend|friends|brother|sister|mom|mum|dad|mother|father|dog|cat|pet|family|girlfriend|boyfriend|classmate|roommate|partner|cousin|uncle|aunt|grandma|grandpa|name)\b|(my|our) (\w+ )?(name is|named|favourite|favorite|project is|goal is|dream is|hobby is)|i (met|saw|visited|went|came|talked to|heard from) (my|our|a|the) (friend|family|brother|sister|mom|dad|dog|cat|boyfriend|girlfriend|classmate|roommate)|^(thank|thanks|thx|thank you)[!.]*$|^bye[!.]*$|^good (morning|afternoon|evening|night)[!.]*$|^(congrats|congratulations|yay|wohoo)[!.]*$|^(how|what) (was|is) (your|ur) (day|weekend|day today)\b|what are you (doing|up to)\b|what'?s going on\b|^(same (old|here)?|just chilling|just chillin|nothing new)[!. ]*$)/i;

/**
 * Detect the primary intent of a question, taking the recent conversation
 * history into account for context-dependent follow-ups.
 * @param {string} question
 * @param {Array<{role:string, content:string}>} history  last few messages
 * @returns {{intent: string, secondary: string|null, needsWeb: boolean, signals: string[]}}
 */
const detectIntent = (question, history = []) => {
  const q = String(question || '').trim();
  const low = q.toLowerCase();
  const signals = [];

  const hit = (re, name) => {
    if (re.test(low)) {
      signals.push(name);
      return true;
    }
    return false;
  };

  // Most-specific topic signals first; the first matching "group" owns `topic`.
  // (A question can mention several of these; the first strong signal decides.)
  let topic = null;
  if (hit(RESUME_RE, 'resume')) topic = 'resume';
  else if (hit(JOB_RE, 'job-description')) topic = 'job';
  else if (hit(LEETCODE_RE, 'leetcode')) topic = 'coding';
  else if (hit(DSA_RE, 'dsa')) topic = 'coding';
  else if (hit(CODING_RE, 'coding')) topic = 'coding';
  else if (hit(INTERVIEW_RE, 'interview')) topic = 'interview';

  // History-aware topic memory: a follow-up like "Give me interview questions"
  // after "What is Java?" resolves to coding/interview, not career advice.
  const lastTopic = (() => {
    for (let i = (history || []).length - 1; i >= 0; i -= 1) {
      const c = String(history[i].content || '').toLowerCase();
      if (/java|python|javascript|react|spring|sql|node|mongo|coding|dsa|leetcode/.test(c)) return 'coding';
      if (/resume|cv/.test(c)) return 'resume';
      if (/jd|job description/.test(c)) return 'job';
    }
    return null;
  })();

  let intent = 'GENERAL';
  const asksCount = /(give me|list|share|need|want|recommend|top)\b/.test(low);

  // FIRST-PERSON EMOTIONAL statements win over every topic below. Routing only:
  // the empathetic behaviour itself lives in the system prompt, this line just
  // makes sure an emotional confession is never downgraded to career coaching.
  if (EMOTIONAL_FIRST_RE.test(low) && EMOTIONAL_RE.test(low)) {
    intent = 'EMOTIONAL_SUPPORT';
    signals.push('emotional');
  } else if (IDENTITY_RE.test(low)) {
    // The user is asking who WE are. Answer from the shared identity
    // instructions (prompts.js) — never a web search for the word "you", never
    // career advice, never the user's documents.
    intent = 'GENERAL';
    signals.push('identity');
  } else if (topic === 'resume') {
    intent = ANALYSIS_RE.test(low) ? 'RESUME' : 'DOCUMENT_ANALYSIS';
  } else if (topic === 'job') {
    intent = 'JOB_DESCRIPTION';
  } else if (topic === 'coding') {
    const wantsProblems = /(problem|practice|solve|question|challenge|exercise)/.test(low);
    if (hit(LEETCODE_RE, 'leetcode') || (wantsProblems && asksCount)) intent = 'LEETCODE';
    else if (hit(DSA_RE, 'dsa')) intent = 'DSA';
    else intent = 'CODING';
  } else if (topic === 'interview') {
    intent = 'INTERVIEW';
  } else if (q.length <= 2 || /^(hello|hi|hey|thanks|thank you|ok|okay|great|nice|bye)\b/.test(low)) {
    intent = 'GENERAL';
  } else if (CONVERSATIONAL_RE.test(low)) {
    // Social/emotional/personal statements ("my best friend came today",
    // "I'm feeling sad", "how are you?", "I got selected!") are friendly
    // conversation — never a resource/web/travel search, never career advice.
    intent = 'GENERAL';
    signals.push('conversational');
  } else if (hit(TRAVEL_RE, 'travel')) {
    intent = 'TRAVEL';
  } else if (hit(CURRENT_RE, 'current')) {
    intent = 'CURRENT_INFORMATION';
  } else if (hit(INTERVIEW_RE, 'interview')) {
    intent = 'INTERVIEW';
  } else if (hit(LEARNING_RE, 'learning')) {
    intent = 'LEARNING';
  } else if (hit(EXAM_STUDY_RE, 'exam-study')) {
    // Exam register ("explain for exam", "5 marks answer", "important
    // questions", "previous year paper") is study prep — exam-ready, not a
    // generic or career answer.
    intent = 'LEARNING';
  } else if (hit(RESOURCE_RE, 'resource-search')) {
    intent = 'RESOURCE_SEARCH';
  } else if (hit(CAREER_RE, 'career')) {
    intent = 'CAREER';
  }

  // Context-dependent follow-ups: "Give me interview questions" right after a
  // Java explainer inherits the coding/job context instead of staying generic.
  // Continuation words ("more", "another", "again", "continue", "make it 20",
  // "give me 10 more") extend the CURRENT topic instead of starting fresh.
  if (intent === 'GENERAL' && lastTopic) {
    const continuation = /(questions?|problems?|interview|practice|prepare|learn|next|more|another|again|continue|extend|expand|keep going|make it \d|\d+ more|examples?)/i;
    if (continuation.test(low)) {
      if (lastTopic === 'coding') {
        intent = /(\d+|more|another|again|continue|next|extend|expand|keep going|problems?|questions?)/i.test(low) ? 'LEETCODE' : 'CODING';
      } else if (lastTopic === 'resume') intent = 'RESUME';
      else if (lastTopic === 'job') intent = 'JOB_DESCRIPTION';
    }
  }

  // Entity lookups that need CURRENT / OUTSIDE information branch OFF the
  // user's documents: "who is Jonathan Gaming?" should use live web (or be
  // honestly uncertain), never guess from stale model knowledge. Personal
  // lookups stay conversation-memory questions ("who is my friend?", and
  // "who is Karri?" when the user already said "my friend's name is Karri")
  // and must never trigger a web search.
  const entity = WHO_IS_RE.exec(low);
  const entityName = entity ? String(entity[1] || '').trim() : '';
  // A pronoun is not an entity: "who is this?" / "who is it?" must not become a
  // web search for the word "this"/"it". Real named entities still do.
  const PRONOUN_ENTITY_RE = /^(?:this|that|it|he|she|they|them|him|her|you|i|we|us|me|these|those|someone|somebody|anyone|anybody|everyone|everybody)$/i;
  const namedInHistory = entityName
    ? (history || []).some((m) => {
        const c = String(m.content || '').toLowerCase();
        return (
          c.includes(entityName.toLowerCase()) &&
          /my\s+(?:friend|brother|sister|dog|cat|pet|girlfriend|boyfriend|partner|name|classmate|roommate|mom|mum|dad|mother|father|uncle|aunt|cousin|grandma|grandpa|family)\b|friend'?s\s+name\s+(?:is|was)\b|\bname\s+is\b/i.test(c)
        );
      })
    : false;
  const entityLookup =
    Boolean(entityName) &&
    !PRONOUN_ENTITY_RE.test(entityName) &&
    !namedInHistory &&
    !IDENTITY_RE.test(low) &&
    !/who\s+is\s+(?:my|our|your)\b/i.test(low) &&
    !/\b(?:my|our)\b/.test(low);
  if (entityLookup) signals.push('entity-lookup');

  const needsWeb =
    entityLookup ||
    intent === 'TRAVEL' ||
    intent === 'CURRENT_INFORMATION' ||
    intent === 'RESOURCE_SEARCH' ||
    (intent === 'LEARNING' && /(websites?|platforms?|courses?|tutorials?|docs|latest|videos?|youtube|playlists?|channels?|repos?|github|books?|articles?)/i.test(low)) ||
    (intent === 'CAREER' && /(market|salary|latest|trends|remote)/i.test(low));

  return { intent, secondary: null, needsWeb, signals };
};

module.exports = { detectIntent, INTENTS };