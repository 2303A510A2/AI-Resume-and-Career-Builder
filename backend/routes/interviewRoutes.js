const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const {
  generateQuestions,
  startMock,
  answerMock,
  evaluate,
  listSessions,
  getSession,
  deleteSession,
} = require('../controllers/interviewController');

const router = express.Router();

router.post('/generate', protect, generateQuestions);
router.post('/mock/start', protect, startMock);
router.post('/mock/answer', protect, answerMock);
router.post('/evaluate', protect, evaluate);
router.get('/', protect, listSessions);
router.get('/:id', protect, getSession);
router.delete('/:id', protect, deleteSession);

module.exports = router;