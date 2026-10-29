const mongoose = require('mongoose');
const crypto = require('crypto');
const Chat = require('../models/Chat');
const Document = require('../models/Document');
const { askCareerAssistant } = require('../services/ragService');
const requestDedup = require('../services/requestDedup');

const summarizeTitle = (message) => {
  const t = String(message || '').trim();
  if (t.length <= 48) return t;
  return `${t.slice(0, 47)}…`;
};

// A conversation opened with a greeting ("hi", "hello", "good morning") must not
// name the sidebar entry "hi" forever. The title is retitled from the first
// substantive question as soon as one arrives (see retitleIfTrivial below).
const TRIVIAL_TITLE_RE =
  /^(?:hi+|hii+|hello+|heyy+|hey+|yo+|hola|namaste|salam|assalam|good\s+(?:morning|afternoon|evening|night)|thanks?|thank\s+you|ok|okay|yes|no|\?|!)[!.,\s]*$/i;
const isTrivialTitle = (title) => {
  const s = String(title || '').trim();
  if (!s) return true;
  if (s.length <= 2) return true;
  return TRIVIAL_TITLE_RE.test(s);
};

// After a new user message was pushed, give the conversation a real title when
// it is still named by a greeting or the empty default. Stays "hi" until the
// user actually asks something substantive, then never changes back.
const retitleIfTrivial = (chat) => {
  const userTurns = (chat.messages || []).filter((m) => m.role === 'user');
  if (userTurns.length >= 2 && isTrivialTitle(chat.title)) {
    chat.title = summarizeTitle(String(userTurns[userTurns.length - 1].content));
  }
};

// Read page/limit from the query string with sane bounds (1..50 per page).
const pageParams = (req) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  return { page, limit, skip: (page - 1) * limit };
};

// The sidebar shape: metadata only, never the full message bodies. Messages are
// fetched separately (GET /api/chat/:id) so the history list stays light.
const mapChat = (c) => ({
  _id: c._id,
  title: c.title,
  messageCount: c.messages.length,
  updatedAt: c.updatedAt,
  createdAt: c.createdAt,
});

// Shared response shape inside the legacy /api/chat route family. The reply text
// stays under `reply` (backward compatible) while resources/sources detail is
// added alongside.
const buildResponse = (result, chatId) => ({
  success: true,
  chatId,
  reply: result.answer,
  resources: result.resources || [],
  sources: result.sources || [],
  completion: result.completion || null,
  intent: result.intent || 'GENERAL',
  meta: { retrieval: result.mode, chunks: result.chunkCount, sections: result.sections || [] },
});

// @desc   Send a message. Creates a new chat session or continues an existing one.
// @route  POST /api/chat
const sendMessage = async (req, res) => {
  const { message, chatId, requestId } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, message: 'Message is required' });
  }

  // No hard gate on resume+JD: general questions (Java, RAG, interviews, DSA…)
  // must work for everyone. The RAG prompt honestly states when no knowledge
  // base exists, and RAG context is used automatically once documents exist.

  const userId = req.user.id;
  const rid = String(requestId || '').trim() || crypto.randomUUID();

  const { deduped, payload } = await requestDedup.runOnce(`${userId}:${rid}`, async () => {
    let chat = null;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, userId: req.user.id });
      if (!chat) {
        const err = new Error('Conversation not found');
        err.statusCode = 404;
        throw err;
      }
    } else {
      chat = await Chat.create({ userId: req.user.id, title: summarizeTitle(message), messages: [] });
    }

    const history = chat.messages.slice(-8);

    const result = await askCareerAssistant({
      userId: req.user.id,
      userName: (req.userRecord && req.userRecord.name) || '',
      question: String(message),
      history: history.map((m) => ({ role: m.role === 'assistant' ? 'ai' : 'user', content: m.content })),
    });

    chat.messages.push({ role: 'user', content: String(message) });
    chat.messages.push({
      role: 'assistant',
      content: result.answer,
      ...(result.completion ? { completion: result.completion } : {}),
      ...(result.resources && result.resources.length ? { resources: result.resources } : {}),
      ...(result.sources && result.sources.length ? { sources: result.sources } : {}),
    });
    retitleIfTrivial(chat);
    await chat.save();

    return buildResponse(result, chat._id);
  });

  res.json({ ...payload, requestId: rid, deduped: Boolean(deduped) });
};

