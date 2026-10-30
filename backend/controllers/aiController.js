// POST /api/ai/career-assistant — the unified real-AI chat endpoint used by the
// frontend chat workspace. Authentication comes from the JWT (protect middleware);
// userId is NEVER read from the request body. Documents are ownership-validated
// before their text is included in the LLM context.
//
// ONE endpoint, natural routing (no mode switch in the UI):
//   normal question            -> RAG + LLM text answer
//   "create an image of ..."    -> real image generation (services/imageService)
//   "look at this image"        -> vision answer about the attached image
// Voice input needs nothing special: the transcript is placed in the composer and
// submitted exactly like typed text, so it takes the same routing.
//
// Duplicate protection: the frontend sends a unique requestId per user message.
// The requestDedup guard makes sure ONE user message = at most ONE AI run, even
// if the same requestId arrives twice (double-click, React StrictMode, network
// retry). The dedup spans the ENTIRE handler (AI run + message persistence), so a
// duplicate can never double-persist chat history either.

const mongoose = require('mongoose');
const crypto = require('crypto');
const Chat = require('../models/Chat');
const Document = require('../models/Document');
const GeneratedImage = require('../models/GeneratedImage');
const { askCareerAssistant } = require('../services/ragService');
const requestDedup = require('../services/requestDedup');
const voiceService = require('../services/voiceService');
const imageService = require('../services/imageService');
const { detectImageOperation } = require('../services/imageIntent');
const llmService = require('../services/llmService');

// Safe development diagnostics (§12) — OFF in production, opt-out with
// PROVIDER_LOG=0. Prints provider, model, a safe user id and the requestId:
// NEVER the API key, the JWT, the prompt, the documents or Mongo credentials.
const DEV_LOG =
  process.env.NODE_ENV !== 'production' &&
  !/^(0|false|no|off)$/i.test(String(process.env.PROVIDER_LOG || ''));

/** One [AI REQUEST] block per user message, so "did ONE message cost ONE call?" is answerable from the log. */
const logAiRequest = (userId, requestId, kind = 'text') => {
  if (!DEV_LOG) return;
  try {
    const c = llmService.getConfig();
    console.log(
      `[AI REQUEST] provider=${c.provider} model=${c.model} kind=${kind}` +
        ` user=${userId || '-'}${requestId ? ` requestId=${requestId}` : ''}`
    );
  } catch {
    /* diagnostics must never break a request */
  }
};

/** One [CHAT REQUEST] trace line per REAL text-chat run (inside the dedup guard,
 *  so a duplicate requestId never re-logs). Safe fields only — requestId, the
 *  PRIMARY provider at entry, and message length — never chat content, the key,
 *  the JWT, documents or Mongo credentials. */
const logChatRequest = (requestId, message) => {
  if (!DEV_LOG) return;
  try {
    const c = llmService.getConfig();
    const messageChars = String(message || '').trim().length;
    console.log(
      `[CHAT REQUEST] requestId=${requestId || '-'} provider=${c.provider}` +
        ` messageChars=${messageChars}`
    );
  } catch {
    /* diagnostics must never break a request */
  }
};

const summarizeTitle = (message) => {
  const t = String(message || '').trim();
  if (t.length <= 48) return t;
  return `${t.slice(0, 47)}…`;
};

/**
 * Builds the shared response payload for a career-assistant run. Encapsulated so
 * requestDedup can replay the exact same body for a duplicate requestId.
 */
const buildResponse = (result, chat) => ({
  success: true,
  conversationId: chat._id,
  message: { role: 'assistant', content: result.answer, ...(result.completion ? { completion: result.completion } : {}) },
  resources: result.resources || [],
  sources: result.sources || [],
  completion: result.completion || null,
  intent: result.intent || 'GENERAL',
  retrieval: {
    mode: result.mode,
    chunkCount: result.chunkCount,
    sections: result.sections || [],
  },
});

// ---------------------------------------------------------------------------
// Conversation helpers (shared by the text and image paths)
// ---------------------------------------------------------------------------

