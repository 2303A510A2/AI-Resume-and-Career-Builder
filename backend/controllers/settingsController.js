const User = require('../models/User');
const Chat = require('../models/Chat');
const Document = require('../models/Document');
const Resume = require('../models/Resume');
const JobDescription = require('../models/JobDescription');
const Interview = require('../models/Interview');
const Roadmap = require('../models/Roadmap');
const RAGDocument = require('../models/RAGDocument');
const GeneratedImage = require('../models/GeneratedImage');
const OTP = require('../models/OTP');
const { isValidEmail, isValidPassword, sanitizeUser } = require('../utils/validators');

// ---------------------------------------------------------------------------
// Settings defaults + normalization
//
// Mongoose applies nested defaults only when a document is first created, so a
// user created before this feature existed would return a partial `settings`.
// Every read/write goes through normalizeSettings() so the API always returns
// one complete, well-typed object and the frontend never has to guess.
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  appearance: { theme: 'system', accent: 'violet' },
  chat: { enterToSend: true, confirmDelete: true, responseStyle: 'balanced', language: 'auto', voicePlayback: false },
  notifications: { product: false },
};

const THEMES = ['light', 'dark', 'system'];
const ACCENTS = ['violet', 'pink', 'indigo', 'teal', 'amber'];
const RESPONSE_STYLES = ['concise', 'balanced', 'detailed'];

const normalizeSettings = (raw) => {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ap = r.appearance || {};
  const ch = r.chat || {};
  const no = r.notifications || {};
  return {
    appearance: {
      theme: THEMES.includes(ap.theme) ? ap.theme : DEFAULT_SETTINGS.appearance.theme,
      accent: ACCENTS.includes(ap.accent) ? ap.accent : DEFAULT_SETTINGS.appearance.accent,
    },
    chat: {
      enterToSend: ch.enterToSend !== undefined ? Boolean(ch.enterToSend) : DEFAULT_SETTINGS.chat.enterToSend,
      confirmDelete: ch.confirmDelete !== undefined ? Boolean(ch.confirmDelete) : DEFAULT_SETTINGS.chat.confirmDelete,
      responseStyle: RESPONSE_STYLES.includes(ch.responseStyle) ? ch.responseStyle : DEFAULT_SETTINGS.chat.responseStyle,
      language: typeof ch.language === 'string' && ch.language.trim() ? ch.language.trim().slice(0, 40) : 'auto',
      voicePlayback: ch.voicePlayback !== undefined ? Boolean(ch.voicePlayback) : DEFAULT_SETTINGS.chat.voicePlayback,
    },
    notifications: {
      product: no.product !== undefined ? Boolean(no.product) : DEFAULT_SETTINGS.notifications.product,
    },
  };
};

// ---------------------------------------------------------------------------
// Avatar validation
//
// The bytes are stored as a base64 data URL. The client downscales the image
// before upload; the server still enforces type + size so a hand-crafted request
// can never store an arbitrary blob. We validate BOTH the declared mime and the
// base64 magic prefix (a plain text file relabelled as image/png is rejected).
// ---------------------------------------------------------------------------
const AVATAR_MAX_BYTES = 400 * 1024; // decoded size cap
const AVATAR_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
const MAGIC_PREFIXES = ['iVBORw0KGgo', '/9j/', 'UklGR'];

const validateAvatar = (dataUrl) => {
  if (dataUrl === '' || dataUrl === null) return { ok: true, value: '' };
  if (typeof dataUrl !== 'string') return { ok: false, message: 'Profile photo format is invalid.' };
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return { ok: false, message: 'Profile photo must be a PNG, JPG or WebP image.' };
  const mime = m[1].toLowerCase();
  if (!AVATAR_ALLOWED_MIME.includes(mime)) {
    return { ok: false, message: 'Profile photo must be a PNG, JPG or WebP image.' };
  }
  const b64 = m[2];
  if (!MAGIC_PREFIXES.some((p) => b64.startsWith(p))) {
    return { ok: false, message: 'That file does not look like a real image.' };
  }
  const bytes = Math.floor((b64.length * 3) / 4);
  if (bytes > AVATAR_MAX_BYTES) {
    return { ok: false, message: 'Profile photo is too large (max 400KB). Please choose a smaller image.' };
  }
  return { ok: true, value: dataUrl };
};

