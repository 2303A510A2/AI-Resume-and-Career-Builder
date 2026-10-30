import api, { getApiBaseUrl } from './api';
import { getAuthToken } from './authService';

// Real AI chat through the unified backend endpoint (JWT-authenticated).
// conversationId continues an existing conversation; documentIds attach owned
// documents whose extracted text feeds the LLM context.
//
// requestId: a unique id per user message. The backend deduplicates on it, so a
// double-click / React re-render / network retry can never fire a second AI call
// or double the chat history. Generate one per submit with newRequestId().
export const sendChatMessage = (message, chatId, documentIds = [], requestId) =>
  api.post('/ai/career-assistant', {
    message,
    conversationId: chatId,
    documentIds,
    requestId,
  });

// Additive POST-SSE chat path. The stable JSON endpoint remains the fallback for
// legacy clients and non-streaming flows.
export const streamChatMessage = async (
  message,
  chatId,
  documentIds = [],
  requestId,
  { signal, onDelta, onReplace } = {},
) => {
  const token = getAuthToken();
  const response = await fetch(`${getApiBaseUrl()}/ai/career-assistant/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      message,
      conversationId: chatId,
      documentIds,
      requestId,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.message || 'The streaming request failed.');
    error.response = { status: response.status, data: body };
    throw error;
  }
  if (!response.body) throw new Error('The browser does not support streaming responses.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = null;
  const consume = (block) => {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    if (event === 'delta') onDelta?.(payload.text || '');
    else if (event === 'replace') onReplace?.(payload.text || '');
    else if (event === 'complete') completed = payload.response;
    else if (event === 'error' || event === 'cancelled') {
      const error = new Error(payload.message || 'The AI stream ended before completion.');
      error.code = payload.code || (event === 'cancelled' ? 'AI_STREAM_CANCELLED' : 'AI_STREAM_ERROR');
      error.retryable = payload.retryable !== false;
      error.partial = true;
      throw error;
    }
  };

  while (true) {
    const part = await reader.read();
    if (part.done) break;
    buffer += decoder.decode(part.value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    blocks.forEach(consume);
  }
  if (buffer.trim()) consume(buffer);
  if (!completed) throw new Error('The AI stream ended without a complete response.');
  return completed;
};

// Regenerate the last AI answer for an existing conversation (same user question,
// re-run through the RAG pipeline; the previous answer is replaced).
export const regenerateMessage = (conversationId, requestId) =>
  api.post('/ai/career-assistant/regenerate', { conversationId, requestId });

// Conversation history. Paginated server-side (newest activity first): the
// sidebar loads the first page, then "See more" appends the next pages without
// ever re-downloading everything.
export const listChats = (page = 1, limit = 10) => api.get('/chat', { params: { page, limit } });

// Search ONLY the authenticated user's conversations by title or message
// content. Paginated like the normal list so a big history never loads at once.
export const searchChats = (query, page = 1, limit = 10) =>
  api.get('/chat/search', { params: { q: query, page, limit } });

export const getChat = (chatId) => api.get(`/chat/${chatId}`);
export const deleteChat = (chatId) => api.delete(`/chat/${chatId}`);
export const sendMessageToChat = (chatId, message, documentIds = [], requestId) =>
  api.post(`/chat/${chatId}/messages`, { message, documentIds, requestId });

// Unique id for one user message (used for backend dedup + stale-response guard).
export const newRequestId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `rid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

// ---------------------------------------------------------------------------
// Image generation
//
// Image generation happens ONLY on the backend (POST /api/ai/generate-image), so
// no provider key or provider URL ever reaches the browser. The normal chat
// endpoint routes image requests itself — the frontend never has to guess which
// requests are images, and a text question can never be turned into a picture.
//
// Images are stored server-side and referenced from the chat message by id only;
// the bytes are never inlined in the chat payload or in conversation history.

// Fetches the real image bytes for a generated image the caller owns, as a Blob.
// Authenticated by the shared axios instance; ownership is checked server-side.
export const fetchGeneratedImage = async (imageId) => {
  const res = await api.get(`/ai/images/${imageId}`, { responseType: 'blob' });
  return res.data; // Blob
};

// Preserves the generated image's real proportions in the DOM instead of
// squashing it into a fixed box.
export const imageAspectStyle = (image) => {
  const w = Number(image?.width) || 0;
  const h = Number(image?.height) || 0;
  return w > 0 && h > 0 ? { aspectRatio: `${w} / ${h}` } : {};
};

// PRESENTATION ONLY. The backend owns image routing (it is the single source of
// truth), so this never decides anything functional — it only chooses which
// honest loading label to show ("Creating your image…" vs "AI is thinking…").
// Kept deliberately coarse so a false positive costs nothing but a label.
export const looksLikeImageRequest = (message) => {
  const q = String(message || '').toLowerCase();
  const verb = /\b(create|generate|make|draw|paint|render|design|illustrate|visuali[sz]e|sketch|depict)\b/.test(q);
  const noun = /\b(image|picture|photo|artwork|painting|drawing|sketch|illustration|poster|logo|banner|wallpaper|avatar|icon|mural|wallpaper|scene|portrait|landscape)\b/.test(q);
  if (verb && noun) return true;
  // A modification of the image already on screen ("make it at night").
  return /\b(it|this|that)\b[^.?!]{0,30}\b(more realistic|at night|in the rain|upside down|as a painting|in anime style)\b/.test(q);
};