/** Finds the caller's conversation, or prepares a new (unsaved) one. */
const resolveConversation = async ({ userId, conversationId, message }) => {
  if (conversationId) {
    const chat = await Chat.findOne({ _id: conversationId, userId });
    if (!chat) {
      const err = new Error('Conversation not found');
      err.statusCode = 404;
      err.isOperational = true; // client can tell this apart and start a new chat
      err.code = 'CONVERSATION_NOT_FOUND';
      throw err;
    }
    return chat;
  }
  return new Chat({ userId, title: summarizeTitle(message), messages: [] });
};

/** The most recent assistant message that carries a generated image. */
const findLastImageMessage = (chat) => {
  const msgs = (chat && chat.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m && m.role === 'assistant' && m.image && m.image.imageId) return { message: m, index: i };
  }
  return null;
};

// ---------------------------------------------------------------------------
// Image generation path
// ---------------------------------------------------------------------------

/**
 * Runs ONE real image generation and records it in the conversation.
 * Never routes through the text-only LLM path and never fakes a result: on a
 * provider failure the clean operational error is thrown to the error middleware.
 */
const runImageGeneration = async ({
  userId,
  chat,
  userText,
  isFollowUp = false,
  previousPrompt = '',
  referenceImage = null,
  requestId = '',
}) => {
  const prompt = imageService.buildPrompt({ text: userText, previousPrompt, isFollowUp });
  const result = await imageService.generate({
    prompt,
    text: userText,
    previousPrompt,
    isFollowUp,
    referenceImage,
    requestId,
  });

  const doc = await GeneratedImage.create({
    userId,
    conversationId: chat._id,
    userPrompt: String(userText).slice(0, 1000),
    prompt: result.prompt,
    basePrompt: result.basePrompt || '',
    revisedPrompt: result.revisedPrompt,
    isFollowUp,
    provider: result.provider,
    model: result.model,
    mimeType: result.mimeType,
    bytes: result.buffer.length,
    width: result.width,
    height: result.height,
    imageData: `data:${result.mimeType};base64,${result.buffer.toString('base64')}`,
  });

  return {
    doc,
    prompt: result.prompt,
    provider: result.provider,
    model: result.model,
    mimeType: result.mimeType,
    width: result.width,
    height: result.height,
  };
};

/** Client payload for a generated image (metadata only — bytes are fetched with the JWT). */
const imageClientJSON = (generated) => ({
  id: generated.doc._id,
  prompt: generated.prompt,
  provider: generated.provider,
  model: generated.model,
  mimeType: generated.mimeType,
  width: generated.width || generated.doc.width,
  height: generated.height || generated.doc.height,
  isFollowUp: Boolean(generated.doc.isFollowUp),
});

