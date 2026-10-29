const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { enforceAiLimits } = require('../middleware/aiUsageMiddleware');
const {
  careerAssistant,
  regenerateMessage,
  generateImage,
  getGeneratedImage,
  transcribeAudio,
  speech,
} = require('../controllers/aiController');
const { audioUpload } = require('../middleware/audioUploadMiddleware');

const router = express.Router();

// Unified real-AI chat: message + conversationId + documentIds, authenticated by
// JWT. Natural-language image requests are routed to real image generation
// inside this same endpoint, so the user never picks a mode.
router.post('/career-assistant', protect, enforceAiLimits, careerAssistant);
// Regenerate: re-run the last user question and replace the previous answer
// (for a generated image: generate a brand-new image from the same prompt).
router.post('/career-assistant/regenerate', protect, enforceAiLimits, regenerateMessage);

// Real image generation (backend provider call; the key never reaches the client).
router.post('/generate-image', protect, enforceAiLimits, generateImage);
// Stream the bytes of one generated image the caller owns (JWT + ownership).
router.get('/images/:id', protect, getGeneratedImage);

// Voice input: transcribe the recorded audio (Groq Whisper) -> transcript.
router.post('/transcribe', protect, enforceAiLimits, audioUpload.single('audio'), transcribeAudio);
// AI answer voice: convert text to speech bytes (Groq TTS when configured).
router.post('/speech', protect, enforceAiLimits, speech);

module.exports = router;