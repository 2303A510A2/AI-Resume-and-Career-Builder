const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  getSettings,
  updateProfileSettings,
  updatePreferences,
  changePassword,
  exportData,
  clearChatHistory,
  deleteAccount,
} = require('../controllers/settingsController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// Password / account-deletion endpoints are sensitive: cap them so a stolen
// token cannot be used to brute-force the current password.
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please try again later.' },
});

// Every route is scoped to the authenticated user (req.user.id from the JWT).
// A user can only ever read or modify their own profile, data and settings.
router.get('/', protect, getSettings);
router.put('/profile', protect, updateProfileSettings);
router.put('/preferences', protect, updatePreferences);
router.post('/change-password', protect, sensitiveLimiter, changePassword);
router.get('/export', protect, exportData);
router.post('/clear-chats', protect, clearChatHistory);
router.delete('/account', protect, sensitiveLimiter, deleteAccount);

module.exports = router;