const handleCareerAssistant = async ({
  req,
  userId,
  message,
  conversationId,
  documentIds,
  forceImage = false,
  onDelta,
  abortSignal,
}) => {
  // ---- Conversation (created or continued; always owned) ----
  // A brand-new chat is only persisted AFTER the AI succeeds, so a missing
  // AI key never leaves an orphan/empty conversation behind.
  const chat = await resolveConversation({ userId, conversationId, message });

  // ---- Ownership-validated documents ----
  let validIds = (Array.isArray(documentIds) ? documentIds : [])
    .filter((id) => mongoose.isValidObjectId(id));

  // Follow-up continuity: when this message attaches nothing new but earlier
  // user messages in the SAME conversation attached files/images, keep using the
  // most recent set. The user should not have to re-upload an image or document
  // for every follow-up ("look at this" -> "what is wrong?" -> "how can I fix it?").
  if (!validIds.length && chat && Array.isArray(chat.messages) && chat.messages.length) {
    for (let i = chat.messages.length - 1; i >= 0; i -= 1) {
      const prev = chat.messages[i];
      if (prev && prev.role === 'user' && Array.isArray(prev.documentIds) && prev.documentIds.length) {
        validIds = prev.documentIds.filter((id) => mongoose.isValidObjectId(id));
        if (validIds.length) break;
      }
    }
  }

  const docs = validIds.length
    ? await Document.find({ _id: { $in: validIds }, userId }).select('+text +imageData')
    : [];

  // Vision-ready image attachments (real pixels, ownership-validated above).
  // Data URLs come from the Document.imageData field; anything without stored
  // pixels is left to the text path only.
  const attachedImages = docs
    .filter((d) => d.imageData && typeof d.imageData === 'string')
    .map((d) => ({ fileName: d.fileName, dataUrl: d.imageData }));

  // ---- Image routing (natural language, no command needed) ----------------
  // Image GENERATION and image UNDERSTANDING are different operations, so the
  // detector distinguishes them before anything is called: a generation request
  // never goes through the text-only answer path, and "look at this image"
  // never produces a generated picture.
  const lastImage = findLastImageMessage(chat);
  // Follow-ups merge onto the ORIGINAL request (basePrompt) when available, so
  // the quality suffix is never duplicated and nothing is lost.
  const previousImagePrompt = lastImage
    ? String(lastImage.message.image.basePrompt || lastImage.message.image.prompt || '')
    : '';
  const imageOp = detectImageOperation({
    message: String(message),
    hasAttachedImages: attachedImages.length > 0,
    previousImagePrompt,
    lastTurnWasImage: Boolean(lastImage),
  });

  const wantsImage = forceImage || imageOp.operation === 'GENERATE' || imageOp.operation === 'EDIT';

  if (wantsImage) {
    const isFollowUp = !forceImage && imageOp.isFollowUp && Boolean(previousImagePrompt);
    // Image-to-image uses the newest attached image, but only on providers that
    // really support a reference image (imageService enforces the capability).
    const referenceImage = imageOp.operation === 'EDIT' ? attachedImages[0] || null : null;
    logAiRequest(userId, req.requestId || '', 'image');

    const generated = await runImageGeneration({
      userId,
      chat,
      userText: String(message),
      isFollowUp,
      previousPrompt: isFollowUp ? previousImagePrompt : '',
      referenceImage,
      requestId: req.requestId || '',
    });

    const imagePayload = imageClientJSON(generated);
    const caption = isFollowUp
      ? 'Here is the updated image based on your previous one.'
      : 'Here is the image I created from your request.';

    chat.messages.push({
      role: 'user',
      content: String(message),
      ...(validIds.length ? { documentIds: validIds } : {}),
    });
    chat.messages.push({
      role: 'assistant',
      content: caption,
      image: {
        imageId: generated.doc._id,
        prompt: generated.prompt,
        basePrompt: generated.doc.basePrompt || generated.prompt,
        provider: generated.provider,
        model: generated.model,
        isFollowUp,
      },
    });
    await chat.save();

    return {
      success: true,
      conversationId: chat._id,
      message: { role: 'assistant', content: caption, image: imagePayload },
      image: imagePayload,
      resources: [],
      sources: [],
      intent: 'IMAGE_GENERATION',
      imageOperation: imageOp.operation,
      isFollowUp,
    };
  }

  // Verbatim text from the explicitly attached documents (real extraction or an
  // honest "pending" note — never invented analysis).
  const extraDocuments = docs.length
    ? docs
        .map((d) => {
          const body = d.status === 'ready' && d.text ? d.text : `(no extracted text — ${d.processingNote || 'document not extracted'})`;
          return `[file: ${d.fileName}]\n${body}`;
        })
        .join('\n\n')
        .slice(0, 16000)
    : null;

  // ---- Real LLM call via RAG ----
  // Wider history window (~15 turns) so personal facts and previous lists stay
  // in context ("Karri is my friend" -> later "who is Karri?"; "give me 10
  // LeetCode problems" -> "make it 20"). ragService trims per message, so the
  // input budget stays bounded for free-tier rate limits.
  const history = chat.messages.slice(-30);
  logChatRequest(req.requestId || '', message);
  logAiRequest(userId, req.requestId || '', 'text');
  const result = await askCareerAssistant({
    userId,
    userName: (req.userRecord && req.userRecord.name) || '',
    question: String(message),
    history: history.map((m) => ({ role: m.role === 'assistant' ? 'ai' : 'user', content: m.content })),
    extraDocuments,
    attachedImages,
    requestId: req.requestId || '',
    // The authenticated user's saved chat preferences (response style, preferred
    // language). These shape the answer but never override an explicit request.
    preferences: (req.userRecord && req.userRecord.settings && req.userRecord.settings.chat) || {},
    onDelta,
    abortSignal,
  });

  // ---- Persist ----
  chat.messages.push({
    role: 'user',
    content: String(message),
    ...(validIds.length ? { documentIds: validIds } : {}),
  });
  chat.messages.push({
    role: 'assistant',
    content: result.answer,
    ...(result.completion ? { completion: result.completion } : {}),
    ...(result.resources && result.resources.length ? { resources: result.resources } : {}),
    ...(result.sources && result.sources.length ? { sources: result.sources } : {}),
  });
  await chat.save();

  return buildResponse(result, chat);
};

