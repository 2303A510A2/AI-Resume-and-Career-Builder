import { useState, useRef, useEffect } from 'react';
import {
  Bot, User, Cpu, FileText, Copy, Check, Share2, ExternalLink, Braces, RotateCcw, RefreshCw,
  Volume2, Pause, Play, Square, Paperclip, Maximize2, Download, ImageOff, X, Loader2,
} from 'lucide-react';
import { assistantSpeech, speechSynthesisSupported } from '../services/voiceService';
import { fetchDocumentImage } from '../services/fileService';
import { fetchGeneratedImage } from '../services/chatService';
import { highlightTokens } from '../services/syntaxHighlight';

/* ------------------------------------------------------------------ *
 * Minimal, safe markdown-ish renderer for AI chat bubbles. Everything  *
 * is rendered as React elements (React escapes text), so AI output     *
 * can never inject HTML. External links always open in a new tab.      *
 * ------------------------------------------------------------------ */

// Tight inline tokenizer: inline code, **bold**, *italic*, [text](url), raw URL.
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[([^\]]+)\]\(([^)\s]+)\))|(https?:\/\/[^\s<>"'()]+)/g;

const safeHref = (raw) => {
  const s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    return new URL(s).href;
  } catch {
    return null;
  }
};

function renderInline(text) {
  const out = [];
  let lastIdx = 0;
  let key = 0;
  INLINE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(<span key={key++}>{text.slice(lastIdx, m.index)}</span>);
    if (m[1]) {
      out.push(<code key={key++} className="inline-code">{m[1].slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={key++}>{renderInline(m[2].slice(2, -2))}</strong>);
    } else if (m[3]) {
      out.push(<em key={key++}>{renderInline(m[3].slice(1, -1))}</em>);
    } else if (m[4]) {
      const href = safeHref(m[6]);
      if (href) {
        out.push(<a key={key++} href={href} target="_blank" rel="noopener noreferrer">{renderInline(m[5])}</a>);
      } else {
        out.push(<span key={key++}>{m[4]}</span>);
      }
    } else if (m[7]) {
      const href = safeHref(m[7]);
      if (href) {
        const label = href.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '');
        out.push(
          <a key={key++} className="chat-inline-link" href={href} target="_blank" rel="noopener noreferrer" title={href}>
            {label}
          </a>
        );
      } else {
        out.push(<span key={key++}>{m[7]}</span>);
      }
    }
    lastIdx = INLINE_RE.lastIndex;
  }
  if (lastIdx < text.length) out.push(<span key={key++}>{text.slice(lastIdx)}</span>);
  return out;
}

const FENCE_RE = /^```([\w+#.-]*)[ \t]*\n?([\s\S]*?)```/gm;

