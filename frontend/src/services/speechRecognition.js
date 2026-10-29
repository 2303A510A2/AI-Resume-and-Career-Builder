// Speech capture for the chat composer.
//
// WHY THIS FILE EXISTS
// The composer used to record audio with MediaRecorder and post it to Whisper.
// That path fails in exactly the most common case: the user speaks, releases
// the button, and the recorder produces zero (or a too-short) chunk. Whisper
// then returns an empty transcript and the UI reports "I couldn't understand
// the audio" even though the speech was captured perfectly by the microphone.
// The Web Speech API recognises audio locally as it arrives, so it does not
// depend on a complete recording at all.
//
// HOW IT WORKS (and the rules that fix the bug)
//   * onstart       -> listening started.
//   * onresult      -> interim and final results are BOTH kept. Interim text is
//                      shown live; final text is appended to `finalTranscriptRef`
//                      exactly once, so words are never duplicated.
//   * onerror       -> 'no-speech' is NOT a failure: the session simply ended
//                      without words. It is reported as `noSpeech`, and only
//                      becomes a user-visible "No speech detected" when the
//                      final transcript is genuinely empty. A permission or
//                      network error is reported separately.
//   * onend         -> the browser always ends the session (silence timeout,
//                      stop(), or an error). It is NOT treated as "no speech"
//                      when final words already exist; those are delivered.
//   * stop()        -> returns the accumulated final transcript. The transcript
//                      is never cleared before the final result is processed.
//
// The returned transcript is placed into the normal composer input so the user
// can read and edit it. Nothing here ever sends a message.

/** Creates/returns the browser SpeechRecognition constructor, if any. */
export const getSpeechRecognitionCtor = (scope = typeof window !== 'undefined' ? window : undefined) => {
  if (!scope) return null;
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
};

export const speechRecognitionSupported = (scope) => Boolean(getSpeechRecognitionCtor(scope));

