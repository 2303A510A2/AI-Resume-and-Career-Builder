// General IMAGE intent detection for the unified AI assistant.
//
// This decides, from natural language only (no command, no mode switch), whether
// the user wants:
//   GENERATE  -> create a NEW image from a text description ("create an image of ...")
//   EDIT      -> generate from an attached/uploaded image ("a picture based on this image")
//   UNDERSTAND-> analyse an image that already exists ("look at this image")
//   NONE      -> ordinary text answer ("what is Java?")
//
// Design rules:
//   * GENERAL. Nothing is hard-coded about any subject (no "if it contains Krishna
//     ..."). Only the *operation* is detected: generation verbs, image nouns,
//     reference words and follow-up modification words.
//   * Image GENERATION and image UNDERSTANDING are deliberately kept apart so
//     "look at this image" never turns into a generated picture.
//   * Conversational follow-ups ("make it at night", "add flying cars", "make it
//     more realistic") are image requests when the previous assistant turn was an
//     image, and ordinary text questions otherwise ("now explain the symbolism").
//   * Text artifacts are protected: "write a java program", "make it 20",
//     "create a table", "generate a report" must stay on the text path.

const VERB_RE =
  /\b(create|generate|make|draw|paint|render|design|illustrate|visuali[sz]e|sketch|depict)\b/i;

// An imperative that starts the sentence is a strong generation signal
// ("draw a cat" has no image noun but is unmistakably a drawing request).
const STRONG_START_RE =
  /^(please\s+|can you\s+|could you\s+|i (?:want|need)\s+(?:you\s+)?to\s+|now\s+)?(create|generate|make|draw|paint|render|design|illustrate|visuali[sz]e|sketch)\b/i;

// The media nouns that make a request an image request.
const NOUN_RE =
  /\b(image|images|picture|pictures|photo|photos|photograph|photographs|artwork|artworks|art|painting|paintings|drawing|drawings|sketch|sketches|illustration|illustrations|poster|posters|logo|logos|banner|banners|wallpaper|avatar|avatars|icon|icons|emoji|emojis|mural|murals|graphic|graphics|visual|visuals|render|renders|concept art|character design|sticker|stickers|clipart|infographic|diagram|diagrams|thumbnail|thumbnails|book cover|cover art|portrait|landscape|scene|scenes|storyboard|comic|comics|tattoo design|mockup)\b/i;

