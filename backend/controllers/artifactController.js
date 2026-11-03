const Artifact = require('../models/Artifact');
const storage = require('../services/artifactStorageService');
const {
  createArtifacts, toClient, cleanFormats, safeTitle, imagePromptsFromRequest, slideCountFromRequest,
} = require('../services/artifactService');
const list = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const filter = { ownerId: req.user.id };
  const [total, artifacts] = await Promise.all([
    Artifact.countDocuments(filter),
    Artifact.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).select('-objectKey'),
  ]);
  res.json({ success: true, page, limit, total, hasMore: page * limit < total, artifacts });
};

const generateArtifact = async (req, res) => {
  const {
    title, description, format, formats, content, artifactType, imagePrompts, requestId,
  } = req.body || {};
  const requested = Array.isArray(formats) ? formats : [format];
  const formatsToCreate = cleanFormats(requested);
  if (!formatsToCreate.length) return res.status(400).json({ success: false, code: 'INVALID_FORMAT', message: 'Choose PDF, DOCX, PPTX, XLSX or CSV.' });
  if (content == null || (typeof content === 'string' && !content.trim())) {
    return res.status(400).json({ success: false, code: 'CONTENT_REQUIRED', message: 'Document content is required.' });
  }

  const artifacts = await createArtifacts({
    ownerId: req.user.id,
    title: safeTitle(title),
    description,
    formats: formatsToCreate,
    content,
    artifactType,
    imagePrompts: Array.isArray(imagePrompts) ? imagePrompts : imagePromptsFromRequest(title || content),
    requestId: String(requestId || req.requestId || ''),
    slideCount: slideCountFromRequest(title || content),
  });

  res.status(201).json({
    success: true,
    artifacts: artifacts.map(toClient),
  });
};

const download = async (req, res) => {
  const artifact = await Artifact.findOne({ _id: req.params.id, ownerId: req.user.id });
  if (!artifact) return res.status(404).json({ success: false, code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found.' });
  const buffer = await storage.read(artifact.objectKey);
  res.set({
    'Content-Type': artifact.mimeType,
    'Content-Length': String(buffer.length),
    'Content-Disposition': `attachment; filename="${artifact.title.replace(/[^A-Za-z0-9._ -]/g, '_')}.${artifact.extension}"`,
    'Cache-Control': 'private, no-store',
  });
  res.send(buffer);
};

const remove = async (req, res) => {
  const artifact = await Artifact.findOneAndDelete({ _id: req.params.id, ownerId: req.user.id });
  if (!artifact) return res.status(404).json({ success: false, code: 'ARTIFACT_NOT_FOUND', message: 'Artifact not found.' });
  await storage.remove(artifact.objectKey);
  res.json({ success: true, message: 'Artifact deleted.' });
};

module.exports = { list, generateArtifact, download, remove };
