const multer = require('multer');
const path = require('path');

// Audio upload for voice input (/api/ai/transcribe). Accepts the mime types the
// browsers' MediaRecorder produces (webm, mp4, ogg) plus common audio files
// (mp3, wav, m4a). Executables and scripts are always rejected.

const ALLOWED_AUDIO = new Set([
  'audio/webm',
  'video/webm', // Chrome sometimes reports mixed tracks as video/webm
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/x-m4a',
  'audio/vnd.wave',
]);

const ALLOWED_EXT = ['webm', 'mp3', 'm4a', 'wav', 'ogg', 'mp4'];
const FORBIDDEN_EXT = ['exe', 'bat', 'cmd', 'ps1', 'sh', 'msi', 'dll', 'com', 'scr', 'hta', 'vbs', 'jar', 'php', 'py', 'cgi'];

const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB (a few minutes of webm)

const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().replace('.', '');
    if (FORBIDDEN_EXT.includes(ext)) {
      return cb(new Error(`Security: ${ext.toUpperCase()} files are not allowed.`));
    }
    if (ALLOWED_AUDIO.has(file.mimetype) || ALLOWED_EXT.includes(ext)) {
      file.extension = ext || 'audio';
      return cb(null, true);
    }
    cb(new Error('Unsupported audio format. Use WebM, MP3, M4A, WAV or OGG.'));
  },
});

module.exports = { audioUpload };