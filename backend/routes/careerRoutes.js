const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const {
  saveJob,
  getJob,
  deleteJob,
  analyze,
  skillGap,
  roadmapGenerate,
  roadmapGet,
  roadmapProgress,
  roadmapDelete,
  codingGenerate,
} = require('../controllers/careerController');

const router = express.Router();

// Job description
router.post('/jobs', protect, saveJob);
router.get('/jobs', protect, getJob);
router.delete('/jobs', protect, deleteJob);

// Analysis
router.post('/analyze', protect, analyze);
router.get('/skill-gap', protect, skillGap);

// Roadmap (spec paths: /api/roadmap/...)
router.post('/roadmap/generate', protect, roadmapGenerate);
router.get('/roadmap', protect, roadmapGet);
router.put('/roadmap/progress', protect, roadmapProgress);
router.delete('/roadmap', protect, roadmapDelete);

// Coding preparation (spec path: /api/coding/generate)
router.post('/coding/generate', protect, codingGenerate);

module.exports = router;