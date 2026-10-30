import { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Send, Trash2, Plus, MessageSquare, Loader2, Sparkles, UploadCloud, Briefcase, Paperclip, X, Mic, Square, Search, ChevronDown, Menu } from 'lucide-react';
import { streamChatMessage, sendChatMessage, listChats, getChat, deleteChat, regenerateMessage, newRequestId, looksLikeImageRequest, searchChats } from '../services/chatService';
import { getAuthToken, inspectToken, clearToken } from '../services/authService';
import { uploadChatFiles, classifyFileName, ACCEPTED_FILE_TYPES } from '../services/fileService';
import { getResume, getJob } from '../services/resumeService';
import { transcribeAudio, mediaRecorderSupported, maySearchWeb, speechRecognitionSupported } from '../services/voiceService';
import { getHealthResilient, getHealthSameOrigin } from '../services/healthService';
import { API_BASE_NOT_CONFIGURED } from '../services/apiBase';
import { createSpeechCapture } from '../services/speechRecognition';

// Shown only when the recogniser genuinely heard no words at all.
const NO_SPEECH_MESSAGE = 'No speech detected. Tap the microphone and speak while it is on.';
import ChatMessage, { WelcomeBubble, ImageThumb } from '../components/ChatMessage.jsx';
import BackendStatus from '../components/BackendStatus.jsx';
import { useAuth } from '../hooks/useAuth';

const SUGGESTIONS = [
  'What skills am I missing?',
  'Give me 10 LeetCode problems',
  'What is Java?',
  'Explain polymorphism with an example',
  'Give me websites to learn Java',
  'Give me the latest AI information',
  'Give me SQL practice websites',
  'Prepare me for this job',
  'Give me Java interview questions',
  'How do I negotiate a salary offer?',
];

