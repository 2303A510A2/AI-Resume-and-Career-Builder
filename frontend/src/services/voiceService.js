import api from './api';
import { speechRecognitionSupported } from './speechRecognition';

// Voice input and AI answer voice.
//
// INPUT: the composer speaks with the browser's Web Speech API
// (services/speechRecognition.js) because recognising audio as it arrives
// never loses a short utterance the way a record-then-transcribe round trip
// does. transcribeAudio() is kept as the fallback for browsers without the
// Web Speech API, so no browser is left without voice input.
//
// OUTPUT: the backend TTS when configured, else the browser speechSynthesis.

export { speechRecognitionSupported };

export const transcribeAudio = async (blob, filename = 'voice.webm', mimeType = 'audio/webm') => {
  const form = new FormData();
  form.append('audio', new File([blob], filename, { type: mimeType }));
  const { data } = await api.post('/ai/transcribe', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return String(data?.transcript || '').trim();
};

/** Returns an mp3 Blob or throws (the caller falls back to speechSynthesis). */
export const assistantSpeech = async (text) => {
  const { data } = await api.post('/ai/speech', { text }, { responseType: 'blob' });
  if (!data || data.size === 0) throw new Error('empty audio');
  return data;
};

export const mediaRecorderSupported = () =>
  typeof window !== 'undefined' && Boolean(window.MediaRecorder);

export const speechSynthesisSupported = () =>
  typeof window !== 'undefined' && Boolean(window.speechSynthesis);

// Rough intent heuristic so the typing label can say "Searching the web…"
// while a request that needs current/live content is in flight. Mirrors the
// backend's intentService keywords; never asserted as ground truth.
export const maySearchWeb = (question) => {
  const q = String(question || '').toLowerCase();
  return /(latest|news|current|this year|2026|places? to visit|things to do|tourist|websites?|where can i (find|practice|learn|play)|give me (websites|resources|platforms)|best \w+ (to|for)|top \d+|recommend|suggest|salary|market trends|courses|tutorials)/i.test(q);
};