const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { upload, handleUploadError } = require('../middleware/uploadMiddleware');
const {
  uploadResume,
  getResume,
  deleteResume,
  improveResume,
} = require('../controllers/resumeController');

const router = express.Router();

router.post('/upload', protect, upload.single('resume'), uploadResume, handleUploadError);
router.get('/', protect, getResume);
router.delete('/', protect, deleteResume);
router.post('/improve', protect, improveResume);

module.exports = router;