const settingsForClient = (user) => ({
  ...normalizeSettings(user.settings),
});

// @desc   Get the current user's profile + settings + light account stats
// @route  GET /api/settings   (protected)
const getSettings = async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const conversationCount = await Chat.countDocuments({ userId: user._id });
  res.json({
    success: true,
    user: sanitizeUser(user),
    settings: settingsForClient(user),
    stats: { conversationCount, memberSince: user.createdAt },
  });
};

// @desc   Update the user's own profile (name, email, bio, avatar)
// @route  PUT /api/settings/profile   (protected)
const updateProfileSettings = async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const { name, email, bio, avatar } = req.body || {};

  if (name !== undefined) {
    const clean = String(name).trim();
    if (!clean) return res.status(400).json({ success: false, message: 'Full name is required.' });
    if (clean.length > 100) return res.status(400).json({ success: false, message: 'Name is too long (max 100 characters).' });
    user.name = clean;
  }

  if (email !== undefined) {
    const clean = String(email).trim().toLowerCase();
    if (!isValidEmail(clean)) {
      return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    if (clean !== user.email) {
      const taken = await User.findOne({ email: clean, _id: { $ne: user._id } });
      if (taken) return res.status(409).json({ success: false, message: 'That email is already in use by another account.' });
      user.email = clean;
    }
  }

  if (bio !== undefined) {
    const clean = String(bio).trim();
    if (clean.length > 500) return res.status(400).json({ success: false, message: 'Bio is too long (max 500 characters).' });
    user.profile.bio = clean;
  }

  if (avatar !== undefined) {
    const result = validateAvatar(avatar);
    if (!result.ok) return res.status(400).json({ success: false, message: result.message });
    user.profile.avatar = result.value;
  }

  await user.save();
  res.json({ success: true, message: 'Profile updated.', user: sanitizeUser(user) });
};

// @desc   Update user preferences (appearance / chat / notifications)
// @route  PUT /api/settings/preferences   (protected)
const updatePreferences = async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const { appearance, chat, notifications } = req.body || {};
  const current = normalizeSettings(user.settings);

  if (appearance && typeof appearance === 'object') {
    if (appearance.theme !== undefined && !THEMES.includes(appearance.theme)) {
      return res.status(400).json({ success: false, message: 'Invalid theme.' });
    }
    if (appearance.accent !== undefined && !ACCENTS.includes(appearance.accent)) {
      return res.status(400).json({ success: false, message: 'Invalid accent colour.' });
    }
    if (appearance.theme !== undefined) current.appearance.theme = appearance.theme;
    if (appearance.accent !== undefined) current.appearance.accent = appearance.accent;
  }

  if (chat && typeof chat === 'object') {
    if (chat.responseStyle !== undefined && !RESPONSE_STYLES.includes(chat.responseStyle)) {
      return res.status(400).json({ success: false, message: 'Invalid response style.' });
    }
    if (chat.language !== undefined && String(chat.language).length > 40) {
      return res.status(400).json({ success: false, message: 'Language name is too long.' });
    }
    if (chat.enterToSend !== undefined) current.chat.enterToSend = Boolean(chat.enterToSend);
    if (chat.confirmDelete !== undefined) current.chat.confirmDelete = Boolean(chat.confirmDelete);
    if (chat.responseStyle !== undefined) current.chat.responseStyle = chat.responseStyle;
    if (chat.language !== undefined) current.chat.language = String(chat.language).trim() || 'auto';
    if (chat.voicePlayback !== undefined) current.chat.voicePlayback = Boolean(chat.voicePlayback);
  }

  if (notifications && typeof notifications === 'object') {
    if (notifications.product !== undefined) current.notifications.product = Boolean(notifications.product);
  }

  user.settings = current;
  user.markModified('settings');
  await user.save();

  res.json({ success: true, message: 'Preferences updated.', settings: current });
};

