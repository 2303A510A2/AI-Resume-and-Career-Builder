// Unit tests for the speech-capture fix (frontend/src/services/speechRecognition.js).
// Run: node scripts/speechCaptureTest.mjs      (no browser, no network, no backend)
//
// A FakeSpeechRecognition lets us replay exactly the event sequences that broke
// voice input in production:
//   * a fast stop that produced an empty recording (the old "I couldn't understand
//     the audio" bug),
//   * interim text arriving before the final result,
//   * the browser firing onend on its own silence timeout AFTER real speech,
//   * the Web Speech API 'no-speech' error meaning "heard nothing this window",
//   * a denied microphone permission.
//
// The module is deliberately framework-agnostic so plain Node can import it.
/* eslint-disable no-console */
import {
  createSpeechCapture,
  classifySpeechError,
  speechErrorMessage,
  speechRecognitionSupported,
  getSpeechRecognitionCtor,
} from '../src/services/speechRecognition.js';

const mod = await import('../src/services/speechRecognition.js');

let passed = 0;
let failed = 0;
const failures = [];

const check = (name, ok, extra = '') => {
  if (ok) {
    passed += 1;
    console.log(`  OK   ${name}${extra ? ` — ${extra}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`);
  }
};

/** Minimal stand-in for the Web Speech API. */
class FakeSpeechRecognition {
  constructor() {
    this.lang = '';
    this.continuous = false;
    this.interimResults = false;
    this.maxAlternatives = 1;
    this.state = 'inactive';
    FakeSpeechRecognition.instances.push(this);
  }

  start() {
    this.state = 'listening';
    if (FakeSpeechRecognition.startError) {
      const err = FakeSpeechRecognition.startError;
      FakeSpeechRecognition.startError = null;
      setTimeout(() => this.onerror?.({ error: err }), 0);
      return;
    }
    setTimeout(() => this.onstart?.({}), 0);
  }

  stop() {
    this.state = 'stopped';
    setTimeout(() => this.onend?.({}), 0);
  }

  abort() {
    this.state = 'aborted';
    setTimeout(() => this.onend?.({}), 0);
  }

  /** results: [[{ transcript, confidence }], ...]; isFinal per entry. */
  emit(results) {
    const mapped = results.map(([alt, isFinal]) => {
      const entry = [{ transcript: alt, confidence: 0.94 }];
      entry.isFinal = Boolean(isFinal);
      entry.length = 1;
      return entry;
    });
    mapped.resultIndex = 0;
    this.onresult?.({ results: mapped, resultIndex: 0 });
  }

  error(code) {
    this.onerror?.({ error: code });
  }

  end() {
    this.state = 'stopped';
    this.onend?.({});
  }
}
FakeSpeechRecognition.instances = [];
FakeSpeechRecognition.startError = null;

const tick = () => new Promise((r) => setTimeout(r, 5));

const collect = () => {
  const seen = { started: 0, interim: [], final: [], ends: [], errors: [] };
  return {
    seen,
    handlers: {
      onStart: () => { seen.started += 1; },
      onInterim: (t) => seen.interim.push(t),
      onFinal: (t) => seen.final.push(t),
      onEnd: (e) => seen.ends.push(e),
      onError: (outcome, message) => seen.errors.push({ outcome, message }),
    },
  };
};

const last = (arr) => (arr.length ? arr[arr.length - 1] : undefined);

// ---------------------------------------------------------------------------
console.log('\n1) Browser support detection');
{
  const withApi = getSpeechRecognitionCtor({ SpeechRecognition: FakeSpeechRecognition });
  const prefixed = getSpeechRecognitionCtor({ webkitSpeechRecognition: FakeSpeechRecognition });
  const none = getSpeechRecognitionCtor({});
  check('detects window.SpeechRecognition', withApi === FakeSpeechRecognition);
  check('detects window.webkitSpeechRecognition (Safari)', prefixed === FakeSpeechRecognition);
  check('returns null when the browser has no speech API', none === null);
  check('speechRecognitionSupported() reflects that', speechRecognitionSupported({}) === false && speechRecognitionSupported({ webkitSpeechRecognition: FakeSpeechRecognition }) === true);
  let threw = null;
  try {
    createSpeechCapture({ recognition: null, scope: {} });
  } catch (e) {
    threw = e;
  }
  check('createSpeechCapture refuses to run without the API', threw?.outcome === 'unsupported');
}

// ---------------------------------------------------------------------------
console.log('\n2) The production bug: speech recognised, but the transcript was lost');
{
  FakeSpeechRecognition.instances = [];
  const { seen, handlers } = collect();
  const cap = createSpeechCapture({ ...handlers, recognition: FakeSpeechRecognition });
  await tick();
  check('onstart fired exactly once', seen.started === 1);

  // Interim words first, exactly as Chrome reports them while the user speaks.
  cap.recognition.emit([['what is a ', false]]);
  await tick();
  check('interim transcript is shown live', last(seen.interim) === 'what is a', `interim="${last(seen.interim)}"`);
  cap.recognition.emit([['what is a ', false], ['hash map ', false]]);
  await tick();
  check('interim grows while the user keeps talking', last(seen.interim) === 'what is a hash map');

  // The recogniser finalises the phrase, then the user taps stop. The old
  // MediaRecorder path lost the words here (empty/too-short clip -> empty
  // Whisper transcript -> "I couldn't understand the audio").
  cap.recognition.emit([['what is a hash map ', true]]);
  await tick();
  cap.stop();
  await tick();
  check('onend delivered the spoken words', last(seen.ends)?.transcript === 'what is a hash map', JSON.stringify(last(seen.ends)));
  check('onend fired exactly once', seen.ends.length === 1);
  check('no error was raised for a successful capture', seen.errors.length === 0);
  check('cap.getTranscript() still holds the words', cap.getTranscript() === 'what is a hash map');
}

// ---------------------------------------------------------------------------
console.log('\n3) Interim + final merge, with no duplicated words');
{
  FakeSpeechRecognition.instances = [];
  const { seen, handlers } = collect();
  const cap = createSpeechCapture({ ...handlers, recognition: FakeSpeechRecognition });
  await tick();

  cap.recognition.emit([['what is a hash map ', false]]);
  cap.recognition.emit([['what is a hash map ', false], ['in java ', false]]);
  await tick();
  check('interim text grows without repeating', last(seen.interim) === 'what is a hash map in java', `interim="${last(seen.interim)}"`);
  check('nothing was committed as final while interim', seen.final.length === 0);

  // The browser finalises the first entry and keeps the second one interim.
  cap.recognition.emit([['what is a hash map ', true], ['in java ', false]]);
  await tick();
  check('final transcript holds only final words', last(seen.final) === 'what is a hash map', `final="${last(seen.final)}"`);
  check('interim words are still shown next to the final text', last(seen.interim) === 'what is a hash map in java', `interim="${last(seen.interim)}"`);

  cap.recognition.emit([['what is a hash map ', true], ['in java ', true]]);
  await tick();
  check('final text is not duplicated when the result repeats', last(seen.final) === 'what is a hash map in java', `final="${last(seen.final)}"`);
  check('repeated onresult does not double the words', (last(seen.final).match(/java/g) || []).length === 1);

  cap.stop();
  await tick();
  check('stop() delivers the complete transcript', last(seen.ends)?.transcript === 'what is a hash map in java', JSON.stringify(last(seen.ends)));
  check('a real transcript is not reported as "no speech"', last(seen.ends)?.outcome === 'ok');
  check('no error is surfaced when words were recognised', seen.errors.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n4) Multiple final segments arrive in separate onresult events');
{
  FakeSpeechRecognition.instances = [];
  const { seen, handlers } = collect();
  const cap = createSpeechCapture({ ...handlers, recognition: FakeSpeechRecognition });
  await tick();
  cap.recognition.emit([['give me ', true]]);
  await tick();
  cap.recognition.emit([['give me ', true], ['ten java interview questions', true]]);
  await tick();
  cap.stop();
  await tick();
  check('segments accumulate across events', last(seen.ends)?.transcript === 'give me ten java interview questions', JSON.stringify(last(seen.ends)?.transcript));
}

// ---------------------------------------------------------------------------
console.log('\n5) onend after real speech is NOT "no speech"');
{
  FakeSpeechRecognition.instances = [];
  const { seen, handlers } = collect();
  const cap = createSpeechCapture({ ...handlers, recognition: FakeSpeechRecognition });
  await tick();
  cap.recognition.emit([['explain polymorphism', true]]);
  await tick();
  // The browser's silence timeout fires onend with no further speech.
  cap.recognition.end();
  await tick();
  check('transcript survives the silence timeout', last(seen.ends)?.transcript === 'explain polymorphism');
  check('outcome is ok, not no-speech', last(seen.ends)?.outcome === 'ok');
  check('"No speech detected" is NOT shown', seen.errors.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n6) A genuine empty session reports "No speech detected"');
{
  FakeSpeechRecognition.instances = [];
  const { seen, handlers } = collect();
  const cap = createSpeechCapture({ ...handlers, recognition: FakeSpeechRecognition });
  await tick();
  cap.recognition.error('no-speech');
  await tick();
  cap.recognition.end();
  await tick();
  check('empty transcript is delivered as empty', last(seen.ends)?.transcript === '');
  check('outcome is no-speech', last(seen.ends)?.outcome === 'no-speech');
  check('exactly one honest error is reported', seen.errors.length === 1 && seen.errors[0].outcome === 'no-speech', JSON.stringify(seen.errors));
  check('the message is the specific "No speech detected" copy', seen.errors[0]?.message.startsWith('No speech detected'));
}

// ---------------------------------------------------------------------------
console.log('\n7) The browser stops with only INTERIM text (the fast-tap case)');
{
  FakeSpeechRecognition.instances = [];
  const { seen, handlers } = collect();
  const cap = createSpeechCapture({ ...handlers, recognition: FakeSpeechRecognition });
  await tick();
  cap.recognition.emit([['how do i reverse a string', false]]);
  await tick();
  cap.stop();
  // The recogniser promotes the pending interim entry to final just before ending.
  cap.recognition.emit([['how do i reverse a string', true]]);
  await tick();
  check('pending interim words are recovered, not thrown away', last(seen.ends)?.transcript === 'how do i reverse a string', JSON.stringify(last(seen.ends)));
  check('and no error is raised', seen.errors.length === 0);
}

// ---------------------------------------------------------------------------
console.log('\n8) Real failures are reported honestly (never as "no speech")');
{
  for (const [code, outcome] of [
    ['not-allowed', 'permission-denied'],
    ['service-not-allowed', 'permission-denied'],
    ['audio-capture', 'no-microphone'],
    ['network', 'network'],
    ['language-not-supported', 'unsupported'],
  ]) {
    FakeSpeechRecognition.instances = [];
    const { seen, handlers } = collect();
    const cap = createSpeechCapture({ ...handlers, recognition: FakeSpeechRecognition });
    await tick();
    cap.recognition.error(code);
    cap.recognition.end();
    await tick();
    check(`"${code}" -> ${outcome}`, seen.errors[0]?.outcome === outcome, JSON.stringify(seen.errors[0]));
    check(`"${code}" message is specific`, !seen.errors[0]?.message.startsWith('No speech detected'));
  }
  check('classifySpeechError("no-speech") with existing finals is ok', classifySpeechError({ error: 'no-speech' }, true) === 'ok');
  check('classifySpeechError("no-speech") without finals is no-speech', classifySpeechError({ error: 'no-speech' }, false) === 'no-speech');
  check('classifySpeechError("aborted") with existing finals is ok', classifySpeechError({ error: 'aborted' }, true) === 'ok');
  check('unknown message never mentions speech detection', !speechErrorMessage('unknown').startsWith('No speech detected'));
}

// ---------------------------------------------------------------------------
console.log('\n9) Permission denied at start() still reports the error');
{
  FakeSpeechRecognition.instances = [];
  FakeSpeechRecognition.startError = 'not-allowed';
  const { seen, handlers } = collect();
  const cap = createSpeechCapture({ ...handlers, recognition: FakeSpeechRecognition });
  await tick();
  cap.recognition.end();
  await tick();
  check('start-time permission error is surfaced', seen.errors[0]?.outcome === 'permission-denied', JSON.stringify(seen.errors));
  FakeSpeechRecognition.startError = null;
}

// ---------------------------------------------------------------------------
console.log('\n10) Nothing here ever sends a message (no network surface)');
{
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/services/speechRecognition.js', import.meta.url), 'utf8')
  );
  // Strip comments: the header explains the old MediaRecorder bug, and prose
  // about it must not be mistaken for live code.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('module never calls fetch', !/\bfetch\s*\(/.test(code));
  check('module never asks for the microphone (no MediaRecorder path)', !/getUserMedia|MediaRecorder/.test(code));
  check('module never submits or auto-sends', !/(autoSend|sendMessage|onSubmit)\s*[:=(]/.test(code));
  check('module only exposes speech capture + detection helpers', Object.keys(mod).sort().join(',') === 'classifySpeechError,createSpeechCapture,default,getSpeechRecognitionCtor,speechErrorMessage,speechRecognitionSupported', Object.keys(mod).sort().join(','));
}

// ---------------------------------------------------------------------------
console.log('\n========================================');
console.log(`RESULTS: ${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
process.exit(failed ? 1 : 0);