// @desc   Chat with the real AI career assistant (RAG + LLM + image generation)
// @route  POST /api/ai/career-assistant  (protected)
const careerAssistant = async (req, res) => {
  const { message, conversationId, documentIds, requestId } = req.body || {};

  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, message: 'Message is required' });
  }

  const userId = req.user.id; // from the verified JWT — never trust a body userId
  const rid = String(requestId || '').trim() || crypto.randomUUID();
  req.requestId = rid;

  const { deduped, payload } = await requestDedup.runOnce(`${userId}:${rid}`, () =>
    handleCareerAssistant({ req, userId, message: String(message), conversationId, documentIds })
  );

  res.json({ ...payload, requestId: rid, deduped: Boolean(deduped) });
};

const sseEvent = (res, event, data) => {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  return true;
};

const persistPartialStream = async ({ userId, message, conversationId, content, requestId, stopped }) => {
  if (!String(content || '').trim()) return null;
  const chat = await resolveConversation({ userId, conversationId, message });
  chat.messages.push({ role: 'user', content: String(message), requestId });
  chat.messages.push({
    role: 'assistant',
    content: String(content),
    completion: {
      complete: false,
      kind: 'none',
      reason: 'The response ended before completion.',
      stopped,
      providerTruncated: true,
    },
    requestId,
  });
  await chat.save();
  return buildResponse({
    answer: String(content),
    completion: chat.messages[chat.messages.length - 1].completion,
    resources: [],
    sources: [],
    intent: 'GENERAL',
    mode: 'stream',
    chunkCount: 0,
    sections: [],
  }, chat);
};

// Additive streaming endpoint. The existing JSON endpoint remains unchanged.
// Events are JSON-encoded so clients can evolve without parsing provider output:
// start {requestId}, delta {text}, complete {response,requestId,deduped},
// error {code,message,retryable}, cancelled {response}.
const careerAssistantStream = async (req, res) => {
  const { message, conversationId, documentIds, requestId } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, code: 'MESSAGE_REQUIRED', message: 'Message is required' });
  }

  const userId = req.user.id;
  const rid = String(requestId || '').trim() || crypto.randomUUID();
  req.requestId = rid;
  const abortController = new AbortController();
  let disconnected = false;
  let partial = '';
  const onClose = () => {
    if (!res.writableEnded) {
      disconnected = true;
      abortController.abort();
    }
  };
  res.once('close', onClose);

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  sseEvent(res, 'start', { requestId: rid });

  try {
    const result = await requestDedup.runOnce(`${userId}:${rid}`, () =>
      handleCareerAssistant({
        req,
        userId,
        message: String(message),
        conversationId,
        documentIds,
        onDelta: async (text) => {
          partial += String(text || '');
          if (!disconnected) sseEvent(res, 'delta', { text: String(text || '') });
        },
        abortSignal: abortController.signal,
      })
    );
    const payload = { ...result.payload, requestId: rid, deduped: Boolean(result.deduped) };
    if (!disconnected) {
      if (payload.message?.content && payload.message.content !== partial) {
        sseEvent(res, 'replace', { text: payload.message.content });
      }
      sseEvent(res, 'complete', { response: payload, requestId: rid, deduped: Boolean(result.deduped) });
      res.end();
    }
  } catch (err) {
    if (partial && !disconnected) {
      try {
        const partialPayload = await persistPartialStream({
          userId,
          message,
          conversationId,
          content: partial,
          requestId: rid,
          stopped: abortController.signal.aborted ? 'cancelled' : 'stream_error',
        });
        if (partialPayload) sseEvent(res, 'replace', { text: partialPayload.message.content });
      } catch (persistErr) {
        console.warn(`[AI] streaming partial persistence failed code=${persistErr.code || 'error'}`);
      }
    }
    if (!disconnected) {
      sseEvent(res, abortController.signal.aborted ? 'cancelled' : 'error', {
        code: String(err?.code || 'AI_STREAM_ERROR'),
        message: abortController.signal.aborted
          ? 'Generation stopped. The partial answer was preserved.'
          : (err?.isOperational ? String(err.message) : 'The AI response could not be completed.'),
        retryable: err?.retryable !== false,
      });
      res.end();
    }
  } finally {
    res.removeListener('close', onClose);
  }
};