// Clean user-facing message for a failed AI request. Never exposes provider
// URLs, keys, HTTP statuses, or stack traces. Honest product strings only.
//
// Classification is strictly evidence-based so a normal AI failure can NEVER be
// shown as a session or backend problem:
//   - no response object at all (real network failure) -> backend offline, and
//     ONLY after TWO independent health probes (the API origin AND this page's
//     own origin) both fail to produce any HTTP response
//   - a genuine 401 with the backend's reason code   -> session expired
//   - 429                                            -> AI rate limit
//   - 500 / 502 / 503 / 504                          -> AI service error
// `signOut` is true ONLY for a token the backend actually rejected.
// `retryable` is false ONLY when re-sending cannot possibly work right now —
// a spent DAILY provider quota, a dead session, or no key configured. Every
// transient failure (per-minute 429, 5xx, network) stays retryable, and the
// Retry button is rendered only when `retryable !== false` (§11).
//
// ASYNC on purpose: a browser reports a CORS rejection, a reset connection and a
// refused connection with the SAME opaque `ERR_NETWORK` and no response object, so
// the error alone can never justify the words "Backend server is offline". ONE
// health re-check is not sufficient either, because it uses the same API origin
// and can be blocked for exactly the same reason — two probes that agree only
// because they share one cause. A failed AI request is never on its own evidence
// that the API is down.
const friendlyError = async (err) => {
  const status = err?.response?.status;
  const code = String(err?.response?.data?.code || '').toUpperCase();

  // The build has no backend URL configured at all (production without
  // VITE_API_URL / window.APP_API_BASE). The request never left the page, so
  // this is not a live backend verdict — it is a configuration gap with its own
  // actionable message. It can never be confused with a transport failure.
  if (err?.code === API_BASE_NOT_CONFIGURED) {
    return {
      text:
        'This build has no backend API URL configured.\n\n' +
        'The deployed frontend cannot reach any backend. Set VITE_API_URL to the deployed API ' +
        'URL (e.g. https://<your-backend>.onrender.com/api) in the hosting dashboard and rebuild, ' +
        'or set window.APP_API_BASE on this page and press Retry Connection.',
      signOut: false,
      retryable: true,
    };
  }

  // Genuinely unreachable: the request never produced an HTTP response.
  // This REQUIRES the absence of a response, so 401 / 429 / 500 / 502 / 503 and
  // every Groq/provider error (they all arrive as real HTTP responses) can never
  // be reported as an offline backend.
  const TRANSPORT_FAILURES = [
    'ERR_NETWORK',      // axios: no response (refused, DNS, CORS-blocked, reset)
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPIPE',
  ];
  if (!err?.response && TRANSPORT_FAILURES.includes(String(err?.code || '').toUpperCase())) {
    // TWO INDEPENDENT PROBES, never one.
    //
    // The first probe uses the same API origin as the failed request, so it is
    // subject to the same rules and can be blocked for the same reason. The
    // second is same-origin and therefore immune to CORS. Agreeing single-path
    // probes are how a healthy backend was reported as offline: both were
    // blocked by the browser, so both "failed" and the app believed them.
    const [direct, sameOrigin] = await Promise.all([
      getHealthResilient(),
      getHealthSameOrigin(),
    ]);
    if (direct.reachable || sameOrigin.reachable) {
      // The API answered on at least one path => it is ONLINE. Only this
      // browser's cross-origin call was blocked.
      return {
        text: 'Your browser blocked this request before it reached the API, but the backend is online. If you are developing locally, open the app on http://localhost:5173. On a deployed site, check that the backend allows this site\'s origin via CLIENT_URL (and FRONTEND_URL) on the backend host.',
        signOut: false,
      };
    }
    // Both probes failed, on two different paths: genuinely unreachable.
    return { text: 'Backend server is offline. Start it in backend/ (npm run dev), then retry.', signOut: false };
  }
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || err?.code === 'ERR_CANCELED') {
    return {
      text: 'The AI took longer than the client is willing to wait (this browser stopped waiting after 3.5 minutes). Very large requests can take a while — please try again, or ask for a smaller amount.',
      signOut: false,
    };
  }

  if (status === 401) {
    if (code === 'TOKEN_EXPIRED' || code === 'TOKEN_INVALID' || code === 'ACCOUNT_NOT_FOUND') {
      return { text: 'Your session has expired. Please log in again.', signOut: true, retryable: false };
    }
    if (code === 'TOKEN_MISSING') {
      return { text: 'You are not signed in. Please log in again to continue.', signOut: false, retryable: false };
    }
    // Unclassified 401 is not proof of a dead session — keep the session.
    return { text: 'The backend could not verify this request (HTTP 401). Your session was kept. Please try again.', signOut: false };
  }

  // Real exhausted DAILY quota (the provider's own per-day allowance, as opposed
  // to a per-minute blip). `retryable: false` because retrying cannot work until
  // the quota resets — the Retry button is only rendered when it could help.
  if (code === 'AI_DAILY_LIMIT') {
    return {
      text:
        "Today's AI provider quota has been reached.\n\n" +
        'Configure another AI provider or try again after the quota resets.',
      signOut: false,
      retryable: false,
    };
  }
  // BOTH configured providers failed (the backend tried the primary, then the
  // fallback, then gave up). Retry is offered only when the backend says a retry
  // could help (both failures were transient). A spent daily quota keeps it off.
  if (code === 'AI_PROVIDERS_UNAVAILABLE') {
    return {
      text: 'AI services are temporarily unavailable. Please try again shortly.',
      signOut: false,
      retryable: err?.response?.data?.retryable !== false,
    };
  }
  // Per-minute rate limit (RPM/TPM): recovers in seconds, so Retry IS useful.
  // The backend names the exact kind (requests vs tokens), so its clean message
  // is preferred over a generic one — it never contains keys or provider URLs.
  if (status === 429 || code === 'AI_RATE_LIMITED') {
    const providerMsg = String(err?.response?.data?.message || '').trim();
    return {
      text:
        providerMsg ||
        'The AI provider is receiving too many requests. Please wait a moment and try again.',
      signOut: false,
      retryable: true,
    };
  }
  if (status === 403) {
    return { text: 'You do not have permission for this action.', signOut: false };
  }
  if (status === 404) {
    return { text: 'Requested resource was not found.', signOut: false };
  }
  if (code === 'AI_NOT_CONFIGURED') {
    return { text: 'AI service is not configured on the backend. Add LLM_API_KEY to backend/.env, then restart it.', signOut: false, retryable: false };
  }

  // ---- Provider faults, named precisely (never a generic "something went wrong")
  // and NEVER blamed on the backend. The backend is up: it reached the provider
  // and reported what the provider said. These arrive as real HTTP responses, so
  // none of them can be reported as "backend offline".
  if (code === 'AI_UNREACHABLE') {
    return {
      text: 'The backend could not connect to its AI provider. Check outbound HTTPS access and the backend provider connection settings, then retry.',
      signOut: false,
      retryable: err?.response?.data?.retryable !== false,
    };
  }
  if (code === 'AI_PROVIDER_UNAVAILABLE' || code === 'AI_PROVIDER_ERROR') {
    // Provider outage / overload — the exact §3 wording for "unavailable", and
    // always retryable: this is a transient provider fault, not a spent quota.
    return { text: 'The AI provider is temporarily unavailable. Please try again in a moment.', signOut: false, retryable: true };
  }
  if (code === 'AI_MODEL_UNAVAILABLE') {
    return { text: 'The configured AI model is not available to the provider right now. An admin should check LLM_MODEL in backend/.env.', signOut: false };
  }
  if (code === 'AI_AUTH_INVALID' || code === 'AI_AUTH_FORBIDDEN') {
    return { text: 'The AI provider rejected the backend\'s API key. An admin should check LLM_API_KEY in backend/.env.', signOut: false };
  }
  if (code === 'AI_BUDGET_TOO_LARGE') {
    return { text: 'The AI model could not produce an answer that long in one pass. Try asking for a smaller amount (e.g. half the items).', signOut: false };
  }
  if (code === 'AI_EMPTY_RESPONSE' || code === 'AI_TOOL_UNEXPECTED') {
    return { text: 'The AI returned an empty response. Please try again.', signOut: false };
  }
  if (code === 'AI_NOT_FOUND') {
    return { text: 'The AI provider endpoint was not found. An admin should check LLM_BASE_URL in backend/.env.', signOut: false };
  }

  // ---- Image generation (honest, specific, never blamed on the session) ----
  // These all arrive as real HTTP responses from the backend, so none of them
  // can be reported as "backend offline" or "session expired".
  if (code === 'IMAGE_NOT_CONFIGURED') {
    return { text: 'Image generation is not configured on the backend. Add an image provider (IMAGE_PROVIDER / IMAGE_API_KEY) to backend/.env, then restart it.', signOut: false };
  }
  if (code === 'IMAGE_PROVIDER_UNSUPPORTED') {
    return { text: 'The configured image provider is not supported by this backend. Check IMAGE_PROVIDER in backend/.env.', signOut: false };
  }
  if (code === 'IMAGE_RATE_LIMITED') {
    return { text: 'The image provider is busy right now. Please try again in a few seconds.', signOut: false };
  }
  if (code === 'IMAGE_SAFETY_BLOCKED') {
    return { text: 'The image provider declined that request. Please rephrase it and try again.', signOut: false };
  }
  if (code === 'IMAGE_EDIT_UNSUPPORTED') {
    return { text: err.response.data.message || 'The configured image provider cannot edit an uploaded image. Describe the change in words instead.', signOut: false };
  }
  if (code === 'IMAGE_TOO_LARGE') {
    return { text: 'The generated image was too large to store. Please try again with a simpler request.', signOut: false };
  }
  if (code === 'IMAGE_EMPTY_PROMPT') {
    return { text: 'Please describe the image you want to create.', signOut: false };
  }
  if (String(code).startsWith('IMAGE_')) {
    return { text: err.response.data.message || 'Image generation failed. Please try again.', signOut: false };
  }

  // The request itself cannot fit the provider's per-minute token budget (the
  // backend shrank the output budget and tried every provider, and ALL rejected
  // it as too large). Retrying the SAME oversized request can never help, so no
  // Retry button; the real remedy is a shorter message / new conversation.
  if (code === 'AI_REQUEST_TOO_LARGE') {
    return {
      text:
        "That request is too large for the AI provider's per-minute token budget.\n\n" +
        'Please shorten your message or start a new conversation, then try again.',
      signOut: false,
      retryable: false,
    };
  }

  // 502/503/504 in this position are upstream/gateway faults — a proxy or the
  // provider layer failed AFTER the backend received the request, so the wording
  // names the provider and stays retryable (§3).
  if (status === 502 || status === 503 || status === 504) {
    return { text: 'The AI provider is temporarily unavailable. Please try again in a moment.', signOut: false, retryable: true };
  }
  // A bare 500 is the BACKEND failing on its own (a bug or an unhandled fault in
  // our code), not the AI provider — blaming the provider for it was precisely
  // the misattribution that made provider outages and backend bugs look alike.
  if (status === 500) {
    return { text: 'The backend hit an internal error (HTTP 500) while handling that request. Please try again.', signOut: false, retryable: true };
  }
  return { text: "I'm having trouble generating that response right now. Please try again.", signOut: false };
};