// Referring to an image that ALREADY exists -> understanding, not generation.
const UNDERSTAND_RE =
  /\b(what('| i)?s|whats|what|which|who|why|how)\b[^.?!]{0,60}\b(in|inside|on|about|with|wrong|error|issue|problem|happening|see|visible|shown|this|that|image|picture|photo|screenshot|pic|graphic|diagram|chart)\b|^\s*(look|explain|describe|analy[sz]e|read|interpret|identify|describe|summari[sz]e|translate|ocr|tell me (about|what))\b[^.?!]{0,60}\b(image|picture|photo|screenshot|pic|graphic|diagram|text|screen|this|that)\b|\b(is|are) (there|anything|someone|some text)\b[^.?!]{0,40}\b(image|picture|photo|screenshot|screen)\b|\b(screenshot|photo|picture|image)\b[^.?!]{0,30}\b(looks|look|showing|shows|says|say|contains|contain)\b/i;

// "based on this image" / "from the attached photo" -> image-to-image.
const EDIT_REF_RE =
  /\b(based on|from|using|like|similar to|edit|modify|change|transform|redraw)\b[^.?!]{0,30}\b(this|these|the|my|that|attached|uploaded|given)\b[^.?!]{0,20}\b(image|picture|photo|screenshot|pic|drawing|sketch|art|logo|poster|it)\b/i;

// Modification wording for a conversational follow-up on the previous image.
// Note: discourse fillers ("now", "also", "then") are deliberately NOT part of a
// follow-up on their own — "now explain the symbolism" is a question, not a
// request for a new picture. They are stripped before the test instead.
const MOD_START_RE =
  /^\s*(make|add|change|convert|turn|put|set|use|keep|try|render|redraw|recreate|re-?do|zoom|crop|rotate|give me|show me)\b/i;

// Something that clearly points back at the image already on screen.
const REFERENCE_RE =
  /\b(it|its|this|that|them|these|those)\b|\b(the (image|picture|photo|scene|logo|poster|background|foreground))\b/i;

const FOLLOW_UP_RE =
  /^\s*(make|add|change|convert|turn|put|set|use|keep|try|render|redraw|recreate|re-?do|zoom|crop|rotate|give me|show me)\b|^\s*(it|this|that|the image|the picture|the photo|the scene|the logo|the poster|the background|the foreground|this one|the same one)\b|\b(it|this|that|the image|the picture|the photo|the scene|the logo|the poster|the background|the foreground)\b[^.?!]{0,40}\b(more|less|realistic|realistically|bigger|smaller|larger|brighter|darker|night|nighttime|day|daytime|sunny|cloudy|color|colour|colours|colors|style|background|foreground|detail|details|sharper|blurry|blurred|old|young|different|similar|better|worse|version|variant|without|instead|instead of|anime|cartoon|realistic photo|4k|hdr)\b/i;

// Pure conversational filler that carries no intent of its own.
const LEADING_FILLER_RE =
  /^\s*(please\s+|ok(ay)?\s+|well\s+|hey\s+|so\s+|and\s+|also\s+|then\s+|first\s+|next\s+|now\s+|again\s+)+/i;

// A question about perception ("what do you see?") with no image noun in it —
// about an image that is already in the conversation.
const PERCEPTION_QUESTION_RE =
  /\b(what|which|who|why|how)\b[^.?!]{0,40}\b(do|does|did|can|could|should|would|will)\s+(you|we|i|it)\s+(see|notice|observe|spot|tell)\b|\b(do|does|did)\s+(you|we|i)\s+(see|notice|observe|spot)\b/i;

// Things that LOOK like "make/create ..." but are ordinary text answers.
const TEXT_ARTIFACT_RE =
  /\b(program|programme|code|codebase|function|method|class|script|snippet|algorithm|regex|regular expression|query|sql|html|css|react component|component|test case|test cases|unit test|boilerplate|table|tables|list|lists|report|summary|summarise|summarize|paragraph|essay|email|cover letter|resume|cv|roadmap|website|web page|webpage|app|application|api|endpoint|database|schema|json|csv|spreadsheet|formula|equation|chart|graph|document|doc|docx|pdf|powerpoint|slide deck|slides|presentation|note|notes|plan|steps|answer|solution|explanation|analogy|poem|story|joke|question|questions|problem|problems|leetcode solution|difference|comparison|steps to follow)\b/i;

// "make it 20" / "give me 10 more" -> list continuation, never an image.
// A numeric continuation always wins; a bare "more/another/the same" only counts
// when the sentence ends there, so "make it more realistic" stays an image
// modification instead of being read as "give me more items".
const LIST_CONTINUATION_RE =
  /\b(make|give|show|send)\s+(it|them|those|these)?\s*\d+\b|\b\d+\s*(more|additional|new)\b|\b(make|give|show|send)\s+(it|them|those|these)?\s*(more|another|the same|less|fewer)\s*[.!]?\s*$/i;

// A bare modifier phrase with no verb ("more realistic", "at night please").
const BARE_MODIFIER_RE =
  /^(more|less|most|least|very|really|so|too|quite|extremely|fully|partially|slightly|realistic|realistically|cinematic|photographic|anime|cartoon|watercolou?r|brighter|darker|sharper|blurrier|simpler|simplest|detailed|bigger|smaller|larger|colder|warmer|older|younger|vivid|dramatic|dark|bright|at night|in the rain|upside down)\b/i;

// The reference half of FOLLOW_UP_RE, without its leading-verb alternative — used
// once an image is on screen so "make a list of topics" cannot match on "make".
const BARE_REFERENCE_RE =
  /^\s*(it|this|that|them|these|those|the image|the picture|the photo|the scene|the logo|the poster|the background|the foreground|this one|the same one)\b|\b(it|this|that|the image|the picture|the photo|the scene|the logo|the poster|the background|the foreground)\b[^.?!]{0,40}\b(more|less|realistic|realistically|bigger|smaller|larger|brighter|darker|night|nighttime|day|daytime|sunny|cloudy|color|colour|colours|colors|style|background|foreground|detail|details|sharper|blurry|blurred|old|young|different|similar|better|worse|version|variant|without|instead|instead of|anime|cartoon|4k|hdr)\b/i;

// "the sky red" / "background blue"
const COLOUR_CLAUSE_RE =
  /^(?:the\s+)?[a-z]+\s+(red|blue|green|black|white|gold|golden|silver|pink|purple|orange|yellow|brown|gray|grey|beige|cyan|magenta)\.?$/i;

const QUESTION_START_RE =
  /^(what|why|how|who|when|where|which|is|are|does|do|did|can|could|should|would|will|explain|describe|tell|give)\b/i;

const strip = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const lower = (s) => strip(s).toLowerCase();

const countWords = (s) => strip(s).split(' ').filter(Boolean).length;

/**
 * The raw subject of the request, with the redundant "create an image of ..."
 * wrapper removed while every descriptive word the user typed is preserved.
 * "Create a beautiful digital painting of Krishna playing flute under a moonlit sky"
 *   -> "beautiful digital painting of Krishna playing flute under a moonlit sky"
 */
const stripGenerationWrapper = (text) => {
  let s = strip(text);
  s = s.replace(/^(please\s+|can you\s+|could you\s+|now\s+|i (?:want|need)\s+(?:you\s+)?to\s+)/i, '');
  s = s.replace(
    /^(create|generate|make|draw|paint|render|design|illustrate|visuali[sz]e|sketch|depict)\s+(me\s+)?(an?\s+|the\s+|some\s+)?(image|picture|photo|photograph|artwork|art|painting|drawing|sketch|illustration|poster|logo|banner|wallpaper|avatar|icon|emoji|mural|graphic|visual|render|scene|concept art|character design|book cover|cover art|thumbnail|portrait|infographic|diagram|digital painting|oil painting|watercolor painting)\s+(of|showing|depicting|that shows|with|about|for)\s+/i,
    ''
  );
  s = s.replace(/^(create|generate|make|draw|paint|render|design|illustrate|visuali[sz]e|sketch|depict)\s+(me\s+)?(an?\s+|the\s+)?/i, '');
  s = s.replace(/[.!?]+$/, '');
  return strip(s);
};

/**
 * Cleans a conversational image follow-up into a modification clause that can be
 * appended to the previous image's prompt, without losing the user's words:
 *   "make it more realistic"        -> "more realistic"
 *   "add flying cars"               -> "with flying cars"
 *   "make it at night"              -> "at night"
 *   "make the background more dramatic" -> "more dramatic background"
 */

// Leading imperative verb + the object it refers to.
const OBJ_RE =
  /^(make|add|change|convert|turn|put|set|use|keep|try|render|redraw|recreate|re-?do|zoom|crop|rotate|give me|show me)\s+(me\s+)?(an?\s+|the\s+)?(it|this|that|them|these|those|the image|the picture|the photo|the scene|the logo|the poster|the background|the foreground|this one|the same one)\s*(?=(more|less|very|really|at|in|on|with|without|during|under|over|near|and|,|\b))/i;

// A bare pronoun object adds nothing once the clause has been cleaned.
const PRONOUN_OBJECT_RE = /^(it|its|this|that|them|these|those|this one|the same one)$/i;

const buildFollowUpModification = (text) => {
  let s = strip(text).replace(/[.!?]+$/, '');
  s = s.replace(/^(please\s+|can you\s+|could you\s+|now\s+|and\s+|also\s+|then\s+)/i, '');
  // Leading imperative verb + the object it refers to. The object noun is kept so
  // "make the background more dramatic" still says WHICH part is dramatic.
  let objectNoun = '';
  const objMatch = s.match(OBJ_RE);
  if (objMatch) {
    objectNoun = String(objMatch[4] || '').replace(/^the\s+/i, '');
    s = s.replace(OBJ_RE, '');
  }
  s = s.replace(/^(make|add|change|convert|turn|put|set|use|keep|try|render|redraw|recreate|re-?do|zoom|crop|rotate)\s+/i, '');
  s = s.replace(/^(me\s+)/i, '');
  s = s.replace(/^(it|this|that|them|these|those)\s+/i, '');
  s = strip(s);

  // "background more dramatic" -> "more dramatic background"
  const rearranged = s.match(/^(?:the\s+)?([a-z]+)\s+(more|less|very|really|brighter|darker|sharper|blurrier|colder|warmer|realistic|realistically|dramatic|vivid|simple|busy)\s+([a-z][\w-]*)$/i);
  if (rearranged) s = `${rearranged[2]} ${rearranged[3]} ${rearranged[1]}`;
  // "the sky red" -> "red sky"
  const colour = s.match(/^(?:the\s+)?([a-z]+)\s+(red|blue|green|black|white|gold|golden|silver|pink|purple|orange|yellow|brown|gray|grey|beige|cyan|magenta)$/i);
  if (colour) s = `${colour[2]} ${colour[1]}`;

  // Re-attach the part the user was changing when the cleaned clause dropped it.
  if (objectNoun && !PRONOUN_OBJECT_RE.test(objectNoun) && !new RegExp(`\\b${objectNoun}\\b`, 'i').test(s)) {
    s = `${s} ${objectNoun}`;
  }

  s = strip(s);
  if (!s) return '';
  // Already a full clause ("look like a painting") — keep the user's own words.
  if (/\b(like|with|as|in|at|on|under|over|instead|but|and)\b/i.test(s)) return s;
  if (/^(more|less|most|least|very|really|so|too|quite|extremely|fully|partially|slightly)\b/i.test(s)) return s;
  if (/^(realistic|cinematic|photographic|anime|cartoon|watercolou?r|oil painting|3d|minimalist|vintage|retro|neon|cyberpunk|brighter|darker|sharper|blurrier|simplest|simpler|detailed|bigger|smaller|larger|colder|warmer|older|younger|vivid|dramatic|dark|bright)\b/i.test(s)) return s;
  return `with ${s}`;
};

/**
 * Detects the image operation for one user message.
 *
 * @param {{ message:string, hasAttachedImages?:boolean, previousImagePrompt?:string,
 *           lastTurnWasImage?:boolean }} input
 * @returns {{operation:'NONE'|'GENERATE'|'EDIT'|'UNDERSTAND', isImageRequest:boolean,
 *            isFollowUp:boolean, subject:string, signals:string[]}}
 */
const detectImageOperation = ({
  message = '',
  hasAttachedImages = false,
  previousImagePrompt = '',
  lastTurnWasImage = false,
} = {}) => {
  const q = lower(message);
  const signals = [];
  if (!q) return { operation: 'NONE', isImageRequest: false, isFollowUp: false, subject: '', signals };

  const hasVerb = VERB_RE.test(q);
  const strongStart = STRONG_START_RE.test(q);
  const hasNoun = NOUN_RE.test(q);
  const understands = UNDERSTAND_RE.test(q);
  const editRef = EDIT_REF_RE.test(q);
  const isListContinuation = LIST_CONTINUATION_RE.test(q);
  // A text artifact ("roadmap", "report", "program", "table") only defeats the
  // image path when the user did NOT also name a media artifact — "design a
  // poster for my DSA roadmap" is still a poster request.
  const isTextArtifact = TEXT_ARTIFACT_RE.test(q) && !hasNoun;
  // Stripped of pure filler so "now explain the symbolism" is read as a question.
  const qCore = lower(q.replace(LEADING_FILLER_RE, ''));
  const isQuestion =
    /\?\s*$/.test(strip(message)) ||
    QUESTION_START_RE.test(q) ||
    QUESTION_START_RE.test(qCore);
  const words = countWords(q);

  if (isListContinuation) signals.push('list-continuation');

  // 1) Conversational MODIFICATION of the image already on screen
  //    ("make it at night", "add flying cars and make it a night scene").
  //    Checked before a fresh generation, because these sentences also contain a
  //    generation verb plus an image noun ("...a night scene") and must edit the
  //    previous image instead of starting an unrelated one.
  const hasPreviousImage = Boolean(lastTurnWasImage && previousImagePrompt);
  const referencesPrevious = REFERENCE_RE.test(qCore);
  const looksLikeModification =
    MOD_START_RE.test(qCore) && (referencesPrevious || !hasNoun);
  if (
    hasPreviousImage &&
    !isQuestion &&
    !isListContinuation &&
    !editRef &&
    !isTextArtifact &&
    words <= 24 &&
    (looksLikeModification || (referencesPrevious && FOLLOW_UP_RE.test(qCore)))
  ) {
    signals.push('image-follow-up');
    return {
      operation: 'GENERATE',
      isImageRequest: true,
      isFollowUp: true,
      subject: buildFollowUpModification(message),
      signals,
    };
  }

  // 2) Explicit image request: a generation verb + an image noun, or a strong
  //    imperative generation verb ("draw a cat"). Understood as image-to-image
  //    when the user references an attached/uploaded image.
  const explicitGeneration = !isListContinuation && hasVerb && (hasNoun || strongStart) && !isTextArtifact;
  if (explicitGeneration) {
    signals.push(hasNoun ? 'image-verb+noun' : 'image-verb');
    if (editRef) signals.push('edit-reference');
    const operation = editRef || (hasAttachedImages && /\b(it|this|that|them)\b/.test(q)) ? 'EDIT' : 'GENERATE';
    return {
      operation,
      isImageRequest: true,
      isFollowUp: false,
      subject: stripGenerationWrapper(message),
      signals,
    };
  }

  // 3) Existing image + question about it -> image UNDERSTANDING (vision path),
  //    never a generated picture.
  if (
    understands &&
    (hasNoun ||
      /\b(it|this|that|them)\b/.test(q) ||
      PERCEPTION_QUESTION_RE.test(q) ||
      hasAttachedImages)
  ) {
    signals.push('image-understanding');
    return { operation: 'UNDERSTAND', isImageRequest: false, isFollowUp: false, subject: '', signals };
  }

  // 4) A bare modification with no leading verb ("more realistic", "the sky red")
  //    once an image is on screen.
  if (
    hasPreviousImage &&
    !isQuestion &&
    !isListContinuation &&
    !editRef &&
    words <= 12 &&
    (BARE_REFERENCE_RE.test(qCore) || BARE_MODIFIER_RE.test(qCore) || COLOUR_CLAUSE_RE.test(qCore))
  ) {
    signals.push('image-follow-up');
    return {
      operation: 'GENERATE',
      isImageRequest: true,
      isFollowUp: true,
      subject: buildFollowUpModification(message),
      signals,
    };
  }

  return { operation: 'NONE', isImageRequest: false, isFollowUp: false, subject: '', signals };
};

module.exports = {
  detectImageOperation,
  stripGenerationWrapper,
  buildFollowUpModification,
  VERB_RE,
  NOUN_RE,
  UNDERSTAND_RE,
  FOLLOW_UP_RE,
  TEXT_ARTIFACT_RE,
};