/** Joins words without doubling anything the user actually said. */
const joinWords = (...parts) =>
  parts
    .map((p) => String(p || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Normalises a Web Speech API error event into a machine-readable outcome.
 * 'no-speech' means the recogniser heard nothing at all in that window — it is
 * not an error worth showing when we already have final words.
 */
export const classifySpeechError = (event, hasFinalText) => {
  const code = String(event?.error || '').toLowerCase();
  switch (code) {
    case 'no-speech':
      return hasFinalText ? 'ok' : 'no-speech';
    case 'aborted':
      return hasFinalText ? 'ok' : 'aborted';
    case 'not-allowed':
    case 'service-not-allowed':
      return 'permission-denied';
    case 'audio-capture':
      return 'no-microphone';
    case 'network':
      return 'network';
    case 'bad-grammar':
    case 'language-not-supported':
      return 'unsupported';
    default:
      return hasFinalText ? 'ok' : 'unknown';
  }
};

const ERROR_TEXT = {
  'no-speech': 'No speech detected. Tap the microphone and speak while it is on.',
  aborted: 'Voice input stopped before anything was heard.',
  'permission-denied': 'Microphone permission is required for voice input.',
  'no-microphone': 'No microphone was found. Check your input device and try again.',
  network: 'Speech recognition lost its network connection. Type your message instead.',
  unsupported: 'Speech recognition is not available in this browser. Type your message instead.',
  unknown: 'Voice input failed. Please try again or type your message.',
};

/** Human-readable, honest copy for a classified outcome. */
export const speechErrorMessage = (outcome) => ERROR_TEXT[outcome] || ERROR_TEXT.unknown;

/**
 * Starts a speech recognition session.
 *
 * @param {object}  options
 * @param {function} options.onStart      called when recognition actually started
 * @param {function} options.onInterim    live (not yet final) transcript
 * @param {function} options.onFinal      the complete final transcript so far
 * @param {function} options.onEnd        ({ transcript, outcome }) when the session ends
 * @param {function} options.onError      (outcome, message) for real failures
 * @param {string}   options.lang         BCP-47 tag, default 'en-US'
 * @param {boolean}  options.continuous   keep listening after a pause (default true)
 * @param {object}   options.recognition  constructor override (tests)
 * @returns {{ stop:Function, abort:Function, isActive:Function, getTranscript:Function }}
 */
export const createSpeechCapture = ({
  onStart = () => {},
  onInterim = () => {},
  onFinal = () => {},
  onEnd = () => {},
  onError = () => {},
  lang = 'en-US',
  continuous = true,
  interimResults = true,
  maxAlternatives = 1,
  recognition = null,
  scope = typeof window !== 'undefined' ? window : undefined,
} = {}) => {
  const Ctor = recognition || getSpeechRecognitionCtor(scope);
  if (!Ctor) {
    const err = new Error('SpeechRecognition is not supported in this browser.');
    err.outcome = 'unsupported';
    throw err;
  }

  // Holds only FINAL, de-duplicated text. Never cleared until the session is
  // fully over, so a late onresult can still complete what was said.
  const finalTranscriptRef = { current: '' };
  const interimRef = { current: '' };
  const startedRef = { current: false };
  const stoppedRef = { current: false };
  const errorRef = { current: '' };
  const reportedRef = { current: '' };
  // The Web Speech API re-sends the whole results list on every onresult, so a
  // final entry that has already been committed must never be committed twice.
  const committedRef = { current: new Set() };

  const rec = new Ctor();
  rec.lang = lang;
  rec.continuous = continuous;
  rec.interimResults = interimResults;
  rec.maxAlternatives = maxAlternatives;

  const currentTranscript = () => joinWords(finalTranscriptRef.current, interimRef.current);

  const commitFinals = (results, resultIndex) => {
    let added = '';
    const from = Number.isInteger(resultIndex) && resultIndex >= 0 ? resultIndex : 0;
    for (let i = from; i < results.length; i += 1) {
      if (committedRef.current.has(i)) continue;
      const r = results[i];
      if (!r || !r.isFinal) continue;
      committedRef.current.add(i);
      const text = String((r[0] && r[0].transcript) || '').replace(/\s+/g, ' ').trim();
      if (text) added = joinWords(added, text);
    }
    if (added) {
      finalTranscriptRef.current = joinWords(finalTranscriptRef.current, added);
      onFinal(finalTranscriptRef.current);
    }
    return added;
  };

  rec.onstart = () => {
    startedRef.current = true;
    onStart();
  };

  rec.onresult = (event) => {
    const results = event?.results || [];
    commitFinals(results, event?.resultIndex);
    // Rebuild the interim text from only the not-yet-final entries, so interim
    // words are never appended twice.
    let interim = '';
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      if (!r || r.isFinal) continue;
      interim = joinWords(interim, String((r[0] && r[0].transcript) || ''));
    }
    interimRef.current = interim;
    onInterim(currentTranscript());
  };

  rec.onerror = (event) => {
    const outcome = classifySpeechError(event, Boolean(finalTranscriptRef.current));
    if (outcome === 'ok') return; // silence after real speech is not a failure
    if (reportedRef.current === outcome) return; // already surfaced once
    errorRef.current = outcome;
    reportedRef.current = outcome;
    onError(outcome, speechErrorMessage(outcome));
  };

  rec.onend = () => {
    // The browser ends the session on its own (silence timeout, stop, error).
    // Whatever was recognised is already in finalTranscriptRef — deliver it.
    interimRef.current = '';
    const transcript = finalTranscriptRef.current;
    const outcome = errorRef.current || (transcript ? 'ok' : 'no-speech');
    // "No speech detected" is only ever said when nothing was recognised AND the
    // user was not already told about a real failure.
    if (!transcript && outcome === 'no-speech' && !reportedRef.current) {
      reportedRef.current = 'no-speech';
      onError('no-speech', speechErrorMessage('no-speech'));
    }
    onEnd({ transcript, outcome });
  };

  rec.start();

  return {
    recognition: rec,
    getTranscript: currentTranscript,
    /** Stop cleanly and wait for the final onresult before onend fires. */
    stop() {
      stoppedRef.current = true;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    },
    /** Abandon the session entirely (no transcript is delivered). */
    abort() {
      stoppedRef.current = true;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
    },
    isActive: () => startedRef.current && !stoppedRef.current,
  };
};

export default createSpeechCapture;