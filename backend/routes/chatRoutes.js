const express = require('express');
const { protect } = require('../middleware/authMiddleware');
const { sendMessage, listChats, getChat, deleteChat, addMessage, searchChats } = require('../controllers/chatController');

const router = express.Router();

router.post('/', protect, sendMessage);
router.get('/', protect, listChats);
// /search must precede /:id so an Express route cannot read "search" as an id.
router.get('/search', protect, searchChats);
router.get('/:id', protect, getChat);
router.post('/:id/messages', protect, addMessage);
router.delete('/:id', protect, deleteChat);

module.exports = router;