// @desc   Dedicated real image generation. Used by the composer/regenerate
//         actions and by any client that wants an image without chat routing.
// @route  POST /api/ai/generate-image  (protected, JSON { prompt, conversationId })
const generateImage = async (req, res) => {
  const { prompt, conversationId, documentIds, requestId } = req.body || {};

  if (!prompt || !String(prompt).trim()) {
    return res.status(400).json({ success: false, code: 'IMAGE_EMPTY_PROMPT', message: 'An image prompt is required' });
  }

  const userId = req.user.id;
  const rid = String(requestId || '').trim() || crypto.randomUUID();
  req.requestId = rid;

  // forceImage: an explicit image request always generates an image — it never
  // degrades into a text-only answer.
  const { deduped, payload } = await requestDedup.runOnce(`image:${userId}:${rid}`, () =>
    handleCareerAssistant({
      req,
      userId,
      message: String(prompt),
      conversationId,
      documentIds,
      forceImage: true,
    })
  );

  res.json({ ...payload, requestId: rid, deduped: Boolean(deduped) });
};

// @desc   Stream the real bytes of one generated image the caller owns.
//         The chat never embeds image bytes in a page payload; the browser
//         fetches them with the same JWT used for everything else.
// @route  GET /api/ai/images/:id  (protected, ownership-checked)
const getGeneratedImage = async (req, res) => {
  if (!mongoose.isValidObjectId(String(req.params.id))) {
    return res.status(404).json({ success: false, message: 'Image not found' });
  }
  const doc = await GeneratedImage.findOne({ _id: req.params.id, userId: req.user.id }).select('+imageData');
  if (!doc) return res.status(404).json({ success: false, message: 'Image not found' });

  const comma = doc.imageData.indexOf(',');
  const meta = comma > 0 ? doc.imageData.slice(0, comma) : '';
  const mime = /^data:([^;]+);/.test(meta) ? meta.match(/^data:([^;]+);/)[1] : doc.mimeType || 'image/png';
  const bytes = Buffer.from(doc.imageData.slice(comma + 1), 'base64');
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'private, max-age=86400');
  res.send(bytes);
};

