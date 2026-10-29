// Real document text extraction. Never pretends a file was read:
// - PDF  -> pdf-parse
// - DOCX -> mammoth (DOC falls back to raw UTF-8 text attempt)
// - TXT  -> raw UTF-8 text
// - PNG/JPG/JPEG -> text extraction is not applicable; when the image is small
//   enough (LLM_VISION_MAX_IMAGE_BYTES) the bytes are stored as a base64 data
//   URL (`imageData`) so a vision-capable AI model can analyze the ACTUAL image
//   in chat. Pixels are only sent when the configured provider/model is truly
//   vision-capable (providers.isVisionEnabled); otherwise the chat assistant
//   honestly says it cannot see the image. Larger images are stored with an
//   honest "uploaded" note.

const { parseTextFromBuffer } = require('./resumeParser');
const providers = require('./providers');

const TEXT_EXT = ['pdf', 'doc', 'docx', 'txt'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg'];

const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

/**
 * @param {{ buffer: Buffer, extension: string }} input
 * @returns {Promise<{ text: string, imageData?: string, status: 'ready'|'uploaded'|'failed', note: string }>}
 */
const extractText = async ({ buffer, extension }) => {
  const ext = String(extension || '').toLowerCase();

  if (TEXT_EXT.includes(ext)) {
    try {
      const text = await parseTextFromBuffer({ buffer, extension: ext });
      const trimmed = String(text || '').trim();
      if (!trimmed) {
        return { text: '', status: 'failed', note: `Unable to extract any text from this ${ext.toUpperCase()}. The file may be image-only or empty.` };
      }
      return { text: trimmed, status: 'ready', note: '' };
    } catch (err) {
      return {
        text: '',
        status: 'failed',
        note: `Unable to extract text from this ${ext.toUpperCase()}: ${err.message || 'processing error'}`,
      };
    }
  }

  if (IMAGE_EXT.includes(ext)) {
    const rawSize = buffer ? buffer.length : 0;
    const cap = providers.visionMaxImageBytes();
    const visionOn = providers.isVisionEnabled();
    if (rawSize > 0 && rawSize <= cap) {
      // Small enough for AI vision analysis: keep the real pixels (base64 data URL).
      const mime = IMAGE_MIME[ext] || 'image/png';
      const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
      return {
        text: '',
        imageData: dataUrl,
        status: 'ready',
        note: visionOn
          ? `Image stored for AI vision analysis (${(rawSize / 1024 / 1024).toFixed(2)} MB).`
          : `Image stored (${(rawSize / 1024 / 1024).toFixed(2)} MB). The currently configured AI model cannot analyze images — upload it as a PDF or text file, or enable a vision-capable provider.`,
      };
    }
    return {
      text: '',
      status: 'uploaded',
      note:
        rawSize > cap
          ? `This image is too large for AI vision analysis (max ${(cap / 1024 / 1024).toFixed(1)} MB). It is stored and can still be attached as context, but the pixels will not be sent to the AI.`
          : 'OCR is not configured on this server, so the image text could not be extracted. The file is stored and can still be attached for context.',
    };
  }

  return { text: '', status: 'failed', note: 'Unsupported file type.' };
};

module.exports = { extractText, TEXT_EXT, IMAGE_EXT };