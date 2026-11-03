const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { list, generateArtifact, download, remove } = require('../controllers/artifactController');

const router = express.Router();
router.use(protect);
router.post('/generate', generateArtifact);
router.get('/', list);
router.get('/:id/download', download);
router.delete('/:id', remove);

module.exports = router;