// @desc   Change the user's password (verifies the current one)
// @route  POST /api/settings/change-password   (protected)
const changePassword = async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};

  if (!currentPassword) {
    return res.status(400).json({ success: false, message: 'Your current password is required.' });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'New passwords do not match.' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ success: false, message: 'Your new password must be different from the current one.' });
  }

  const user = await User.findById(req.user.id).select('+password');
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const ok = await user.matchPassword(currentPassword);
  if (!ok) return res.status(400).json({ success: false, message: 'Your current password is incorrect.' });

  // Assigned in plaintext; the pre-save hook hashes it with bcrypt. The existing
  // JWT stays valid, so the user is NOT logged out by this change.
  user.password = newPassword;
  await user.save();

  res.json({ success: true, message: 'Password updated successfully.' });
};

// @desc   Export the authenticated user's own data as JSON
// @route  GET /api/settings/export   (protected)
const exportData = async (req, res) => {
  const userId = req.user.id;
  const user = await User.findById(userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const [chats, documents, resume, job, interviews, roadmap] = await Promise.all([
    Chat.find({ userId }).select('title messages createdAt updatedAt').lean(),
    Document.find({ userId }).select('fileName mimeType extension size category status createdAt').lean(),
    Resume.findOne({ userId }).select('fileName fileType fileSize parsed analysis createdAt').lean(),
    JobDescription.findOne({ userId }).select('jobTitle company parsed parsedAt createdAt').lean(),
    Interview.find({ userId }).select('type category title status averageScore questions answers createdAt updatedAt').lean(),
    Roadmap.findOne({ userId }).select('targetRole targetCompany phases progressPercent generatedAt createdAt').lean(),
  ]);

  const payload = {
    exportedAt: new Date().toISOString(),
    account: {
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      profile: user.profile,
    },
    settings: normalizeSettings(user.settings),
    conversations: chats.map((c) => ({
      id: c._id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: (c.messages || []).map((m) => ({ role: m.role, content: m.content, at: m.createdAt })),
    })),
    documents,
    resume: resume || null,
    jobDescription: job || null,
    interviews,
    roadmap: roadmap || null,
  };

  res.json({ success: true, data: payload });
};

// @desc   Delete ALL of the authenticated user's conversations (chat history)
// @route  POST /api/settings/clear-chats   (protected)
const clearChatHistory = async (req, res) => {
  const userId = req.user.id;
  // Conversations + the images they generated. Uploaded resumes / job
  // descriptions / documents are explicitly NOT touched here.
  const [chats] = await Promise.all([
    Chat.deleteMany({ userId }),
    GeneratedImage.deleteMany({ userId }),
  ]);
  res.json({
    success: true,
    message: `Deleted ${chats.deletedCount} conversation${chats.deletedCount === 1 ? '' : 's'}.`,
    deletedConversations: chats.deletedCount,
  });
};

// @desc   Permanently delete the account and ALL owned data (requires password)
// @route  DELETE /api/settings/account   (protected)
const deleteAccount = async (req, res) => {
  const { password } = req.body || {};
  if (!password) {
    return res.status(400).json({ success: false, message: 'Enter your password to confirm account deletion.' });
  }

  const user = await User.findById(req.user.id).select('+password');
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const ok = await user.matchPassword(password);
  if (!ok) return res.status(400).json({ success: false, message: 'Incorrect password. Account was not deleted.' });

  const userId = user._id;
  const email = user.email;

  // Ownership is enforced by userId on every collection. OTP records are keyed by
  // email, not userId.
  await Promise.all([
    Chat.deleteMany({ userId }),
    GeneratedImage.deleteMany({ userId }),
    Document.deleteMany({ userId }),
    Resume.deleteMany({ userId }),
    JobDescription.deleteMany({ userId }),
    Interview.deleteMany({ userId }),
    Roadmap.deleteMany({ userId }),
    RAGDocument.deleteMany({ userId }),
    OTP.deleteMany({ email }),
  ]);
  await User.deleteOne({ _id: userId });

  res.json({ success: true, message: 'Your account and all associated data have been deleted.' });
};

module.exports = {
  getSettings,
  updateProfileSettings,
  updatePreferences,
  changePassword,
  exportData,
  clearChatHistory,
  deleteAccount,
  // exported for the offline unit suite
  normalizeSettings,
  validateAvatar,
  DEFAULT_SETTINGS,
};
