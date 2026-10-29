// Generic document upload for the AI Career Assistant.
// POST /api/files/upload  -> stores the file + extracted text, returns a real document id.
// GET  /api/files         -> lists the caller's own documents.
// DELETE /api/files/:id   -> deletes one of the caller's own documents.

const Document = require('../models/Document');
const Resume = require('../models/Resume');
const JobDescription = require('../models/JobDescription');
const { extractText } = require('../services/documentParser');
const { extractStructured } = require('../services/resumeParser');
const { parseJob } = require('../services/jobParser');
const { syncKnowledgeBase, indexDocumentText } = require('../services/ragService');
const usageService = require('../services/usageService');

// Lightweight filename classifier (mirrors the frontend): resume/cv -> resume,
// job/jd/description -> jd, otherwise document.
const classifyName = (name) => {
  const lower = String(name || '').toLowerCase();
  if (/resume|cv\b|curriculum/.test(lower)) return 'resume';
  if (/job|jd\b|descri|requirement|vacan/.test(lower)) return 'jd';
  return 'document';
};

// @desc   Upload file(s) -> extract text -> store document + feed RAG knowledge base
// @route  POST /api/files/upload   (protected)
const upload = async (req, res) => {
  const files = req.uploadedFiles || (req.file ? [req.file] : []);
  if (!files.length) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  // category comes from the frontend (resume | jd | document); never trustable for
  // ownership, but fine for classification. Fall back to filename heuristics.
  const requestedCategory = typeof req.body?.category === 'string' ? req.body.category.toLowerCase() : '';

  const results = [];
  for (const file of files) {
    const extension = String(file.extension || '').toLowerCase();
    const category = ['resume', 'jd', 'document'].includes(requestedCategory)
      ? requestedCategory
      : classifyName(file.originalname);

    const { text, imageData, status, note } = await extractText({ buffer: file.buffer, extension });
    if (status === 'failed') usageService.trackResumeFailure();

    const doc = await Document.create({
      userId: req.user.id,
      conversationId: null,
      fileName: file.originalname,
      mimeType: file.mimetype,
      extension,
      size: file.size,
      category,
      text,
      ...(imageData ? { imageData } : {}),
      status,
      processingNote: note,
      metadata: { uploadedVia: 'files-upload', originalExtension: extension },
    });

    // Keep the existing "user knowledge base" (Resume + JobDescription) in sync so
    // resume/jd analysis and RAG keep working with the original architecture.
    if (category === 'resume' && status === 'ready') {
      await Resume.findOneAndUpdate(
        { userId: req.user.id },
        {
          userId: req.user.id,
          fileName: file.originalname,
          fileType: extension,
          fileSize: file.size,
          originalText: text,
          parsed: extractStructured(text) || {},
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } else if (category === 'jd' && status === 'ready') {
      await JobDescription.findOneAndUpdate(
        { userId: req.user.id },
        {
          userId: req.user.id,
          jobTitle: 'Position from uploaded file',
          company: '',
          description: text,
          parsed: parseJob({ jobTitle: 'Position from uploaded file', company: '', description: text }) || {},
          parsedAt: new Date(),
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    // Rebuild the canonical resume+job knowledge base when a resume/JD changed.
    if (category === 'resume' || category === 'jd') {
      const resumeModel = category === 'resume' ? await Resume.findOne({ userId: req.user.id }) : await Resume.findOne({ userId: req.user.id });
      const jobModel = category === 'jd' ? await JobDescription.findOne({ userId: req.user.id }) : await JobDescription.findOne({ userId: req.user.id });
      await syncKnowledgeBase({ userId: req.user.id, resume: resumeModel, job: jobModel });
    }

    // Additionally index extracted text from this document (source: 'document') into RAG.
    if (status === 'ready' && text) {
      await indexDocumentText({ userId: req.user.id, documentId: doc._id, fileName: doc.fileName, text });
    }

    results.push(doc.toClientJSON());
  }

  res.status(201).json({
    success: true,
    message: results.length === 1
      ? results[0].status === 'ready'
        ? 'File uploaded and text extracted.'
        : 'File uploaded. Text extraction pending.'
      : `${results.length} files uploaded.`,
    document: results.length === 1 ? results[0] : results,
  });
};

// @desc   List the caller's own documents (safe projection, no extracted text)
// @route  GET /api/files
const list = async (req, res) => {
  const docs = await Document.find({ userId: req.user.id }).sort({ createdAt: -1 });
  res.json({ success: true, documents: docs.map((d) => d.toClientJSON()) });
};

// @desc   Delete one of the caller's own documents
// @route  DELETE /api/files/:id
const remove = async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, userId: req.user.id });
  if (!doc) {
    return res.status(404).json({ success: false, message: 'Document not found' });
  }
  await doc.deleteOne();
  res.json({ success: true, message: 'Document deleted.' });
};

// @desc   Return the stored image bytes of one of the caller's own documents
//         (used by the frontend to preview attached images in chat).
// @route  GET /api/files/:id/image  (protected, ownership-checked)
const getImage = async (req, res) => {
  const doc = await Document.findOne({ _id: req.params.id, userId: req.user.id }).select('+imageData');
  if (!doc) {
    return res.status(404).json({ success: false, message: 'Document not found' });
  }
  if (!doc.imageData) {
    return res.status(404).json({ success: false, message: 'No image stored for this document' });
  }
  const comma = doc.imageData.indexOf(',');
  const meta = comma > 0 ? doc.imageData.slice(0, comma) : '';
  const mime = /^data:([^;]+);/.test(meta) ? meta.match(/^data:([^;]+);/)[1] : doc.mimeType || 'image/png';
  const bytes = Buffer.from(doc.imageData.slice(comma + 1), 'base64');
  res.set('Content-Type', mime);
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(bytes);
};

module.exports = { upload, list, remove, getImage };