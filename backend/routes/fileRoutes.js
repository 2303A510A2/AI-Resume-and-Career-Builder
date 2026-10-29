const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { upload, handleUploadError } = require('../middleware/uploadMiddleware');
const { upload: uploadFiles, list, remove, getImage } = require('../controllers/fileController');

const router = express.Router();

// Multer wrapper: collects any file field, applies middleware validation,
// and enforces the "max 10 files per request" rule with a clear message.
const withUpload = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) return handleUploadError(err, req, res, next);
    const files = req.files || (req.file ? [req.file] : []);
    if (!files.length) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    if (files.length > 10) {
      return res.status(400).json({ success: false, message: 'Maximum 10 files per upload.' });
    }
    req.uploadedFiles = files;
    next();
  });
};

router.post('/upload', protect, withUpload, uploadFiles);
router.get('/', protect, list);
router.get('/:id/image', protect, getImage);
router.delete('/:id', protect, remove);

module.exports = router;