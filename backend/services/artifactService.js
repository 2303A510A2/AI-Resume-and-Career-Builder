const Artifact = require('../models/Artifact');
const storage = require('./artifactStorageService');
const { generate, TYPES } = require('./documentGenerator');
const imageService = require('./imageService');

const MAX_BYTES = Number(process.env.ARTIFACT_MAX_BYTES || 15 * 1024 * 1024);
const allowedFormats = new Set(Object.keys(TYPES));

const cleanFormats = (formats) => [...new Set((Array.isArray(formats) ? formats : [formats])
  .map((item) => String(item || '').toLowerCase().replace(/^\./, ''))
  .filter((item) => allowedFormats.has(item)))];

const safeTitle = (value) => String(value || 'Generated document').trim().slice(0, 200) || 'Generated document';

const formatsFromRequest = (value) => {
  const text = String(value || '').toLowerCase();
  const aliases = {
    pdf: /\bpdf\b/,
    docx: /\b(?:docx?|word)\b/,
    pptx: /\b(?:pptx?|powerpoint|presentation|slide\s+deck)\b/,
    xlsx: /\b(?:xlsx?|excel|spreadsheet)\b/,
    csv: /\bcsv\b/,
  };
  return Object.entries(aliases).filter(([, pattern]) => pattern.test(text)).map(([format]) => format);
};

const imagePromptsFromRequest = (value) => {
  const text = String(value || '').trim();
  if (!/\b(with|include|including|containing|add)\b[\s\S]{0,40}\b(images?|illustrations?|diagrams?|charts?|visuals?)\b/i.test(text)) return [];
  const subject = text
    .replace(/\b(create|make|generate|write|prepare|export|download)\b/gi, '')
    .replace(/\b(a|an|the)\b/gi, '')
    .replace(/\b(with|include|including|containing|add)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
  const requestedCount = Number(text.match(/\b(\d+)\s+(?:images?|illustrations?|diagrams?|visuals?)\b/i)?.[1] || 1);
  const count = Math.min(6, Math.max(1, requestedCount));
  return subject
    ? Array.from({ length: count }, (_, index) => `Professional original educational visual ${index + 1} for: ${subject}`)
    : [];
};

const slideCountFromRequest = (value) => {
  const count = Number(String(value || '').match(/\b(\d+)\s+slides?\b/i)?.[1] || 0);
  return count > 0 ? Math.min(100, count) : 0;
};

const generateArtifactImages = async (prompts, requestId = '') => Promise.all(prompts.slice(0, 6).map(async (prompt, index) => {
  const generated = await imageService.generate({ prompt, requestId: requestId ? `${requestId}-artifact-${index + 1}` : '' });
  return {
    buffer: generated.buffer,
    mimeType: generated.mimeType,
    width: generated.width,
    height: generated.height,
    caption: prompt,
  };
}));

const createArtifacts = async ({
  ownerId, title, description = '', formats, content, artifactType = '', imagePrompts = [], requestId = '', slideCount = 0,
}) => {
  const requested = cleanFormats(formats);
  if (!requested.length) {
    const error = new Error('Choose PDF, DOCX, PPTX, XLSX or CSV.');
    error.code = 'INVALID_FORMAT';
    error.statusCode = 400;
    throw error;
  }
  const label = safeTitle(title);
  const created = [];
  let enrichedContent = content;
  const needsImages = requested.some((format) => format === 'docx' || format === 'pptx') && imagePrompts.length;
  if (needsImages) {
    const source = typeof content === 'object' && content ? content : { text: String(content || '') };
    const images = await generateArtifactImages(imagePrompts, requestId);
    enrichedContent = { ...source, images, ...(slideCount ? { slideCount } : {}) };
  } else if (slideCount && content && typeof content === 'object') {
    enrichedContent = { ...content, slideCount };
  }
  try {
    for (const format of requested) {
      const generated = await generate({ title: label, format, content: enrichedContent });
      if (generated.buffer.length > MAX_BYTES) {
        const error = new Error('Generated artifact exceeds the configured size limit.');
        error.code = 'ARTIFACT_TOO_LARGE';
        error.statusCode = 413;
        throw error;
      }
      const stored = await storage.put(generated.buffer, generated.extension);
      try {
        created.push(await Artifact.create({
          ownerId,
          title: label,
          description: String(description).slice(0, 1000),
          artifactType: artifactType || generated.artifactType,
          mimeType: generated.mimeType,
          extension: generated.extension,
          objectKey: stored.objectKey,
          storageProvider: stored.storageProvider,
          fileSize: generated.buffer.length,
          metadata: { generated: true },
        }));
      } catch (error) {
        await storage.remove(stored.objectKey);
        throw error;
      }
    }
  } catch (error) {
    await Promise.all(created.map((artifact) => storage.remove(artifact.objectKey)));
    await Artifact.deleteMany({ _id: { $in: created.map((artifact) => artifact._id) }, ownerId });
    throw error;
  }
  return created;
};

const toClient = (artifact) => ({
  ...artifact.toObject(),
  downloadUrl: `/api/artifacts/${artifact._id}/download`,
});

module.exports = {
  createArtifacts, toClient, cleanFormats, formatsFromRequest, imagePromptsFromRequest,
  slideCountFromRequest, generateArtifactImages, safeTitle, MAX_BYTES,
};