// @desc   Regenerate the last assistant answer in a conversation. Re-runs the
//         same last user question against the RAG pipeline and REPLACES the
//         previous answer (same UX as ChatGPT's "Regenerate response"). When the
//         last answer was a generated IMAGE, a fresh image is generated from the
//         same prompt instead of calling the text LLM.
// @route  POST /api/ai/career-assistant/regenerate  (protected)
const regenerateMessage = async (req, res) => {
  const { conversationId, requestId } = req.body || {};

  if (!conversationId || !mongoose.isValidObjectId(String(conversationId))) {
    return res.status(400).json({ success: false, message: 'A valid conversationId is required' });
  }

  const chat = await Chat.findOne({ _id: conversationId, userId: req.user.id });
  if (!chat) return res.status(404).json({ success: false, message: 'Conversation not found' });

  const msgs = chat.messages || [];
  const lastIdx = msgs.length - 1;
  // Regenerate only makes sense when the latest exchange is user -> assistant.
  if (lastIdx < 1 || msgs[lastIdx].role !== 'assistant' || msgs[lastIdx - 1].role !== 'user') {
    return res.status(400).json({ success: false, message: 'Nothing to regenerate yet.' });
  }

  const question = String(msgs[lastIdx - 1].content || '');
  const rid = String(requestId || '').trim() || crypto.randomUUID();
  req.requestId = rid;

  // ---- Image regeneration: same prompt, brand-new image ---------------------
  if (msgs[lastIdx].image && msgs[lastIdx].image.imageId) {
    const { deduped, payload } = await requestDedup.runOnce(`regen-image:${req.user.id}:${rid}`, async () => {
      const previousImageId = msgs[lastIdx].image.imageId;
      // Reuse the SUBJECT prompt (no quality suffix) so regenerating produces the
      // same picture request and leaves the follow-up merge base clean. Feeding
      // the stored `prompt` back in would append the quality suffix a second
      // time and poison every later follow-up.
      const prompt = String(msgs[lastIdx].image.basePrompt || question || msgs[lastIdx].image.prompt || '');

      const generated = await runImageGeneration({
        userId: req.user.id,
        chat,
        userText: prompt,
        isFollowUp: false,
        previousPrompt: '',
        requestId: rid,
      });

      msgs[lastIdx] = {
        role: 'assistant',
        content: 'Here is a freshly generated version of that image.',
        image: {
          imageId: generated.doc._id,
          prompt: generated.prompt,
          basePrompt: generated.doc.basePrompt || generated.prompt,
          provider: generated.provider,
          model: generated.model,
          isFollowUp: false,
        },
      };
      await chat.save();
      // The replaced image is no longer referenced by the conversation.
      if (mongoose.isValidObjectId(String(previousImageId))) {
        await GeneratedImage.deleteOne({ _id: previousImageId, userId: req.user.id }).catch(() => {});
      }

      const imagePayload = imageClientJSON(generated);
      return {
        success: true,
        conversationId: chat._id,
        message: { role: 'assistant', content: msgs[lastIdx].content, image: imagePayload },
        image: imagePayload,
        resources: [],
        sources: [],
        intent: 'IMAGE_GENERATION',
        imageOperation: 'GENERATE',
        isFollowUp: false,
      };
    });

    return res.json({ ...payload, requestId: rid, deduped: Boolean(deduped) });
  }

  const history = msgs
    .slice(0, lastIdx - 1)
    .map((m) => ({ role: m.role === 'assistant' ? 'ai' : 'user', content: m.content }));

  const { deduped, payload } = await requestDedup.runOnce(`regen:${req.user.id}:${rid}`, async () => {
    const result = await askCareerAssistant({
      userId: req.user.id,
      userName: (req.userRecord && req.userRecord.name) || '',
      question,
      history,
      requestId: rid,
      preferences: (req.userRecord && req.userRecord.settings && req.userRecord.settings.chat) || {},
    });

    // Replace the old answer in memory first; only save after the LLM succeeded,
    // so a provider failure leaves the previous answer untouched.
    msgs[lastIdx] = {
      role: 'assistant',
      content: result.answer,
      ...(result.completion ? { completion: result.completion } : {}),
      ...(result.resources && result.resources.length ? { resources: result.resources } : {}),
      ...(result.sources && result.sources.length ? { sources: result.sources } : {}),
    };
    await chat.save();
    return buildResponse(result, chat);
  });

  res.json({ ...payload, requestId: rid, deduped: Boolean(deduped) });
};

// @desc   Speech-to-text. Transcribes the uploaded audio (Groq Whisper) and
//         returns the transcript so the frontend can fill the normal chat input.
//         The transcript is NEVER auto-sent: it lands in the composer, the user
//         edits it if they want and presses Send like any other message.
// @route  POST /api/ai/transcribe  (protected, multipart 'audio')
const transcribeAudio = async (req, res) => {
  const file = req.file || null;
  if (!file) return res.status(400).json({ success: false, message: 'No audio file uploaded' });

  const { transcript } = await voiceService.transcribe({
    buffer: file.buffer,
    filename: file.originalname,
    mimeType: file.mimetype,
    language: String(req.body.language || '').trim(),
  });

  res.json({ success: true, transcript, model: voiceService.getConfig().sttModel });
};

// @desc   Text-to-speech. Converts a text (the AI answer) into mp3 bytes when a
//         TTS model is configured; otherwise a clean 503 (the frontend then
//         falls back to the browser speechSynthesis API — the user still hears
//         the answer, honestly, with no fake audio ever generated).
// @route  POST /api/ai/speech  (protected, JSON { text })
const speech = async (req, res) => {
  const { text } = req.body || {};
  const { audio, contentType } = await voiceService.speak({ text });
  res.set('Content-Type', contentType);
  res.set('Cache-Control', 'no-store');
  res.send(audio);
};

module.exports = {
  careerAssistant,
  careerAssistantStream,
  regenerateMessage,
  generateImage,
  getGeneratedImage,
  transcribeAudio,
  speech,
};