// @desc   List the user's conversations (paginated, newest activity first)
// @route  GET /api/chat?page=1&limit=10
const listChats = async (req, res) => {
  const { page, limit, skip } = pageParams(req);
  const filter = { userId: req.user.id };
  const total = await Chat.countDocuments(filter);
  const chats = await Chat.find(filter)
    .sort({ updatedAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .select('title messages updatedAt createdAt')
    .lean();

  res.json({
    success: true,
    page,
    limit,
    total,
    hasMore: skip + chats.length < total,
    chats: chats.map(mapChat),
  });
};

// @desc   Search the user's own conversations by title or message content
// @route  GET /api/chat/search?q=java&page=1&limit=10
// The query is always scoped to the authenticated user and matched literally
// (regex metacharacters are escaped), so searching can never read another
// user's history and a "?" typed by the user is not parsed as a wildcard.
const searchChats = async (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (!raw) return res.status(400).json({ success: false, message: 'Search query q is required' });
  const { page, limit, skip } = pageParams(req);
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const filter = {
    userId: req.user.id,
    $or: [
      { title: { $regex: escaped, $options: 'i' } },
      { 'messages.content': { $regex: escaped, $options: 'i' } },
    ],
  };
  const total = await Chat.countDocuments(filter);
  const chats = await Chat.find(filter)
    .sort({ updatedAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .select('title messages updatedAt createdAt')
    .lean();

  res.json({
    success: true,
    query: raw,
    page,
    limit,
    total,
    hasMore: skip + chats.length < total,
    chats: chats.map(mapChat),
  });
};

// @desc   Get a single conversation (owner only)
// @route  GET /api/chat/:id
const getChat = async (req, res) => {
  const chat = await Chat.findOne({ _id: req.params.id, userId: req.user.id });
  if (!chat) return res.status(404).json({ success: false, message: 'Conversation not found' });
  res.json({ success: true, chat });
};

// @desc   Delete a conversation (owner only)
// @route  DELETE /api/chat/:id
const deleteChat = async (req, res) => {
  const chat = await Chat.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
  if (!chat) return res.status(404).json({ success: false, message: 'Conversation not found' });
  res.json({ success: true, message: 'Conversation deleted' });
};

// @desc   Continue an existing conversation with a new message
// @route  POST /api/chat/:id/messages
const addMessage = async (req, res) => {
  const { message, documentIds, requestId } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, message: 'Message is required' });
  }

  const userId = req.user.id;
  const rid = String(requestId || '').trim() || crypto.randomUUID();

  const { deduped, payload } = await requestDedup.runOnce(`${userId}:${rid}`, async () => {
    const chat = await Chat.findOne({ _id: req.params.id, userId: req.user.id });
    if (!chat) {
      const err = new Error('Conversation not found');
      err.statusCode = 404;
      throw err;
    }

    const validIds = (Array.isArray(documentIds) ? documentIds : []).filter((id) => mongoose.isValidObjectId(id));
    const docs = validIds.length ? await Document.find({ _id: { $in: validIds }, userId: req.user.id }).select('+text') : [];
    const extraDocuments = docs.length
      ? docs
          .map((d) => {
            const body = d.status === 'ready' && d.text ? d.text : `(no extracted text — ${d.processingNote || 'document not extracted'})`;
            return `[file: ${d.fileName}]\n${body}`;
          })
          .join('\n\n')
          .slice(0, 16000)
      : null;

    const history = chat.messages.slice(-8);
    const result = await askCareerAssistant({
      userId: req.user.id,
      userName: (req.userRecord && req.userRecord.name) || '',
      question: String(message),
      history: history.map((m) => ({ role: m.role === 'assistant' ? 'ai' : 'user', content: m.content })),
      extraDocuments,
    });

    chat.messages.push({ role: 'user', content: String(message) });
    chat.messages.push({
      role: 'assistant',
      content: result.answer,
      ...(result.completion ? { completion: result.completion } : {}),
      ...(result.resources && result.resources.length ? { resources: result.resources } : {}),
      ...(result.sources && result.sources.length ? { sources: result.sources } : {}),
    });
    retitleIfTrivial(chat);
    await chat.save();

    return buildResponse(result, chat._id);
  });

  res.json({ ...payload, requestId: rid, deduped: Boolean(deduped) });
};

module.exports = {
  sendMessage,
  listChats,
  getChat,
  deleteChat,
  addMessage,
  searchChats,
  // Pure helpers exported for the offline chatHistoryTest suite.
  isTrivialTitle,
  retitleIfTrivial,
  pageParams,
  mapChat,
  summarizeTitle,
};