// Long answers can legitimately end mid-code-block (the provider hit its output
// ceiling, or the model genuinely ran out). An UNTERMINATED fence must still be
// rendered as a code block — otherwise the fence markers leak into the text and
// the remaining lines lose their monospace formatting.
function splitBlocks(text) {
  const blocks = [];
  let lastIdx = 0;
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text)) !== null) {
    if (m.index > lastIdx) blocks.push({ type: 'text', text: text.slice(lastIdx, m.index) });
    blocks.push({ type: 'code', lang: m[1] || '', code: m[2].replace(/\n$/, ''), truncated: false });
    lastIdx = m.index + m[0].length;
  }
  const tail = text.slice(lastIdx);
  if (tail) {
    const open = /^```([\w+#.-]*)[ \t]*\n?/.exec(tail);
    if (open) {
      // Unterminated fence: render the remainder as a code block, honestly.
      blocks.push({
        type: 'code',
        lang: open[1] || '',
        code: tail.slice(open[0].length).replace(/\n+$/, ''),
        truncated: true,
      });
    } else {
      blocks.push({ type: 'text', text: tail });
    }
  }
  if (!blocks.length && text) blocks.push({ type: 'text', text });
  return blocks;
}

const isOrderedItem = (line) => {
  const m = line.match(/^(\s*)\d+[.)]\s+(.*)$/);
  return m ? { indent: m[1].length, text: m[2] } : null;
};

const isUnorderedItem = (line) => {
  const m = line.match(/^(\s*)([-*•])\s+(.*)$/);
  return m ? { indent: m[1].length, text: m[3] } : null;
};

// A table row may or may not carry a trailing pipe — models are inconsistent, and
// a "trailing pipe missing" row must still render as a table row, not as body text.
const isTableRow = (line) => {
  const t = line.trim();
  if (!t.startsWith('|')) return false;
  return (t.match(/\|/g) || []).length >= 2;
};

const isTableSeparator = (line) =>
  /^\s*\|?(\s*:?-{1,}:?\s*\|)+\s*$/.test(line.trim()) || /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*:?-{0,}:?\s*$/m.test(line.trim()) || /^\s*\|?[\s:|-]*-{2,}[\s:|-]*$/.test(line.trim());

const splitRow = (line) =>
  line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function SourceRow({ line }) {
  const text = line.replace(/^>\s?/, '');
  return <div className="bot-quote-line">{renderInline(text)}</div>;
}

function TextBlock({ text }) {
  const lines = String(text).split('\n');
  const blocks = [];
  let para = [];
  let list = null; // { type: 'ul'|'ol', items: [] }
  let quote = null; // array of quote lines
  let table = null; // { header: [..], rows: [ [..] ] }

  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={blocks.length}>{renderInline(para.join('\n'))}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.type === 'ol' ? 'ol' : 'ul';
    blocks.push(
      <Tag key={blocks.length}>
        {list.items.map((item, i) =>
          item && typeof item === 'object' && item.children
            ? (
              <li key={i}>
                {renderInline(item.text)}
                <Tag className="bot-nested-list">
                  {item.children.map((child, ci) => <li key={ci}>{renderInline(child)}</li>)}
                </Tag>
              </li>
            )
            : <li key={i}>{renderInline(item)}</li>
        )}
      </Tag>
    );
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    blocks.push(
      <blockquote key={blocks.length} className="bot-quote">
        {quote.map((q, i) => <SourceRow key={i} line={q} />)}
      </blockquote>
    );
    quote = null;
  };
  const flushTable = () => {
    if (!table) return;
    blocks.push(
      <div key={blocks.length} className="bot-table-wrap">
        <table className="bot-table">
          <thead>
            <tr>{table.header.map((c, i) => <th key={i}>{renderInline(c)}</th>)}</tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri}>{row.map((c, ci) => <td key={ci}>{renderInline(c)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    table = null;
  };

  lines.forEach((rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trim();

    // ---- tables (GFM-ish: header row, |---| separator, then body rows) ----
    if (isTableRow(line)) {
      flushPara();
      flushList();
      flushQuote();
      if (!table) {
        table = { header: splitRow(line), rows: [] };
      } else if (isTableSeparator(line)) {
        // separator between the header and body rows: skip it
      } else {
        table.rows.push(splitRow(line));
      }
      return;
    }

    if (table) flushTable();

    if (!trimmed) {
      flushPara();
      flushList();
      flushQuote();
      flushTable();
      return;
    }

    // ---- blockquotes ----
    if (/^>\s?/.test(line)) {
      flushPara();
      flushList();
      flushTable();
      if (!quote) quote = [];
      quote.push(line);
      return;
    }
    flushQuote();

    // ----list items ---
    const ol = isOrderedItem(line);
    const ul = isUnorderedItem(line);
    // Indent >= 2 becomes a nested sub-item. Previously those lines fell through
    // to the paragraph branch, which broke the list apart and merged the nested
    // text into the following paragraph.
    const nested = ol || ul;
    if (nested && nested.indent >= 2 && nested.indent < 8 && list) {
      const parent = list.items[list.items.length - 1];
      if (parent && typeof parent === 'object' && parent.children) parent.children.push(nested.text);
      else if (typeof parent === 'string') list.items[list.items.length - 1] = { text: parent, children: [nested.text] };
      else list.items.push({ text: '', children: [nested.text] });
      return;
    }
    if (ol && ol.indent < 4) {
      flushPara();
      flushTable();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(ol.text);
      return;
    }
    if (ul && ul.indent < 4) {
      flushPara();
      flushTable();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(ul.text);
      return;
    }

    // --- horizontal rules (--- / *** / ___) ---
    if (/^\s*(?:-[ \t]*){3,}$/.test(line) || /^\s*(?:\*[ \t]*){3,}$/.test(line) || /^\s*(?:_[ \t]*){3,}$/.test(line)) {
      flushPara();
      flushList();
      flushQuote();
      flushTable();
      blocks.push(<hr key={blocks.length} className="bot-hr" />);
      return;
    }

    // --- headings ---
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      flushQuote();
      flushTable();
      const level = h[1].length;
      const content = renderInline(h[2]);
      blocks.push(
        level <= 2
          ? <h3 key={blocks.length}>{content}</h3>
          : <h4 key={blocks.length}>{content}</h4>
      );
      return;
    }

    // --- paragraph text (keep the original line spacing inside paragraphs) ---
    flushList();
    flushTable();
    flushQuote();
    para.push(line);
  });

  flushPara();
  flushList();
  flushQuote();
  flushTable();
  return <div className="bot-text-block">{blocks}</div>;
}

function CodeBlock({ code, lang, truncated }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{lang || 'code'}</span>
        <button type="button" className="code-copy-btn" onClick={copy} aria-label="Copy code">
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre><HighlightedCode code={code} lang={lang} /></pre>
      {truncated && (
        // Honest, never hidden: the answer really does end here.
        <div className="code-block-cut">…this code block was not finished (the answer was cut off by the model&rsquo;s output limit). Send &ldquo;continue&rdquo; to get the rest.</div>
      )}
    </div>
  );
}

// Renders tokenized code as React text spans — the exact same characters the
// user sees, and exactly what Copy Code copies (the raw `code` string above).
// Because everything is a React text node, code can never inject HTML.
function HighlightedCode({ code, lang }) {
  const tokens = highlightTokens(code, lang);
  return (
    <code>
      {tokens.map((t, i) => {
        const cls = t.type === 'plain' ? '' : `tok-${t.type}`;
        return <span key={i} className={cls}>{t.text}</span>;
      })}
    </code>
  );
}

function renderMarkdown(text) {
  if (!String(text).trim()) return null;
  return splitBlocks(text).map((block, i) =>
    block.type === 'code'
      ? <CodeBlock key={i} code={block.code} lang={block.lang} truncated={block.truncated} />
      : <TextBlock key={i} text={block.text} />
  );
}

/* --------------------------------------------------------------- *
 * Structured resource card (problems, websites, docs, courses...) *
 * --------------------------------------------------------------- */

function ResourceCard({ resource }) {
  const isProblem = resource.type === 'leetcode' || resource.type === 'problem';
  const diffClass = resource.difficulty === 'Easy' ? 'diff-easy'
    : resource.difficulty === 'Medium' ? 'diff-medium'
    : resource.difficulty === 'Hard' ? 'diff-hard' : '';
  // Platform name shown on every card: "LeetCode" for problems, otherwise the
  // verified URL's host (always a trusted domain, normalized earlier).
  const platform = isProblem
    ? 'LeetCode'
    : String(resource.url || '')
        .replace(/^https?:\/\/(www\.)?/, '')
        .replace(/\/+$/, '');
  return (
    <div className="resource-card">
      <div className="resource-card-head">
        <span className={`difficulty-badge ${diffClass}`}>
          {resource.difficulty || (isProblem ? 'Problem' : resource.type)}
        </span>
        <h4 className="resource-title">
          {resource.url ? (
            <a href={resource.url} target="_blank" rel="noopener noreferrer" title={`Open ${platform} in a new tab`}>
              {resource.title}
            </a>
          ) : (
            resource.title
          )}
        </h4>
      </div>
      {resource.description && <p className="resource-desc">{resource.description}</p>}
      {platform && <span className="resource-platform">{platform}</span>}
      <a className="btn btn-primary btn-sm resource-open" href={resource.url} target="_blank" rel="noopener noreferrer" title="Opens in a new tab">
        {isProblem ? <Braces size={14} /> : <ExternalLink size={14} />}
        {isProblem ? 'Solve' : 'Open'}
      </a>
    </div>
  );
}

/* --------------------------------------------------------------- *
 * Sources list (real, verified source links used in the answer)   *
 * --------------------------------------------------------------- */

function SourcesSection({ sources }) {
  if (!Array.isArray(sources) || !sources.length) return null;
  return (
    <div className="chat-sources">
      <span className="chat-sources-title">Sources</span>
      <ul className="chat-sources-list">
        {sources.map((s, i) => {
          const href = safeHref(s && s.url);
          const label = (s && (s.title || s.domain)) || '';
          return (
            <li key={i} className="chat-source-item">
              <ExternalLink size={12} />
              {href ? (
                <a className="chat-source-link" href={href} target="_blank" rel="noopener noreferrer" title={href}>
                  {label}
                </a>
              ) : (
                <span>{label}</span>
              )}
              {s && s.domain && <span className="chat-source-domain">{s.domain}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* --------------------------------------------------------------- *
 * Copy / Share actions shown under every AI response               *
 * --------------------------------------------------------------- */

// Small preview of an attached image (real pixels fetched from the ownership-
// checked /files/:id/image endpoint). Falls back silently to a document icon
// when the fetch fails (e.g. deleted file) — never a raw provider error.
export function ImageThumb({ documentId, name = '', size = 44 }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let objUrl = '';
    (async () => {
      try {
        const blob = await fetchDocumentImage(documentId);
        if (!alive) return;
        objUrl = URL.createObjectURL(blob);
        setUrl(objUrl);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  if (failed) return <span className="image-thumb image-thumb-fallback"><Paperclip size={14} /></span>;
  if (!url) return <span className="image-thumb image-thumb-loading" style={{ width: size, height: size }} />;
  return (
    <span className="image-thumb" style={{ width: size, height: size }}>
      <img src={url} alt={name || 'attached image'} loading="lazy" />
    </span>
  );
}

export function messageToPlainText(msg) {
  const parts = [String(msg?.content || '')];
  if (Array.isArray(msg?.resources) && msg.resources.length) {
    parts.push('');
    msg.resources.forEach((r) => {
      const line = `- ${r.title || ''}${r.difficulty ? ` (${r.difficulty})` : ''}${r.url ? ` — ${r.url}` : ''}`;
      parts.push(line);
    });
  }
  if (Array.isArray(msg?.sources) && msg.sources.length) {
    parts.push('');
    parts.push('Sources:');
    msg.sources.forEach((s) => {
      parts.push(`- ${s.title || s.domain || ''} — ${s.url || ''}`);
    });
  }
  return parts.join('\n');
}

// Cleaned spoken version of the answer: strip markdown syntax so the voice is
// natural (no stray **, #, backticks, or raw URLs read aloud).
const markdownToSpeech = (text) =>
  String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, (_, c) => c)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/[*_>|~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function AiActions({ plainText, speechText, onRegenerate, regenerating }) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [voiceState, setVoiceState] = useState('idle'); // idle | loading | playing | paused
  const audioRef = useRef(null);
  const urlRef = useRef(null);

  const stopSynth = () => {
    try { if (speechSynthesisSupported()) window.speechSynthesis.cancel(); } catch { /* ignore */ }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  const handleShare = async () => {
    // Web Share API when supported (mobile / modern desktop browsers).
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'AI Resume & Career Builder', text: plainText });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user closed the sheet
      }
    }
    // Fallback: copy so the user can paste it anywhere.
    try {
      await navigator.clipboard.writeText(plainText);
      setFallback(true);
      setTimeout(() => setFallback(false), 2200);
    } catch { /* clipboard unavailable */ }
  };

  // ---- AI Answer Voice: backend TTS when configured, else browser speechSynthesis ----
  const speak = async () => {
    if (voiceState === 'playing' || voiceState === 'loading') return;
    stopSynth();
    setVoiceState('loading');
    try {
      const blob = await assistantSpeech(speechText);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      const cleanup = () => {
        if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
        audioRef.current = null;
        setVoiceState('idle');
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      await audio.play();
      setVoiceState('playing');
    } catch {
      // Backend TTS unavailable/not configured -> browser speech synthesis.
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
      try {
        if (!speechSynthesisSupported()) { setVoiceState('idle'); return; }
        const u = new SpeechSynthesisUtterance(speechText);
        u.rate = 1; u.pitch = 1;
        u.onend = () => setVoiceState('idle');
        u.onerror = () => setVoiceState('idle');
        window.speechSynthesis.speak(u);
        setVoiceState('playing');
      } catch { setVoiceState('idle'); }
    }
  };

  const pauseVoice = () => {
    const audio = audioRef.current;
    if (audio && !audio.paused) { audio.pause(); setVoiceState('paused'); return; }
    try { if (speechSynthesisSupported()) { window.speechSynthesis.pause(); setVoiceState('paused'); } } catch { /* ignore */ }
  };

  const resumeVoice = () => {
    const audio = audioRef.current;
    if (audio) { audio.play().catch(() => {}); setVoiceState('playing'); return; }
    try { if (speechSynthesisSupported()) { window.speechSynthesis.resume(); setVoiceState('playing'); } } catch { /* ignore */ }
  };

  const stopVoice = () => {
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.currentTime = 0; audioRef.current = null; }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
    stopSynth();
    setVoiceState('idle');
  };

  return (
    <div className="chat-actions">
      <button type="button" className="chat-action-btn" onClick={copyToClipboard} aria-label="Copy response">
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <button type="button" className="chat-action-btn" onClick={handleShare} aria-label="Share response">
        <Share2 size={13} /> Share
      </button>
      {voiceState === 'idle' && speechText && (
        <button type="button" className="chat-action-btn" onClick={speak} aria-label="Listen to this answer" title="Listen to this answer">
          <Volume2 size={13} /> Listen
        </button>
      )}
      {voiceState === 'loading' && (
        <button type="button" className="chat-action-btn" disabled aria-label="Loading audio">
          <Volume2 size={13} className="spin" /> Loading…
        </button>
      )}
      {(voiceState === 'playing' || voiceState === 'paused') && (
        <>
          {voiceState === 'playing' ? (
            <button type="button" className="chat-action-btn" onClick={pauseVoice} aria-label="Pause">
              <Pause size={13} /> Pause
            </button>
          ) : (
            <button type="button" className="chat-action-btn" onClick={resumeVoice} aria-label="Resume">
              <Play size={13} /> Resume
            </button>
          )}
          <button type="button" className="chat-action-btn" onClick={stopVoice} aria-label="Stop">
            <Square size={12} /> Stop
          </button>
        </>
      )}
      {typeof onRegenerate === 'function' && (
        <button
          type="button"
          className="chat-action-btn"
          onClick={onRegenerate}
          disabled={regenerating}
          aria-label="Regenerate response"
          title="Generate a new version of this answer"
        >
          {regenerating ? <RefreshCw size={13} className="spin" /> : <RotateCcw size={13} />}
          {regenerating ? 'Regenerating…' : 'Regenerate'}
        </button>
      )}
      {fallback && (
        <span className="chat-action-fallback">
          Response copied — you can share it anywhere.
        </span>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- *
 * Main message bubble                                              *
 * --------------------------------------------------------------- */

// ---------------------------------------------------------------------------
// Generated image
//
// The bytes are NEVER in the chat payload or in the message — the message only
// carries the image id, and the picture is fetched with the user's JWT from
// GET /api/ai/images/:id (ownership-checked server-side). That is also why the
// <img> src is a short-lived blob URL rather than a public provider link.
// ---------------------------------------------------------------------------

export const normalizeGeneratedImage = (raw) => {
  if (!raw) return null;
  const id = raw.id || raw.imageId || raw._id || '';
  if (!id) return null;
  return {
    id: String(id),
    prompt: String(raw.prompt || ''),
    provider: String(raw.provider || ''),
    model: String(raw.model || ''),
    mimeType: String(raw.mimeType || 'image/png'),
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    isFollowUp: Boolean(raw.isFollowUp),
  };
};

function GeneratedImageBlock({ image, onRegenerateImage, regenerating }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [lightbox, setLightbox] = useState(false);
  const meta = normalizeGeneratedImage(image);
  const blobRef = useRef('');

  useEffect(() => {
    if (!meta?.id) return undefined;
    let alive = true;
    (async () => {
      try {
        const blob = await fetchGeneratedImage(meta.id);
        if (!alive) return;
        blobRef.current = URL.createObjectURL(blob);
        setUrl(blobRef.current);
      } catch (err) {
        if (alive) {
          setError(
            err?.response?.status === 404
              ? 'This image is no longer available.'
              : 'The image could not be loaded. Please try again.'
          );
        }
      }
    })();
    return () => {
      alive = false;
      if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    };
  }, [meta?.id]);

  // Escape closes the full-size view.
  useEffect(() => {
    if (!lightbox) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setLightbox(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  if (!meta) return null;

  const download = () => {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-image-${meta.id}.${(meta.mimeType.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const share = async () => {
    const text = meta.prompt || 'AI generated image';
    try {
      // The local file is shared when the browser supports file sharing; the
      // prompt is shared otherwise. The remote provider URL is never exposed.
      const blob = url ? await (await fetch(url)).blob() : null;
      const file = blob ? new File([blob], `ai-image-${meta.id}.png`, { type: meta.mimeType }) : null;
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'AI generated image', text });
        return;
      }
      await navigator.share({ title: 'AI generated image', text });
    } catch {
      download();
    }
  };

  const style = meta.width > 0 && meta.height > 0 ? { aspectRatio: `${meta.width} / ${meta.height}` } : undefined;

  return (
    <>
      <figure className="ai-image">
        {error ? (
          <div className="ai-image-error">
            <ImageOff size={20} />
            <span>{error}</span>
          </div>
        ) : url ? (
          <button
            type="button"
            className="ai-image-frame"
            style={style}
            onClick={() => setLightbox(true)}
            aria-label="View this image full size"
          >
            <img src={url} alt={meta.prompt || 'AI generated image'} loading="lazy" />
            <span className="ai-image-zoom"><Maximize2 size={14} /> View</span>
          </button>
        ) : (
          <div className="ai-image-frame ai-image-loading" style={style}>
            <Loader2 size={18} className="ai-image-spin" /> Loading image…
          </div>
        )}
        <div className="ai-image-actions">
          <button type="button" onClick={() => setLightbox(true)} disabled={!url}>
            <Maximize2 size={13} /> View
          </button>
          {typeof onRegenerateImage === 'function' && (
            <button type="button" onClick={onRegenerateImage} disabled={regenerating}>
              <RefreshCw size={13} className={regenerating ? 'ai-image-spin' : undefined} />
              {regenerating ? 'Creating…' : 'Regenerate'}
            </button>
          )}
          <button type="button" onClick={share} disabled={!url}>
            <Share2 size={13} /> Share
          </button>
          <button type="button" onClick={download} disabled={!url}>
            <Download size={13} /> Download
          </button>
        </div>
        <figcaption className="ai-image-caption">
          {meta.prompt}
          {meta.isFollowUp && <span className="ai-image-tag">follow-up</span>}
          <span className="ai-image-meta">
            {meta.width > 0 && `${meta.width}×${meta.height}`}
            {meta.provider && meta.provider !== 'selftest' && ` · ${meta.provider}`}
          </span>
        </figcaption>
      </figure>

      {lightbox && url && (
        <div
          className="ai-image-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="Generated image"
          onClick={() => setLightbox(false)}
        >
          <button type="button" className="ai-image-lightbox-close" aria-label="Close image" onClick={() => setLightbox(false)}>
            <X size={20} />
          </button>
          <img src={url} alt={meta.prompt || 'AI generated image'} onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </>
  );
}

export default function ChatMessage({ msg, onRetry, onRegenerate, onRegenerateImage, onContinue, sending, regenerating }) {
  const isUser = msg?.role === 'user';
  const isMeta = msg?.role === 'meta';
  const isError = msg?.role === 'error';

  if (isMeta) {
    return (
      <div className="chat-meta">
        <Cpu size={14} />
        <span>{msg.content}</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="chat-error">
        <div className="chat-avatar ai"><Bot size={16} /></div>
        <div className="chat-bubble ai chat-error-bubble">
          <p>{msg.content}</p>
          {typeof onRetry === 'function' && (
            <button type="button" className="btn btn-outline btn-sm retry-btn" onClick={onRetry} aria-label="Try Again">
              <RefreshCw size={13} /> Try Again
            </button>
          )}
        </div>
      </div>
    );
  }

  const resources = Array.isArray(msg?.resources) ? msg.resources : [];
  const sources = Array.isArray(msg?.sources) ? msg.sources : [];
  const completion = msg?.completion;
  const completionIssue = completion?.failure === 'AI_DAILY_LIMIT'
    ? "The provider's daily token quota was reached; try continuing after it resets."
    : completion?.failure === 'AI_RATE_LIMITED'
      ? 'The provider is rate-limited right now; try continuing shortly.'
      : completion?.failure === 'AI_REQUEST_TOO_LARGE'
        ? "The remaining request exceeded the provider's per-minute token budget."
        : completion?.failure
          ? 'The provider could not generate the remaining content.'
          : completion?.stopped === 'no_progress'
            ? 'Automatic continuation repeated earlier content and was stopped.'
            : completion?.stopped === 'attempt_limit'
              ? 'The automatic continuation limit was reached.'
              : completion?.providerTruncated
                ? 'The provider reached its output limit before completing the response.'
                : '';

  return (
    <div className={`chat-message ${isUser ? 'user' : 'ai'}`}>
      <div className="chat-avatar">
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>
      <div className="chat-bubble">
        {renderMarkdown(String(msg?.content || ''))}
        {!isUser && completion?.complete === false && (
          <div className="chat-completion-warning" role="status">
            <strong>Incomplete response.</strong>
            <p>
              {typeof completion.produced === 'number' && typeof completion.requested === 'number'
                ? `${completion.produced} of ${completion.requested} requested ${completion.kind === 'words' ? 'words' : 'items'} were completed.`
                : 'The provider stopped before the full response was confirmed.'}
            </p>
            {completionIssue && <p>{completionIssue}</p>}
            {typeof onContinue === 'function' && (
              <button type="button" className="btn btn-outline btn-sm" onClick={onContinue} disabled={sending || regenerating}>
                <RefreshCw size={13} /> Continue response
              </button>
            )}
          </div>
        )}
        {!isUser && msg?.image && (
          <GeneratedImageBlock
            image={msg.image}
            onRegenerateImage={onRegenerateImage}
            regenerating={regenerating}
          />
        )}
        {isUser && Array.isArray(msg?.attachments) && msg.attachments.length > 0 && (
          <div className="user-attachments">
            {msg.attachments.map((a, i) => {
              const isObj = typeof a === 'object' && a !== null;
              const name = isObj ? a.name : a;
              const hasImage = isObj && Boolean(a.hasImage) && a.id;
              return (
                <span key={i} className="attachment-chip user-attachment-chip">
                  {hasImage ? <ImageThumb documentId={a.id} name={name} size={36} /> : <Paperclip size={11} />}
                  {name}
                </span>
              );
            })}
          </div>
        )}
        {resources.length > 0 && (
          <div className="resource-list">
            {resources.map((r, i) => <ResourceCard key={i} resource={r} />)}
          </div>
        )}
        {sources.length > 0 && !isUser && <SourcesSection sources={sources} />}
        {!isUser && (
          <AiActions
            plainText={messageToPlainText(msg)}
            speechText={markdownToSpeech(msg?.content || '')}
            onRegenerate={typeof onRegenerate === 'function' ? onRegenerate : undefined}
            regenerating={regenerating}
          />
        )}
      </div>
    </div>
  );
}

export function WelcomeBubble({ hasKnowledge }) {
  return (
    <div className="chat-welcome">
      <div className="chat-avatar ai"><Bot size={16} /></div>
      <div className="chat-bubble ai">
        <p><strong>Hey! I'm your AI companion. How can I help today?</strong></p>
        {hasKnowledge ? (
          <p>Think of me as a friendly companion who's great at career coaching, coding, learning resources and everyday questions — and I know your resume and target job, so career answers stay grounded in your documents.</p>
        ) : (
          <>
            <p>Think of me as a friendly companion for coding, explanations, learning resources, web lookups and everyday questions. Ask me anything.</p>
            <p className="warn-text">
              <FileText size={14} /> Upload your resume and add a job description to unlock your
              personalized knowledge base.
            </p>
          </>
        )}
      </div>
    </div>
  );
}