// Groups a list of conversations into Today / Yesterday / Previous buckets for
// the sidebar, preserving the incoming (newest-activity-first) order. Pure, so
// it is safe to call on every render; empty buckets are dropped.
function chatGroupLabel(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return 'Previous';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return 'Previous';
}
function groupChats(list) {
  const buckets = { Today: [], Yesterday: [], Previous: [] };
  (list || []).forEach((c) => { buckets[chatGroupLabel(c.updatedAt)].push(c); });
  return ['Today', 'Yesterday', 'Previous']
    .filter((label) => buckets[label].length)
    .map((label) => ({ label, items: buckets[label] }));
}

// Reads an answer aloud via the browser SpeechSynthesis API. Used only when the
// user enabled "Voice playback" in Settings ▸ Chat Preferences. Strips the most
// common markdown markers so the spoken text stays clean; bounded so a very long
// answer cannot wedge the speech queue.
function speakAnswer(text) {
  try {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || !text) return;
    const clean = String(text)
      .replace(/```[\s\S]*?```/g, ' code block ')
      .replace(/[#*_>`~|]/g, ' ')
      .replace(/\[(.*?)\]\(.*?\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 4000);
    if (!clean) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'en-US';
    u.rate = 1;
    u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch { /* voice output is best-effort */ }
}

export default function CareerAssistant() {
  const { user } = useAuth();
  // Chat preferences (Settings ▸ Chat Preferences). These affect real behaviour:
  // enterToSend, confirmDelete and voicePlayback are read here; responseStyle and
  // language are applied server-side, where the user's saved preferences are
  // merged into the AI prompt (an explicit instruction always overrides them).
  const chatPrefs = user?.settings?.chat || {};
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [hasKnowledge, setHasKnowledge] = useState(true);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pendingDocs, setPendingDocs] = useState([]); // [{ id, name }] attached to the NEXT message
  const [dragOver, setDragOver] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(true);
  // Mobile only: the conversation history is a slide-out drawer instead of a
  // permanently visible column (see chat.css @media max-width:860px).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [typingVariant, setTypingVariant] = useState('think'); // think | web | docs | upload | image
  // Sidebar pagination: the first page of conversations loads on mount and
  // "See more" appends the next pages. `chatPage`/`hasMoreChats` track where
  // the normal list is; the search list has its own page state.
  const [chatPage, setChatPage] = useState(1);
  const [hasMoreChats, setHasMoreChats] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchPage, setSearchPage] = useState(1);
  const [searchHasMore, setSearchHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchDebounceRef = useRef(null);
  const searchSeqRef = useRef(0); // stale search responses never win
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const uploadRef = useRef(null);
  const failedQuestionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const speechRef = useRef(null);
  // Synchronous locks => prevent double-fire even within the same render tick
  // (double-click / Enter+click / React StrictMode double effect).
  const sendingRef = useRef(false);
  const regeneratingRef = useRef(false);
  const recordingRef = useRef(false);
  // Stale-response guard: only the LATEST requestId may update the UI.
  const latestRequestIdRef = useRef(null);
  const streamAbortRef = useRef(null);

  // Loads one page of conversations (newest first). `append=true` adds the next
  // page to what the sidebar already shows — no duplicates, no re-downloading.
  const loadChats = useCallback(async (page = 1, append = false) => {
    try {
      const { data } = await listChats(page, 10);
      const items = Array.isArray(data.chats) ? data.chats : [];
      setChats((prev) => (append
        ? [...prev, ...items.filter((n) => !prev.some((p) => p._id === n._id))]
        : items));
      setChatPage(page);
      setHasMoreChats(Boolean(data.hasMore));
    } catch { /* ignore */ }
  }, []);

  const loadMoreChats = async () => {
    if (loadingMore || !hasMoreChats) return;
    setLoadingMore(true);
    try {
      await loadChats(chatPage + 1, true);
    } finally {
      setLoadingMore(false);
    }
  };

  // Debounced server search over the user's OWN conversations only (titles +
  // message content). Stale responses are dropped via searchSeqRef so fast
  // typing can never paint an old result list over a newer one.
  const runSearch = useCallback(async (q, page = 1, append = false) => {
    const query = String(q || '').trim();
    const seq = ++searchSeqRef.current;
    if (!query) {
      setSearchResults([]);
      setSearchPage(1);
      setSearchHasMore(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const { data } = await searchChats(query, page, 10);
      if (seq !== searchSeqRef.current) return; // a newer keystroke superseded this
      const items = Array.isArray(data.chats) ? data.chats : [];
      setSearchResults((prev) => (append
        ? [...prev, ...items.filter((n) => !prev.some((p) => p._id === n._id))]
        : items));
      setSearchPage(page);
      setSearchHasMore(Boolean(data.hasMore));
    } catch { /* a failed search just leaves the previous state */ } finally {
      if (seq === searchSeqRef.current) setSearching(false);
    }
  }, []);

  const handleSearchChange = (value) => {
    setSearchQuery(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => runSearch(value, 1, false), 300);
  };

  const loadMoreSearch = async () => {
    if (searching || !searchHasMore) return;
    await runSearch(searchQuery, searchPage + 1, true);
  };

  // Never leave a pending debounce behind on unmount.
  useEffect(() => () => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
  }, []);

  // Readable date for the sidebar rows: "Today · 2:05 PM", "Yesterday · 9:12 AM",
  // "Oct 2 · 11:40 AM", or "Dec 25, 2025 · 8:00 AM" for older years.
  const formatChatDate = (iso) => {
    const d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
    const sameYear = d.getFullYear() === now.getFullYear();
    const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
    return `${date} · ${time}`;
  };

  useEffect(() => {
    loadChats();
    // A refresh while viewing a conversation keeps it on screen: the chat id is
    // mirrored into the URL (?chat=<id>) and restored on mount, so reloading
    // never silently dumps the user back into a blank chat.
    const urlChatId = new URLSearchParams(window.location.search).get('chat');
    if (urlChatId) openChat(urlChatId);
    Promise.allSettled([getResume(), getJob()]).then(([r, j]) => {
      setHasKnowledge(r.status === 'fulfilled' && j.status === 'fulfilled');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Escape anywhere stops voice recording/listening.
  useEffect(() => {
    if (!listening) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        stopListening();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [listening]);

  // Never leave a live recogniser or microphone stream behind on unmount.
  useEffect(() => () => {
    try { speechRef.current?.abort(); } catch { /* already stopped */ }
    speechRef.current = null;
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') { try { mr.stop(); } catch { /* ignore */ } }
    mediaRecorderRef.current = null;
  }, []);

  // Auto-grow the message box up to a comfortable max height, and collapse it
  // again after a send (single-line look, multi-line ready).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 140)}px`;
  }, [input]);

  const openChat = useCallback(async (chatId) => {
    setLoading(true);
    setActiveChatId(chatId);
    setShowSuggestions(false);
    setHistoryOpen(false); // close the mobile drawer once a conversation is picked
    try {
      const { data } = await getChat(chatId);
      // A stored image comes back as { imageId, ... }; ChatMessage normalises it.
      setMessages((data.chat.messages || []).map((m) => ({
        role: m.role,
        content: m.content,
        resources: m.resources || [],
        sources: m.sources || [],
        image: m.image || undefined,
        completion: m.completion || undefined,
      })));
      // Refresh-safe: the conversation survives a reload because its id is kept
      // in the URL (?chat=<id>) and restored by the mount effect.
      window.history.replaceState({}, '', `${window.location.pathname}?chat=${encodeURIComponent(chatId)}`);
    } catch {
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const newChat = () => {
    setActiveChatId(null);
    setMessages([]);
    setPendingDocs([]);
    setShowSuggestions(true);
    setHistoryOpen(false);
    window.history.replaceState({}, '', window.location.pathname);
    inputRef.current?.focus();
  };

  const handleDelete = async (chatId) => {
    if (chatPrefs.confirmDelete !== false && !window.confirm('Delete this conversation?')) return;
    try {
      await deleteChat(chatId);
      if (activeChatId === chatId) newChat();
      loadChats();
      // Keep search results consistent with reality: a deleted conversation
      // disappears from them too.
      setSearchResults((prev) => prev.filter((c) => c._id !== chatId));
      if (searchResults.length === 1 && searchHasMore) runSearch(searchQuery, 1, false);
    } catch { /* ignore */ }
  };

  // ---- File attachments via the [+] button or drag & drop ----
  const attachFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length || uploading || sending) return;
    setUploading(true);
    try {
      const { data } = await uploadChatFiles(files);
      const docs = Array.isArray(data.document) ? data.document : [data.document];
      const added = docs
        .filter((d) => d && (d.id || d._id))
        .map((d) => ({
          id: d.id || d._id,
          name: d.fileName || d.name || 'file',
          category: classifyFileName(d.fileName || d.name),
          status: d.status || 'ready',
          extension: String(d.extension || ''),
          hasImage: Boolean(d.hasImage),
          note: d.processingNote || '',
        }));
      setPendingDocs((prev) => [...prev, ...added]);
      // Honest note only when a file could NOT be prepared for AI analysis
      // (too large for vision, OCR unavailable, extraction failed) — the
      // backend's real processingNote, never a provider error.
      const pendingFiles = added.filter((d) => d.status !== 'ready' && d.note);
      if (pendingFiles.length) {
        setMessages((m) => [
          ...m,
          ...pendingFiles.map((d) => ({
            role: 'meta',
            content: `📎 ${d.name}: ${d.note}`,
          })),
        ]);
      }
    } catch {
      setMessages((m) => [...m, {
        role: 'error',
        content: 'Upload failed. Supported files: PDF, DOC, DOCX, TXT, PNG, JPG, JPEG (max 10 MB each).',
      }]);
    } finally {
      setUploading(false);
      if (uploadRef.current) uploadRef.current.value = '';
    }
  };

  const removePendingDoc = (id) => setPendingDocs((prev) => prev.filter((d) => d.id !== id));

  // ---- Voice input: speech -> transcript -> editable composer input -> Send ----
  //
  // The Web Speech API is the primary path because it recognises audio as it
  // arrives. A record-then-transcribe round trip loses short utterances (the
  // recorder can return an empty/too-short clip, Whisper then returns nothing
  // and the user is told "I couldn't understand the audio"), so MediaRecorder +
  // Whisper is only a fallback for browsers without the Web Speech API.
  //
  // Nothing in this flow sends a message: the transcript lands in the normal
  // input so the user can read and edit it, then presses Send themselves.
  const putTranscriptInComposer = (text) => {
    const q = String(text || '').replace(/\s+/g, ' ').trim();
    if (!q) return false;
    setInput((prev) => (prev ? `${prev} ${q}` : q));
    setVoiceError('');
    inputRef.current?.focus();
    return true;
  };

  // Fallback: record a clip and send it to Whisper (browsers without Web Speech).
  const applyWhisperTranscript = async (blob) => {
    setVoiceError('');
    try {
      const transcript = await transcribeAudio(blob);
      if (!putTranscriptInComposer(transcript)) {
        setVoiceError(NO_SPEECH_MESSAGE);
      }
    } catch {
      setVoiceError("I couldn't understand the audio. Please try again or type your message.");
    }
  };

  const startListening = () => {
    if (recordingRef.current || sendingRef.current) return;
    setVoiceError('');

    // Primary: live speech recognition.
    if (speechRecognitionSupported()) {
      try {
        speechRef.current = createSpeechCapture({
          onStart: () => {
            recordingRef.current = true;
            setListening(true);
            setVoiceError('');
          },
          onInterim: (text) => setVoiceTranscript(text),
          onFinal: (text) => setVoiceTranscript(text),
          onError: (outcome, message) => {
            // 'no-speech' is only reported when NOTHING was recognised. Any other
            // outcome (permission, no microphone, network) is reported as itself
            // so a real failure is never disguised as "no speech".
            if (outcome !== 'no-speech') setVoiceError(message);
          },
          onEnd: ({ transcript, outcome }) => {
            speechRef.current = null;
            recordingRef.current = false;
            setListening(false);
            setVoiceTranscript('');
            // The transcript is never cleared before the final result is used,
            // and onend after real speech is NOT treated as "no speech".
            if (transcript) putTranscriptInComposer(transcript);
            else if (outcome === 'no-speech') setVoiceError(NO_SPEECH_MESSAGE);
          },
        });
        return;
      } catch {
        // Unsupported for some reason: fall through to the recorder below.
      }
    }

    // Fallback: MediaRecorder -> backend Whisper.
    if (!mediaRecorderSupported()) {
      setVoiceError('Voice input is not supported in this browser. Please type your message.');
      return;
    }
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mr = new MediaRecorder(stream);
        mediaRecorderRef.current = mr;
        chunksRef.current = [];
        mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
        mr.onstop = async () => {
          recordingRef.current = false;
          setListening(false);
          stream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
          chunksRef.current = [];
          if (!blob.size) {
            setVoiceError(NO_SPEECH_MESSAGE);
            return;
          }
          await applyWhisperTranscript(blob);
        };
        mr.start();
        recordingRef.current = true;
        setListening(true);
      } catch {
        recordingRef.current = false;
        setListening(false);
        setVoiceError('Microphone permission is required for voice input.');
      }
    })();
  };

  const stopListening = () => {
    if (speechRef.current) speechRef.current.stop();
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== 'inactive') {
      mr.stop();
      return;
    }
    if (!speechRef.current) {
      recordingRef.current = false;
      setListening(false);
    }
  };

  const toggleListening = () => (listening ? stopListening() : startListening());

  // Core exchange submitter: appends the user question, calls the real AI, and
  // appends the assistant answer (with its resources + sources). On failure a
  // clean error bubble with a Retry action is shown instead of a raw provider
  // error. Each submission carries a fresh requestId; stale responses are ignored.
  const submitQuestion = async (question) => {
    if (!question || sendingRef.current) return;

    // Verify the CURRENT JWT before sending. Read-only local check: a token we
    // can prove is dead is never sent, and the still-valid 7-day token is always
    // sent as-is (the same one for every message — never re-minted). A token we
    // merely failed to decode is still sent so the BACKEND decides (it verifies
    // the signature and returns a real reason code).
    const verdict = inspectToken(getAuthToken());
    if (!verdict.ok && (verdict.reason === 'missing' || verdict.reason === 'expired')) {
      if (verdict.reason === 'expired') clearToken();
      setMessages((m) => [...m, {
        role: 'error',
        content:
          verdict.reason === 'missing'
            ? 'You are not signed in. Please log in again to continue.'
            : 'Your session has expired. Please log in again.',
        question,
        retryable: false, // retrying cannot work until the user signs in again
      }]);
      return;
    }

    sendingRef.current = true;
    setSending(true);
    const rid = newRequestId();
    const streamAbort = new AbortController();
    streamAbortRef.current = streamAbort;
    latestRequestIdRef.current = rid;
    const docIds = pendingDocs.map((d) => d.id);
    try {
      // A conversation the server no longer has (deleted from another device,
      // account reset, admin removal) must not brick the chat: drop the dead id
      // and start a fresh conversation so the message just typed is not lost.
      // Retried at most once - the retry sends no conversationId, so a second
      // 404 cannot loop. Reusing `rid` is safe: requestDedup never caches a
      // failed job, so the retry is a genuine new run, not a replayed duplicate.
      let data;
      const appendLive = (text) => {
        if (!text || latestRequestIdRef.current !== rid) return;
        setMessages((current) => {
          const out = [...current];
          const index = out.findIndex((m) => m.role === 'assistant' && m.streamingRequestId === rid);
          if (index < 0) out.push({ role: 'assistant', content: text, streamingRequestId: rid });
          else out[index] = { ...out[index], content: `${out[index].content || ''}${text}` };
          return out;
        });
      };
      const replaceLive = (text) => {
        if (latestRequestIdRef.current !== rid) return;
        setMessages((current) => current.map((m) =>
          m.role === 'assistant' && m.streamingRequestId === rid
            ? { ...m, content: text }
            : m
        ));
      };
      setMessages((current) => [...current, { role: 'assistant', content: '', streamingRequestId: rid }]);
      try {
        data = await streamChatMessage(question, activeChatId, docIds, rid, {
          signal: streamAbort.signal,
          onDelta: appendLive,
          onReplace: replaceLive,
        });
      } catch (err) {
        if (err.response?.status !== 404 || !activeChatId) throw err;
        setActiveChatId(null);
        data = await streamChatMessage(question, null, docIds, rid, {
          signal: streamAbort.signal,
          onDelta: appendLive,
          onReplace: replaceLive,
        });
      }
      if (latestRequestIdRef.current !== rid) return; // a newer message superseded this one
      setMessages((current) => current.map((m) =>
        m.role === 'assistant' && m.streamingRequestId === rid
          ? {
              role: 'assistant',
              content: data.message?.content || m.content || '',
              resources: data.resources || [],
              sources: data.sources || [],
              completion: data.completion || data.message?.completion || undefined,
              image: data.message?.image || data.image || undefined,
            }
          : m
      ));
      if (!activeChatId) setActiveChatId(data.conversationId);
      if (docIds.length) setPendingDocs([]); // attached docs stay on the server
      if (chatPrefs.voicePlayback && data.message?.content) speakAnswer(data.message.content);
      failedQuestionRef.current = null;
      loadChats();
    } catch (err) {
      if (latestRequestIdRef.current !== rid) return; // stale failure, ignore
      const fb = await friendlyError(err);
      // Only a token the backend actually rejected ends the session; every other
      // failure keeps the valid JWT and the signed-in user.
      if (fb.signOut) clearToken();
      failedQuestionRef.current = question;
      setMessages((m) => [...m, {
        role: 'error',
        content: fb.text,
        question,
        // Retry is offered ONLY when retrying could reasonably work: a spent
        // daily quota, a dead session or a missing key need time/config, not a
        // re-send (§11). Everything transient keeps its Retry button.
        retryable: fb.retryable !== false,
      }]);
    } finally {
      streamAbortRef.current = null;
      sendingRef.current = false;
      setSending(false);
      setTypingVariant('think');
      setShowSuggestions(false);
    }
  };

  const stopGeneration = () => {
    if (streamAbortRef.current) streamAbortRef.current.abort();
  };

  const send = async (text) => {
    const question = (text ?? input).trim();
    if (!question || sendingRef.current || regeneratingRef.current || recordingRef.current) return;
    setInput('');
    setShowSuggestions(false);
    // Phase-aware status: image generation / document retrieval / web search /
    // plain thinking. Only the LABEL is decided here — the backend decides the
    // real routing, so a wrong guess can never change what actually happens.
    const attachments = pendingDocs.map((d) => ({ id: d.id, name: d.name, hasImage: d.hasImage }));
    if (looksLikeImageRequest(question)) setTypingVariant('image');
    else if (pendingDocs.length) setTypingVariant('docs');
    else if (maySearchWeb(question)) setTypingVariant('web');
    else setTypingVariant('think');
    const userMsg = { role: 'user', content: question };
    if (attachments.length) userMsg.attachments = attachments;
    if (!messages.length) setMessages([userMsg]);
    else setMessages((m) => [...m, userMsg]);
    await submitQuestion(question);
  };

  const handleContinue = async (completion) => {
    if (sendingRef.current || regeneratingRef.current) return;
    let question = 'Continue the previous response from where it stopped. Add only missing content and do not repeat earlier content.';
    if (completion?.kind === 'items' && completion.nextIndex && completion.target) {
      question = `Continue the previous list: include items ${completion.nextIndex} through ${completion.target}. Fill only missing items, keep numbering continuous, and do not repeat any item already present.`;
    } else if (completion?.kind === 'words' && completion.requested && typeof completion.produced === 'number') {
      question = `Continue the previous answer with about ${Math.max(50, completion.requested - completion.produced)} additional words. Continue from where it stopped without repeating earlier content.`;
    }
    setMessages((current) => [...current, { role: 'user', content: question }]);
    await submitQuestion(question);
  };

  // Retry re-runs the exact failed question WITHOUT duplicating the user bubble
  // or the conversation history. Used by the error bubble's [ Retry ] button.
  const handleRetry = async () => {
    const question = failedQuestionRef.current;
    if (!question || sendingRef.current || regeneratingRef.current) return;
    setMessages((m) => {
      const out = [...m];
      while (out.length && out[out.length - 1].role === 'error') out.pop();
      if (out.length && out[out.length - 1].role === 'user' && out[out.length - 1].content === question) out.pop();
      return out;
    });
    failedQuestionRef.current = null;
    await submitQuestion(question);
  };

  // Regenerate replaces the LAST assistant answer by re-running the same user
  // question through the RAG pipeline (ChatGPT-style "Regenerate response").
  const handleRegenerate = async (conversationId) => {
    if (!conversationId || sendingRef.current || regeneratingRef.current) return;
    // Same rule as a normal send (submitQuestion): only a token we can PROVE is
    // dead stops the request, and only an actually-expired one is cleared. A
    // token we merely failed to decode ('malformed') is still sent so the BACKEND
    // decides — it verifies the signature and returns a real reason code. The old
    // guard cleared the session on 'malformed' and returned silently, logging the
    // user out over a local decode hiccup with no message at all.
    const verdict = inspectToken(getAuthToken());
    if (!verdict.ok && (verdict.reason === 'missing' || verdict.reason === 'expired')) {
      if (verdict.reason === 'expired') clearToken();
      setMessages((m) => [...m, {
        role: 'error',
        content:
          verdict.reason === 'missing'
            ? 'You are not signed in. Please log in again to continue.'
            : 'Your session has expired. Please log in again.',
        retryable: false, // retrying cannot work until the user signs in again
      }]);
      return;
    }
    regeneratingRef.current = true;
    setRegenerating(true);
    const rid = newRequestId();
    latestRequestIdRef.current = rid;
    try {
      const { data } = await regenerateMessage(conversationId, rid);
      if (latestRequestIdRef.current !== rid) return;
      setMessages((m) => {
        const out = [...m];
        // Replace the trailing assistant answer (and any trailing error bubble).
        while (out.length && (out[out.length - 1].role === 'assistant' || out[out.length - 1].role === 'error')) out.pop();
        out.push({
          role: 'assistant',
          content: data.message?.content || '',
          resources: data.resources || [],
          sources: data.sources || [],
          completion: data.completion || data.message?.completion || undefined,
          // Regenerating an image message produces a NEW image; a regenerated
          // text answer simply has no image here.
          image: data.message?.image || data.image || undefined,
        });
        return out;
      });
      if (chatPrefs.voicePlayback && data.message?.content) speakAnswer(data.message.content);
      failedQuestionRef.current = null;
      loadChats();
    } catch (err) {
      if (latestRequestIdRef.current !== rid) return;
      const fb = await friendlyError(err);
      if (fb.signOut) clearToken();
      setMessages((m) => [...m, {
        role: 'error',
        content: fb.text,
        retryable: fb.retryable !== false,
      }]);
    } finally {
      regeneratingRef.current = false;
      setRegenerating(false);
    }
  };

  const isSearchActive = searchQuery.trim().length > 0;
  const activeChatTitle = chats.find((c) => c._id === activeChatId)?.title || 'New chat';

  return (
    <div className="page chat-page">
      <div className="page-head chat-page-head">
        <div>
          <h1>AI Assistant</h1>
          <p className="muted">
            A general-purpose AI assistant — everyday questions, coding, resources, web answers — that also knows your resume and target job.
          </p>
        </div>
        <div className="page-head-actions">
          <BackendStatus />
          <button className="btn btn-outline btn-sm" onClick={newChat}>
            <Plus size={15} /> New chat
          </button>
        </div>
      </div>

      {!hasKnowledge && (
        <div className="glass-card empty-inline warn-inline fade-up">
          <p>Upload your resume and add a job description to unlock your personalized AI career assistant.</p>
          <div className="inline-actions">
            <Link to="/dashboard/resume" className="btn btn-primary btn-sm"><UploadCloud size={14} /> Upload Resume</Link>
            <Link to="/dashboard/job-description" className="btn btn-outline btn-sm"><Briefcase size={14} /> Add Job</Link>
          </div>
        </div>
      )}

      <div className="chat-shell">
        {/* Sessions sidebar — a normal column on laptops/desktops, a slide-out
            drawer on phones/tablets (opened by the menu button in .chat-main-head). */}
        <aside className={`chat-sessions ${historyOpen ? 'open' : ''}`}>
          <div className="chat-sessions-head">
            <h3><MessageSquare size={15} /> Conversations</h3>
            <button
              type="button"
              className="chat-drawer-close"
              aria-label="Close conversations"
              onClick={() => setHistoryOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="chat-search">
            <span className="chat-search-icon"><Search size={14} /></span>
            <input
              type="search"
              className="chat-search-input"
              placeholder="Search your chats..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              aria-label="Search your chats"
            />
            {searching && <Loader2 size={14} className="chat-search-spinner spin" />}
            {searchQuery && !searching && (
              <button
                type="button"
                className="chat-search-clear"
                aria-label="Clear search"
                onClick={() => handleSearchChange('')}
              >
                <X size={14} />
              </button>
            )}
          </div>
          <button type="button" className="btn btn-primary chat-new-btn" onClick={newChat}>
            <Plus size={15} /> New chat
          </button>
          <div className="chat-session-list">
            {isSearchActive ? (
              searchResults.length === 0 && !searching ? (
                <p className="chat-session-empty">No matching chats found</p>
              ) : (
                searchResults.map((c) => (
                  <div
                    key={c._id}
                    className={`chat-session ${activeChatId === c._id ? 'active' : ''}`}
                    onClick={() => openChat(c._id)}
                  >
                    <div className="chat-session-info">
                      <strong>{c.title}</strong>
                      <span className="chat-session-date">{formatChatDate(c.updatedAt)}</span>
                    </div>
                    <button className="session-delete" aria-label="Delete conversation" onClick={(e) => { e.stopPropagation(); handleDelete(c._id); }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )
            ) : chats.length === 0 ? (
              <p className="chat-session-empty">No conversations yet. Ask something to start a new chat.</p>
            ) : (
              groupChats(chats).map((group) => (
                <div key={group.label} className="chat-group">
                  <div className="chat-group-label">{group.label}</div>
                  {group.items.map((c) => (
                    <div
                      key={c._id}
                      className={`chat-session ${activeChatId === c._id ? 'active' : ''}`}
                      onClick={() => openChat(c._id)}
                    >
                      <div className="chat-session-info">
                        <strong>{c.title}</strong>
                        <span className="chat-session-date">{formatChatDate(c.updatedAt)}</span>
                      </div>
                      <button className="session-delete" aria-label="Delete conversation" onClick={(e) => { e.stopPropagation(); handleDelete(c._id); }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
          {!isSearchActive && hasMoreChats && (
            <button type="button" className="chat-see-more" onClick={loadMoreChats} disabled={loadingMore}>
              {loadingMore ? <Loader2 size={13} className="spin" /> : <ChevronDown size={13} />}
              See more
            </button>
          )}
          {isSearchActive && searchHasMore && (
            <button type="button" className="chat-see-more" onClick={loadMoreSearch} disabled={searching}>
              {searching ? <Loader2 size={13} className="spin" /> : <ChevronDown size={13} />}
              See more
            </button>
          )}
        </aside>

        {/* Mobile scrim: tapping outside the history drawer closes it. */}
        {historyOpen && <div className="chat-drawer-scrim" onClick={() => setHistoryOpen(false)} />}

        {/* Chat main */}
        <div className="chat-main">
          {/* Mobile-only bar: opens the conversation history drawer and shows
              which conversation is active. Hidden on laptops/desktops. */}
          <div className="chat-main-head">
            <button
              type="button"
              className="chat-drawer-toggle"
              aria-label="Open conversations"
              onClick={() => setHistoryOpen(true)}
            >
              <Menu size={18} />
              <span>Chats</span>
            </button>
            <span className="chat-main-title" title={activeChatTitle}>{activeChatTitle}</span>
            <button type="button" className="chat-drawer-new" aria-label="New chat" onClick={newChat}>
              <Plus size={18} />
            </button>
          </div>
          <div
            className="chat-messages"
            aria-live="polite"
            onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
            onDragLeave={(e) => { e.preventDefault(); if (e.currentTarget === e.target) setDragOver(false); }}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); attachFiles(e.dataTransfer.files); }}
          >
            {dragOver && (
              <div className="chat-drag-overlay">
                <Paperclip size={22} />
                <span>Drop files to attach — PDF, DOC, DOCX, TXT, PNG, JPG</span>
              </div>
            )}
            {messages.length === 0 && !showSuggestions && (
              <WelcomeBubble hasKnowledge={hasKnowledge} />
            )}
            {showSuggestions && (
              <>
                <WelcomeBubble hasKnowledge={hasKnowledge} />
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="suggestion-chip" onClick={() => send(s)}>
                      <Sparkles size={13} /> {s}
                    </button>
                  ))}
                </div>
              </>
            )}
            {messages.map((m, i) => {
              const isLastAssistant = m.role === 'assistant' && i === messages.length - 1;
              return (
                <ChatMessage
                  key={i}
                  msg={m}
                  onRetry={
                    m.role === 'error' && m.retryable !== false
                      ? (m.question ? handleRetry : () => activeChatId && handleRegenerate(activeChatId))
                      : undefined
                  }
                  onRegenerate={isLastAssistant && activeChatId ? () => handleRegenerate(activeChatId) : undefined}
                  onRegenerateImage={
                    isLastAssistant && activeChatId && m.image ? () => handleRegenerate(activeChatId) : undefined
                  }
                  onContinue={
                    m.role === 'assistant' && m.completion?.complete === false
                      ? () => handleContinue(m.completion)
                      : undefined
                  }
                  sending={sending}
                  regenerating={regenerating}
                />
              );
            })}
            {(sending || regenerating || uploading || listening) && (
              <div className="chat-message ai">
                <div className="chat-avatar ai"><Loader2 size={16} className="spin" /></div>
                <div className="chat-bubble ai typing">
                  <span className="typing-label">
                    {listening
                      ? 'Listening… speak now'
                      : uploading
                        ? 'Uploading file…'
                        : typingVariant === 'image'
                          ? 'Creating your image…'
                          : typingVariant === 'web'
                            ? 'Searching the web…'
                            : typingVariant === 'docs'
                              ? 'Reading your uploaded documents…'
                              : 'AI is thinking…'}
                  </span>
                  <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
                  {sending && (
                    <button type="button" className="btn btn-ghost chat-stop" onClick={stopGeneration}>
                      <Square size={13} /> Stop generation
                    </button>
                  )}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {listening && !sending && (
            <div className="voice-banner">
              <Mic size={14} className="voice-pulse" />
              {voiceTranscript
                ? <>Listening… <span className="voice-live">{voiceTranscript}</span></>
                : 'Listening… speak now, then press the microphone again to stop.'}
            </div>
          )}
          {voiceError && !listening && (
            <div className="voice-banner voice-error-banner">{voiceError}</div>
          )}

          <form
            className="chat-input-row"
            onSubmit={(e) => { e.preventDefault(); send(); }}
          >
            {/* [+] attachment button: resume, JD, PDF/DOC/DOCX/TXT, images, any supported file */}
            <button
              type="button"
              className="chat-attach"
              onClick={() => uploadRef.current?.click()}
              disabled={sending || regenerating || uploading || listening}
              aria-label="Attach files"
              title="Attach resume, job description, PDF/DOC/DOCX/TXT or an image"
            >
              <Plus size={18} />
            </button>
            {/* Mic button: live speech recognition -> transcript in the input -> user presses Send.
                It never sends the message by itself. */}
            <button
              type="button"
              className={`chat-attach voice-btn ${listening ? 'voice-btn-recording' : ''}`}
              onClick={toggleListening}
              disabled={sending || regenerating || uploading}
              aria-label={listening ? 'Stop listening' : 'Ask with your voice'}
              title={listening ? 'Stop listening' : 'Ask with your voice (your words appear in the box so you can edit and send)'}
            >
              {listening ? <Square size={15} fill="currentColor" /> : <Mic size={18} />}
            </button>
            <input
              ref={uploadRef}
              type="file"
              multiple
              accept={ACCEPTED_FILE_TYPES}
              style={{ display: 'none' }}
              onChange={(e) => attachFiles(e.target.files)}
              aria-hidden="true"
            />
            <div className="chat-input-wrap">
              {pendingDocs.length > 0 && (
                <div className="attachment-chips">
                  {pendingDocs.map((d) => (
                    <span key={d.id} className="attachment-chip" title={d.name}>
                      {d.hasImage ? <ImageThumb documentId={d.id} name={d.name} size={36} /> : <FileChip category={d.category} />}
                      <span className="attachment-chip-name">{d.name}</span>
                      <button type="button" className="attachment-remove" aria-label="Remove attachment"
                        onClick={() => removePendingDoc(d.id)}>
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                className="input chat-input chat-textarea"
                placeholder={chatPrefs.enterToSend !== false ? 'Ask anything — coding, career, documents, web… (Enter to send · Shift+Enter for a new line)' : 'Ask anything — coding, career, documents, web… (Shift+Enter or the button to send)'}
                value={input}
                rows={1}
                disabled={sending || regenerating || uploading}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends (unless the user turned that off); Shift+Enter
                  // always inserts a new line. Escape stops listening.
                  if (e.key === 'Enter' && !e.shiftKey && chatPrefs.enterToSend !== false) {
                    e.preventDefault();
                    send();
                  } else if (e.key === 'Escape' && listening) {
                    e.preventDefault();
                    stopListening();
                  }
                }}
                aria-label="Ask anything"
              />
            </div>
            <button className="btn btn-primary chat-send" type="submit" disabled={sending || regenerating || uploading || !input.trim()} aria-label="Send">
              <Send size={17} />
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function FileChip({ category }) {
  if (category === 'resume') return <UploadCloud size={12} />;
  if (category === 'jd') return <Briefcase size={12} />;
  return <Paperclip size={12} />;
}