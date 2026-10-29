const User = require('../models/User');
const AdminRequest = require('../models/AdminRequest');
const AuditLog = require('../models/AuditLog');
const Resume = require('../models/Resume');
const JobDescription = require('../models/JobDescription');
const Chat = require('../models/Chat');
const Interview = require('../models/Interview');
const Roadmap = require('../models/Roadmap');
const RAGDocument = require('../models/RAGDocument');
const GeneratedImage = require('../models/GeneratedImage');
const Document = require('../models/Document');
const OTP = require('../models/OTP');
const { sanitizeUser, isValidEmail, isValidPassword } = require('../utils/validators');
const { generateToken } = require('../utils/generateToken');
const { dbState } = require('../config/db');
const llmService = require('../services/llmService');
const embeddingService = require('../services/embeddingService');
const webSearchService = require('../services/webSearchService');
const voiceService = require('../services/voiceService');
const imageService = require('../services/imageService');
const audit = require('../services/auditService');
const usageService = require('../services/usageService');
const settingsService = require('../services/settingsService');
const notificationService = require('../services/notificationService');

const ADMIN_ROLES = ['co_admin', 'main_admin'];
const isAdminRole = (r) => ADMIN_ROLES.includes(r);
const PROTECTED_MAIN_ADMIN_EMAIL = 'metebharath4@gmail.com';
const isProtectedMainAdminAccount = (user) => {
  if (!user) return false;
  const email = String(user.email || '').trim().toLowerCase();
  const configuredEmail = String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  return user.role === 'main_admin'
    || email === PROTECTED_MAIN_ADMIN_EMAIL
    || Boolean(configuredEmail && email === configuredEmail);
};

const DEFAULT_COADMIN_PERMISSIONS = {
  manageUsers: true,
  deleteUsers: false,
  manageResumes: false,
  manageRequests: false,
  viewAudit: false,
  manageSettings: false,
};

const EMPTY_PERMISSIONS = {
  manageUsers: false,
  deleteUsers: false,
  manageResumes: false,
  manageRequests: false,
  viewAudit: false,
  manageSettings: false,
};

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const publicAdmin = (u) => ({
  _id: u._id,
  name: u.name,
  email: u.email,
  role: u.role,
  mustChangePassword: !!u.mustChangePassword,
  adminPermissions: u.adminPermissions || EMPTY_PERMISSIONS,
  adminApprovedAt: u.adminApprovedAt || null,
  adminApprovedBy: u.adminApprovedBy || null,
  isActive: u.isActive !== false,
  lastActiveAt: u.lastActiveAt || null,
  // Profile bits the admin console renders (avatar is a small base64 data URL,
  // never a filesystem path). No secrets are ever included here.
  profile: {
    avatar: (u.profile && u.profile.avatar) || '',
    bio: (u.profile && u.profile.bio) || '',
  },
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

// The official Main Admin Leader contact address, resolved from the database
// (falling back to the bootstrap env). It is the ONE contact address the admin
// settings page may display — never a secret, never another admin's private data.
const getMainAdminEmail = async () => {
  try {
    const m = await User.findOne({ role: 'main_admin' }).select('email').lean();
    if (m && m.email) return String(m.email).toLowerCase();
  } catch (err) {
    // fall through to env
  }
  return String(process.env.INITIAL_ADMIN_EMAIL || '').toLowerCase();
};

// Avatar (profile photo) validation. Accepts only a small base64 image data URL
// whose mime is a real image type; anything else is rejected so the client can
// show a clear message. Returns the cleaned string, '' to clear, or undefined
// when the value is present but invalid.
const AVATAR_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const MAX_AVATAR_BYTES = 400 * 1024;
const sanitizeAvatar = (val) => {
  const s = String(val || '').trim();
  if (!s) return '';
  const m = /^data:(image\/[a-zA-Z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(s);
  if (!m) return undefined;
  const mime = m[1].toLowerCase();
  if (!AVATAR_MIME.has(mime)) return undefined;
  const b64 = m[2].replace(/\s+/g, '');
  if (b64.length * 0.75 > MAX_AVATAR_BYTES) return undefined;
  return `data:${mime};base64,${b64}`;
};

const publicRequest = (r) => ({
  _id: r._id,
  userId: r.userId,
  name: r.name,
  email: r.email,
  reason: r.reason,
  status: r.status,
  reviewedByEmail: r.reviewedByEmail || '',
  reviewedAt: r.reviewedAt || null,
  decisionNote: r.decisionNote || '',
  createdAt: r.createdAt,
});

const issueAdminToken = (user) =>
  generateToken(user, process.env.ADMIN_JWT_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '8h', {
    av: Number(user.adminTokenVersion || 0),
    scope: 'admin',
  });

const safeProviderStatus = () => {
  const ai = llmService.providerStatus();
  return {
    backend: 'online',
    mongodb: dbState().label,
    aiProvider: ai.status,
    aiModel: ai.model,
    aiModelAvailable: ai.modelAvailable,
    embeddings: embeddingService.isConfigured() ? 'configured' : 'not-configured',
    webSearch: webSearchService.status(),
    vision: llmService.isVisionConfigured() ? 'configured' : 'not-configured',
    speechToText: voiceService.isSttConfigured() ? 'configured' : 'not-configured',
    textToSpeech: voiceService.isTtsConfigured() ? 'configured' : 'not-configured',
    imageGeneration: imageService.status(),
    imageProvider: imageService.getConfig().provider,
  };
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// @desc   Admin sign-in. Verifies credentials, then requires an APPROVED admin
//         role. A valid ordinary account is told it has no admin access and may
//         request it; it is never granted a session here.
// @route  POST /api/admin/login
const login = async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }
  const user = await User.findOne({ email: String(email).toLowerCase() }).select('+password');
  if (!user || !(await user.matchPassword(password))) {
    return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
  }
  if (user.isActive === false) {
    return res.status(403).json({
      success: false,
      code: 'ACCOUNT_BLOCKED',
      message: 'This account has been blocked by an administrator. Please contact support.',
    });
  }

  if (!isAdminRole(user.role)) {
    const existing = await AdminRequest.findOne({ userId: user._id }).sort({ createdAt: -1 });
    return res.status(403).json({
      success: false,
      code: 'NOT_ADMIN',
      canRequest: true,
      requestStatus: existing ? existing.status : null,
      message: 'This account does not have administrator access.',
    });
  }

  user.lastActiveAt = new Date();
  await user.save();
  await audit.record({ actor: user, req, action: 'admin.login' });

  return res.status(200).json({ success: true, token: issueAdminToken(user), admin: publicAdmin(user) });
};

// @desc   Submit an admin-access request (verified by credentials; grants NOTHING)
// @route  POST /api/admin/request
const requestAccess = async (req, res) => {
  const { email, password, reason } = req.body || {};
  if (!isValidEmail(email) || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }
  const user = await User.findOne({ email: String(email).toLowerCase() }).select('+password');
  if (!user || !(await user.matchPassword(password))) {
    return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' });
  }
  if (user.isActive === false) {
    return res.status(403).json({
      success: false,
      code: 'ACCOUNT_BLOCKED',
      message: 'This account has been blocked by an administrator. Please contact support.',
    });
  }
  if (isAdminRole(user.role)) {
    return res.status(400).json({ success: false, code: 'ALREADY_ADMIN', message: 'This account already has administrator access.' });
  }

  const cleanReason = String(reason || '').trim();
  if (cleanReason.length < 5) {
    return res.status(400).json({ success: false, message: 'Please provide a short reason (at least 5 characters).' });
  }
  if (cleanReason.length > 500) {
    return res.status(400).json({ success: false, message: 'The reason must be 500 characters or fewer.' });
  }

  const pending = await AdminRequest.findOne({ userId: user._id, status: 'pending' });
  if (pending) {
    return res.json({ success: true, code: 'ALREADY_PENDING', request: publicRequest(pending), message: 'Your request is already pending review.' });
  }

  try {
    const doc = await AdminRequest.create({
      userId: user._id,
      name: user.name,
      email: user.email,
      reason: cleanReason,
      status: 'pending',
    });
    await audit.record({
      actor: user,
      req,
      action: 'admin.request.submit',
      targetType: 'user',
      targetId: String(user._id),
      targetLabel: user.email,
      meta: { reason: cleanReason.slice(0, 120) },
    });
    return res.status(201).json({ success: true, request: publicRequest(doc), message: 'Your request has been submitted for review.' });
  } catch (err) {
    if (err && err.code === 11000) {
      const p = await AdminRequest.findOne({ userId: user._id, status: 'pending' });
      return res.json({ success: true, code: 'ALREADY_PENDING', request: p ? publicRequest(p) : null, message: 'Your request is already pending review.' });
    }
    throw err;
  }
};

// @desc   Current user's admin-request status (authenticated user)
// @route  GET /api/admin/request/status
const requestStatus = async (req, res) => {
  const doc = await AdminRequest.findOne({ userId: req.user.id }).sort({ createdAt: -1 });
  res.json({
    success: true,
    request: doc ? publicRequest(doc) : null,
    canRequest: !doc || ['rejected', 'revoked'].includes(doc.status),
  });
};

// @desc   Own admin profile
// @route  GET /api/admin/me
const me = async (req, res) => {
  const isMain = req.admin.role === 'main_admin';
  const [mainAdminEmail, unreadNotifications, pendingAdminRequests] = await Promise.all([
    getMainAdminEmail(),
    notificationService.unreadCount(req.admin._id),
    isMain ? AdminRequest.countDocuments({ status: 'pending' }) : Promise.resolve(0),
  ]);
  res.json({
    success: true,
    admin: publicAdmin(req.admin),
    mainAdminEmail,
    unreadNotifications,
    pendingAdminRequests,
  });
};

// @desc   Update own admin profile (name, bio, profile photo)
// @route  PUT /api/admin/profile
const updateOwnProfile = async (req, res) => {
  const { name, bio, avatar } = req.body || {};
  let changed = false;

  if (name != null) {
    const clean = String(name).trim();
    if (clean) {
      req.admin.name = clean.slice(0, 100);
      changed = true;
    }
  }
  if (bio != null) {
    req.admin.profile = req.admin.profile || {};
    req.admin.profile.bio = String(bio).slice(0, 500);
    changed = true;
  }
  if (avatar !== undefined) {
    const cleanAvatar = sanitizeAvatar(avatar);
    if (cleanAvatar === undefined) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_IMAGE',
        message: 'Unsupported image. Use a PNG, JPEG, WEBP or GIF under 400 KB.',
      });
    }
    req.admin.profile = req.admin.profile || {};
    req.admin.profile.avatar = cleanAvatar;
    changed = true;
  }

  if (changed) {
    req.admin.markModified('profile');
    await req.admin.save();
    await audit.record({
      actor: req.admin,
      req,
      action: 'admin.profile.update',
      meta: { fields: [name != null && 'name', bio != null && 'bio', avatar !== undefined && 'avatar'].filter(Boolean) },
    });
  }
  res.json({ success: true, admin: publicAdmin(req.admin) });
};

// @desc   Change own admin password (also clears mustChangePassword)
// @route  POST /api/admin/change-password
const changePassword = async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword) {
    return res.status(400).json({ success: false, message: 'Current password is required.' });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'New passwords do not match.' });
  }
  const user = await User.findById(req.admin._id).select('+password');
  if (!user || !(await user.matchPassword(currentPassword))) {
    return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' });
  }
  if (await user.matchPassword(newPassword)) {
    return res.status(400).json({ success: false, message: 'The new password must be different from the current password.' });
  }
  user.password = newPassword; // hashed by pre-save hook
  user.mustChangePassword = false;
  await user.save();
  await audit.record({ actor: user, req, action: 'admin.password.change' });
  res.json({
    success: true,
    message: 'Password changed successfully.',
    token: issueAdminToken(user),
    admin: publicAdmin(user),
  });
};

// @desc   Current admin session info
// @route  GET /api/admin/sessions
const sessions = async (req, res) => {
  const decoded = req.auth || {};
  res.json({
    success: true,
    session: {
      tokenVersion: Number(req.admin.adminTokenVersion || 0),
      issuedAt: decoded.iat ? new Date(decoded.iat * 1000) : null,
      expiresAt: decoded.exp ? new Date(decoded.exp * 1000) : null,
      scope: decoded.scope || 'admin',
    },
  });
};

// @desc   Revoke every OTHER admin session for this account (rotates token version)
// @route  POST /api/admin/sessions/revoke-all
const revokeSessions = async (req, res) => {
  const user = await User.findById(req.admin._id);
  user.adminTokenVersion = Number(user.adminTokenVersion || 0) + 1;
  await user.save();
  await audit.record({ actor: user, req, action: 'admin.sessions.revoke_all' });
  res.json({
    success: true,
    message: 'All other administrative sessions have been revoked.',
    token: issueAdminToken(user), // keep the current session alive
  });
};

// ---------------------------------------------------------------------------
// Admin access requests (Main Admin Leader)
// ---------------------------------------------------------------------------

// @desc   List admin requests (filter by status)
// @route  GET /api/admin/requests?status=&page=&limit=
const listRequests = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const status = String(req.query.status || '').trim();
  const filter = ['pending', 'approved', 'rejected', 'revoked'].includes(status) ? { status } : {};

  const [requests, total] = await Promise.all([
    AdminRequest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    AdminRequest.countDocuments(filter),
  ]);
  res.json({
    success: true,
    requests: requests.map(publicRequest),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
};

// @desc   Approve a pending admin request (atomic; prevents double-approval)
// @route  POST /api/admin/requests/:id/approve
const approveRequest = async (req, res) => {
  const request = await AdminRequest.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { $set: { status: 'approved', reviewedBy: req.admin._id, reviewedByEmail: req.admin.email, reviewedAt: new Date() } },
    { new: true }
  );
  if (!request) {
    return res.status(409).json({ success: false, code: 'ALREADY_REVIEWED', message: 'This request has already been reviewed.' });
  }

  const user = await User.findById(request.userId);
  if (!user) {
    // Roll the request back so it is not stuck "approved" without an account.
    await AdminRequest.updateOne({ _id: request._id }, { $set: { status: 'pending', reviewedBy: null, reviewedByEmail: '', reviewedAt: null } });
    return res.status(404).json({ success: false, message: 'The applicant account no longer exists.' });
  }
  if (user.role === 'main_admin') {
    return res.status(400).json({ success: false, code: 'PROTECTED_ACCOUNT', message: 'That account is already the Main Admin Leader.' });
  }

  user.role = 'co_admin';
  user.adminPermissions = { ...DEFAULT_COADMIN_PERMISSIONS };
  user.adminApprovedBy = req.admin._id;
  user.adminApprovedAt = new Date();
  user.adminTokenVersion = Number(user.adminTokenVersion || 0) + 1;
  user.mustChangePassword = true; // new co-admins must set their own password
  user.isActive = true;
  user.suspendedAt = null;
  user.suspendReason = '';
  await user.save();

  await audit.record({
    actor: req.admin,
    req,
    action: 'admin.request.approve',
    targetType: 'user',
    targetId: String(user._id),
    targetLabel: user.email,
    meta: { role: 'co_admin', permissions: DEFAULT_COADMIN_PERMISSIONS },
  });

  // Notify the applicant: in-app (always) + email (best-effort).
  await notificationService.notify({
    userId: user._id,
    type: 'admin_approved',
    title: 'Admin access approved',
    body: 'Your request for administrator access was approved. Sign in and set a new password to get started.',
    link: '#/admin/login',
    email: user.email,
    emailSubject: 'Your admin access request was approved',
  });

  res.json({ success: true, request: publicRequest(request), user: publicAdmin(user) });
};

// @desc   Reject a pending admin request (user stays an ordinary user)
// @route  POST /api/admin/requests/:id/reject
const rejectRequest = async (req, res) => {
  const note = String((req.body && req.body.note) || '').slice(0, 300);
  const request = await AdminRequest.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { $set: { status: 'rejected', reviewedBy: req.admin._id, reviewedByEmail: req.admin.email, reviewedAt: new Date(), decisionNote: note } },
    { new: true }
  );
  if (!request) {
    return res.status(409).json({ success: false, code: 'ALREADY_REVIEWED', message: 'This request has already been reviewed.' });
  }
  await audit.record({
    actor: req.admin,
    req,
    action: 'admin.request.reject',
    targetType: 'user',
    targetId: String(request.userId),
    targetLabel: request.email,
    meta: note ? { note } : {},
  });

  // Notify the applicant (kept as an ordinary user): in-app + best-effort email.
  await notificationService.notify({
    userId: request.userId,
    type: 'admin_rejected',
    title: 'Admin access request declined',
    body: note ? `Your request was declined: ${note}` : 'Your request for administrator access was declined.',
    link: '#/admin/access',
    email: request.email,
    emailSubject: 'Your admin access request was reviewed',
  });

  res.json({ success: true, request: publicRequest(request) });
};

// ---------------------------------------------------------------------------
// Co-admin management (Main Admin Leader)
// ---------------------------------------------------------------------------

const withApproverEmail = async (users) => {
  const ids = users.map((u) => u.adminApprovedBy).filter(Boolean);
  const approvers = ids.length ? await User.find({ _id: { $in: ids } }).select('email') : [];
  const map = new Map(approvers.map((a) => [String(a._id), a.email]));
  return users.map((u) => ({
    ...publicAdmin(u),
    adminApprovedByEmail: u.adminApprovedBy ? map.get(String(u.adminApprovedBy)) || '' : '',
  }));
};

// @desc   List approved co-admins
// @route  GET /api/admin/co-admins
const listCoAdmins = async (req, res) => {
  const coAdmins = await User.find({ role: 'co_admin' }).sort({ adminApprovedAt: -1, createdAt: -1 });
  res.json({ success: true, coAdmins: await withApproverEmail(coAdmins) });
};

// @desc   Update a co-admin's permissions
// @route  PATCH /api/admin/co-admins/:id/permissions
const updateCoAdminPermissions = async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ success: false, message: 'Account not found' });
  if (isProtectedMainAdminAccount(target)) return res.status(403).json({ success: false, code: 'PROTECTED_ACCOUNT', message: 'The Main Admin Leader cannot be modified.' });
  if (target.role !== 'co_admin') return res.status(400).json({ success: false, message: 'That account is not a co-admin.' });

  const input = (req.body && req.body.permissions) || {};
  const next = { ...EMPTY_PERMISSIONS };
  for (const key of Object.keys(EMPTY_PERMISSIONS)) {
    if (key in input) next[key] = input[key] === true;
  }
  target.adminPermissions = next;
  await target.save();
  await audit.record({
    actor: req.admin,
    req,
    action: 'admin.coadmin.permissions',
    targetType: 'user',
    targetId: String(target._id),
    targetLabel: target.email,
    meta: { permissions: next },
  });
  res.json({ success: true, admin: { ...publicAdmin(target), adminApprovedByEmail: '' } });
};

// Shared cascade delete. Returns a count summary. Never deletes audit logs.
const cascadeDeleteUser = async (user) => {
  const id = user._id;
  const counts = await Promise.all([
    Resume.countDocuments({ userId: id }),
    JobDescription.countDocuments({ userId: id }),
    Chat.countDocuments({ userId: id }),
    Interview.countDocuments({ userId: id }),
    Roadmap.countDocuments({ userId: id }),
    RAGDocument.countDocuments({ userId: id }),
    GeneratedImage.countDocuments({ userId: id }),
    Document.countDocuments({ userId: id }),
    OTP.countDocuments({ email: user.email }),
    AdminRequest.countDocuments({ userId: id }),
  ]);
  await Promise.all([
    Resume.deleteMany({ userId: id }),
    JobDescription.deleteMany({ userId: id }),
    Chat.deleteMany({ userId: id }),
    Interview.deleteMany({ userId: id }),
    Roadmap.deleteMany({ userId: id }),
    RAGDocument.deleteMany({ userId: id }),
    GeneratedImage.deleteMany({ userId: id }),
    Document.deleteMany({ userId: id }),
    OTP.deleteMany({ email: user.email }),
    AdminRequest.deleteMany({ userId: id }),
    User.deleteOne({ _id: id }),
  ]);
  return {
    resumes: counts[0],
    jobDescriptions: counts[1],
    conversations: counts[2],
    interviews: counts[3],
    roadmaps: counts[4],
    knowledgeChunks: counts[5],
    generatedImages: counts[6],
    documents: counts[7],
    otpRecords: counts[8],
    adminRequests: counts[9],
  };
};

// @desc   Revoke a co-admin's access (role -> user, sessions invalidated)
// @route  POST /api/admin/co-admins/:id/revoke
const revokeCoAdmin = async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ success: false, message: 'Account not found' });
  if (isProtectedMainAdminAccount(target)) return res.status(403).json({ success: false, code: 'PROTECTED_ACCOUNT', message: 'The Main Admin Leader cannot be revoked.' });
  if (target.role !== 'co_admin') return res.status(400).json({ success: false, message: 'That account is not a co-admin.' });

  target.role = 'user';
  target.adminPermissions = { ...EMPTY_PERMISSIONS };
  target.adminTokenVersion = Number(target.adminTokenVersion || 0) + 1; // kills existing admin tokens
  target.mustChangePassword = false;
  await target.save();

  await AdminRequest.updateMany({ userId: target._id, status: 'approved' }, { $set: { status: 'revoked' } });

  await audit.record({
    actor: req.admin,
    req,
    action: 'admin.coadmin.revoke',
    targetType: 'user',
    targetId: String(target._id),
    targetLabel: target.email,
    meta: { previousRole: 'co_admin', role: 'user' },
  });
  res.json({ success: true, message: 'Co-admin access revoked.', user: publicAdmin(target) });
};

// @desc   Delete a co-admin account (cascade), Main Admin Leader only
// @route  DELETE /api/admin/co-admins/:id
const deleteCoAdmin = async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ success: false, message: 'Account not found' });
  if (isProtectedMainAdminAccount(target)) return res.status(403).json({ success: false, code: 'PROTECTED_ACCOUNT', message: 'The Main Admin Leader cannot be deleted.' });
  if (target.role !== 'co_admin') return res.status(400).json({ success: false, message: 'That account is not a co-admin.' });
  if (String(target._id) === String(req.admin._id)) return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
  if (req.body && req.body.confirm !== true && req.query.confirm !== 'true') {
    return res.status(400).json({ success: false, code: 'CONFIRMATION_REQUIRED', message: 'Deletion requires explicit confirmation.' });
  }

  // Audit BEFORE deletion so the acting admin + target identity are preserved.
  await audit.record({
    actor: req.admin,
    req,
    action: 'admin.coadmin.delete',
    targetType: 'user',
    targetId: String(target._id),
    targetLabel: target.email,
    meta: { previousRole: 'co_admin' },
  });
  const deleted = await cascadeDeleteUser(target);
  res.json({ success: true, message: 'Co-admin account and related data deleted.', deleted });
};

// ---------------------------------------------------------------------------
// User management
// ---------------------------------------------------------------------------

const buildUserFilter = (query) => {
  const filter = {};
  const search = String(query.search || '').trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: re }, { email: re }];
  }
  const role = String(query.role || '').trim();
  if (['user', 'co_admin', 'main_admin'].includes(role)) filter.role = role;
  const status = String(query.status || '').trim();
  if (status === 'active') filter.isActive = { $ne: false };
  else if (status === 'suspended') filter.isActive = false;
  return filter;
};

// @desc   List users (search + filter + paginate)
// @route  GET /api/admin/users
const listUsers = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
  const filter = buildUserFilter(req.query);

  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-password'),
    User.countDocuments(filter),
  ]);

  const details = await Promise.all(
    users.map(async (u) => ({
      ...sanitizeUser(u),
      hasResume: Boolean(await Resume.exists({ userId: u._id })),
      hasJob: Boolean(await JobDescription.exists({ userId: u._id })),
      chatCount: await Chat.countDocuments({ userId: u._id }),
    }))
  );

  res.json({ success: true, users: details, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
};

// @desc   Single user detail (no private chat content / OTP hashes)
// @route  GET /api/admin/users/:id
const getUserDetail = async (req, res) => {
  const user = await User.findById(req.params.id).select('-password');
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const [resume, job, chatCount, interviewCount, roadmap, ragCount, docCount, imageCount, adminReq] = await Promise.all([
    Resume.findOne({ userId: user._id }).select('fileName fileType fileSize parsed.name parsed.skills analysis.matchPercent createdAt updatedAt'),
    JobDescription.findOne({ userId: user._id }).select('jobTitle company createdAt updatedAt'),
    Chat.countDocuments({ userId: user._id }),
    Interview.countDocuments({ userId: user._id }),
    Roadmap.findOne({ userId: user._id }).select('targetRole progressPercent phases createdAt updatedAt'),
    RAGDocument.countDocuments({ userId: user._id }),
    Document.countDocuments({ userId: user._id }),
    GeneratedImage.countDocuments({ userId: user._id }),
    AdminRequest.findOne({ userId: user._id }).sort({ createdAt: -1 }),
  ]);

  res.json({
    success: true,
    user: { ...sanitizeUser(user), adminApprovedByEmail: '' },
    resume: resume
      ? { ...resume.toObject(), parsed: { name: resume.parsed?.name, skills: resume.parsed?.skills } }
      : null,
    job: job ? { jobTitle: job.jobTitle, company: job.company, createdAt: job.createdAt } : null,
    chatCount,
    interviewCount,
    roadmap: roadmap ? { targetRole: roadmap.targetRole, progressPercent: roadmap.progressPercent, phaseCount: roadmap.phases?.length } : null,
    ragDocumentCount: ragCount,
    documentCount: docCount,
    generatedImageCount: imageCount,
    adminRequest: adminReq ? publicRequest(adminReq) : null,
  });
};

const applyUserSuspensionGuards = (req, res, target) => {
  if (isProtectedMainAdminAccount(target)) {
    res.status(403).json({ success: false, code: 'PROTECTED_ACCOUNT', message: 'The Main Admin Leader cannot be suspended or modified.' });
    return false;
  }
  if (String(target._id) === String(req.admin._id)) {
    res.status(400).json({ success: false, message: 'You cannot change your own account status.' });
    return false;
  }
  // A co-admin may only touch ordinary users. Only the Main Admin Leader may
  // suspend/restore another administrator.
  if (isAdminRole(target.role) && req.admin.role !== 'main_admin') {
    res.status(403).json({ success: false, code: 'PROTECTED_ACCOUNT', message: 'Only the Main Admin Leader can manage administrator accounts.' });
    return false;
  }
  return true;
};

// @desc   Suspend a user (data is preserved)
// @route  POST /api/admin/users/:id/suspend
const suspendUser = async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ success: false, message: 'User not found' });
  if (!applyUserSuspensionGuards(req, res, target)) return undefined;

  target.isActive = false;
  target.suspendedAt = new Date();
  target.suspendReason = String((req.body && req.body.reason) || '').slice(0, 300);
  await target.save();
  await audit.record({
    actor: req.admin,
    req,
    action: 'admin.user.suspend',
    targetType: 'user',
    targetId: String(target._id),
    targetLabel: target.email,
    meta: target.suspendReason ? { reason: target.suspendReason } : {},
  });
  return res.json({ success: true, message: 'User suspended.', user: sanitizeUser(target) });
};

// @desc   Restore a suspended user
// @route  POST /api/admin/users/:id/restore
const restoreUser = async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ success: false, message: 'User not found' });
  if (!applyUserSuspensionGuards(req, res, target)) return undefined;

  target.isActive = true;
  target.suspendedAt = null;
  target.suspendReason = '';
  await target.save();
  await audit.record({
    actor: req.admin,
    req,
    action: 'admin.user.restore',
    targetType: 'user',
    targetId: String(target._id),
    targetLabel: target.email,
  });
  return res.json({ success: true, message: 'User restored.', user: sanitizeUser(target) });
};

// @desc   Delete a user + all related data (confirmation required)
// @route  DELETE /api/admin/users/:id
const deleteUser = async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) return res.status(404).json({ success: false, message: 'User not found' });

  if (isProtectedMainAdminAccount(target)) {
    return res.status(403).json({ success: false, code: 'PROTECTED_ACCOUNT', message: 'The Main Admin Leader cannot be deleted.' });
  }
  if (String(target._id) === String(req.admin._id)) {
    return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
  }
  // Only the Main Admin Leader may delete ANY admin account. A co-admin with the
  // deleteUsers permission may delete ordinary users only.
  if (isAdminRole(target.role) && req.admin.role !== 'main_admin') {
    return res.status(403).json({ success: false, code: 'PROTECTED_ACCOUNT', message: 'Only the Main Admin Leader can delete administrator accounts.' });
  }
  if (req.body && req.body.confirm !== true && req.query.confirm !== 'true') {
    return res.status(400).json({ success: false, code: 'CONFIRMATION_REQUIRED', message: 'Deletion requires explicit confirmation.' });
  }

  await audit.record({
    actor: req.admin,
    req,
    action: 'admin.user.delete',
    targetType: 'user',
    targetId: String(target._id),
    targetLabel: target.email,
    meta: { previousRole: target.role },
  });
  const deleted = await cascadeDeleteUser(target);
  return res.json({ success: true, message: 'User and all related data deleted.', deleted });
};

// ---------------------------------------------------------------------------
// Dashboard / monitoring
// ---------------------------------------------------------------------------

// @desc   Dashboard summary (real data only)
// @route  GET /api/admin/stats
const stats = async (req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [
    totalUsers, activeUsers, suspendedUsers, recentlyActiveUsers, coAdmins,
    pendingRequests, totalConversations, chatsAgg, totalResumes, totalJobs,
    totalInterviews, totalRoadmaps,
  ] = await Promise.all([
    // "Total Users" counts registered USERS, never administrative accounts.
    User.countDocuments({ role: { $nin: ADMIN_ROLES } }),
    User.countDocuments({ isActive: { $ne: false } }),
    User.countDocuments({ isActive: false }),
    User.countDocuments({ lastActiveAt: { $gte: weekAgo } }),
    User.countDocuments({ role: 'co_admin' }),
    AdminRequest.countDocuments({ status: 'pending' }),
    Chat.aggregate([
      {
        $lookup: {
          from: User.collection.name,
          localField: 'userId',
          foreignField: '_id',
          as: 'owner',
        },
      },
      { $unwind: '$owner' },
      {
        $match: {
          'owner.role': { $nin: ADMIN_ROLES },
          'messages.0': { $exists: true },
        },
      },
      { $count: 'total' },
    ]),
    Chat.aggregate([{ $project: { n: { $size: '$messages' } } }, { $group: { _id: null, total: { $sum: '$n' } } }]),
    Resume.countDocuments(),
    JobDescription.countDocuments(),
    Interview.countDocuments(),
    Roadmap.countDocuments(),
  ]);

  const [today, totals] = await Promise.all([usageService.getToday(), usageService.getTotals()]);
  const [recentUsers, recentActivity] = await Promise.all([
    User.find().sort({ createdAt: -1 }).limit(5).select('name email role createdAt'),
    AuditLog.find().sort({ createdAt: -1 }).limit(8).select('actorEmail actorRole action targetLabel createdAt'),
  ]);

  res.json({
    success: true,
    stats: {
      totalUsers,
      activeUsers,
      suspendedUsers,
      recentlyActiveUsers,
      coAdmins,
      pendingAdminRequests: pendingRequests,
      totalConversations: totalConversations[0]?.total || 0,
      // Explicit alias used by the dashboard's "Total Chats" card. It is the
      // same real MongoDB count (never a fabricated/mock number).
      totalChats: totalConversations[0]?.total || 0,
      totalChatMessages: chatsAgg[0]?.total || 0,
      totalResumes,
      totalJobDescriptions: totalJobs,
      totalInterviews,
      totalRoadmaps,
      ai: {
        tracked: true,
        today,
        totals,
      },
    },
    recentUsers: recentUsers.map((u) => ({ _id: u._id, name: u.name, email: u.email, role: u.role, createdAt: u.createdAt })),
    recentActivity: recentActivity.map((a) => ({
      actorEmail: a.actorEmail,
      actorRole: a.actorRole,
      action: a.action,
      targetLabel: a.targetLabel,
      createdAt: a.createdAt,
    })),
  });
};

// @desc   Backend + AI provider health (no secrets)
// @route  GET /api/admin/system
const systemHealth = async (req, res) => {
  const [today, totals, settings] = await Promise.all([
    usageService.getToday(),
    usageService.getTotals(),
    settingsService.getSettings({ fresh: true }),
  ]);
  res.json({
    success: true,
    system: {
      backend: 'online',
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      ...safeProviderStatus(),
    },
    usage: { today, totals },
    maintenance: { enabled: settings.maintenanceMode.enabled, message: settings.maintenanceMode.message },
  });
};

// @desc   Audit log (append-only; Main Admin Leader or viewAudit permission)
// @route  GET /api/admin/audit
const listAudit = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const filter = {};
  const action = String(req.query.action || '').trim();
  if (action) filter.action = new RegExp(escapeRegex(action), 'i');
  const search = String(req.query.search || '').trim();
  if (search) {
    const re = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ actorEmail: re }, { targetLabel: re }, { targetId: re }];
  }

  const [logs, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
    AuditLog.countDocuments(filter),
  ]);
  res.json({
    success: true,
    logs,
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  });
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// @desc   Read system settings + provider status
// @route  GET /api/admin/settings
const getSettings = async (req, res) => {
  const settings = await settingsService.getSettings({ fresh: true });
  res.json({
    success: true,
    settings,
    providers: safeProviderStatus(),
    limits: { note: '0 = unlimited' },
  });
};

// @desc   Update system settings (Main Admin Leader only for protected settings)
// @route  PUT /api/admin/settings
const updateSettings = async (req, res) => {
  const patch = req.body || {};
  const before = await settingsService.getSettings({ fresh: true });
  const after = await settingsService.updateSettings(patch, req.admin._id);
  await audit.record({
    actor: req.admin,
    req,
    action: 'admin.settings.update',
    meta: {
      from: { maintenance: before.maintenanceMode.enabled },
      to: { maintenance: after.maintenanceMode.enabled },
      count: after.aiLimits.dailyRequestLimit,
      enabled: after.maintenanceMode.enabled,
    },
  });
  res.json({ success: true, settings: after });
};

// ---------------------------------------------------------------------------
// Resumes (existing moderation feature)
// ---------------------------------------------------------------------------

// @desc   List resume metadata (no full text)
// @route  GET /api/admin/resumes
const listResumes = async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

  const [resumes, total] = await Promise.all([
    Resume.find()
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('userId fileName fileType fileSize parsed.name parsed.skills analysis.matchPercent createdAt updatedAt'),
    Resume.countDocuments(),
  ]);

  const withUser = await Promise.all(
    resumes.map(async (r) => {
      const u = await User.findById(r.userId).select('name email');
      return { ...r.toObject(), user: u ? { name: u.name, email: u.email } : null };
    })
  );

  res.json({ success: true, resumes: withUser, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
};

// @desc   Delete a resume + its RAG chunks (source=resume)
// @route  DELETE /api/admin/resumes/:userId
const deleteResume = async (req, res) => {
  const removed = await Resume.findOneAndDelete({ userId: req.params.userId });
  if (!removed) return res.status(404).json({ success: false, message: 'Resume not found' });
  await RAGDocument.deleteMany({ userId: removed.userId, source: 'resume' });
  await audit.record({
    actor: req.admin,
    req,
    action: 'admin.resume.delete',
    targetType: 'resume',
    targetId: String(removed.userId),
    targetLabel: removed.fileName || '',
  });
  res.json({ success: true, message: 'Resume and related knowledge base chunks removed' });
};

// ---------------------------------------------------------------------------
// Notifications (the signed-in administrator's own inbox)
// ---------------------------------------------------------------------------

// @desc   List my notifications (newest first) + unread count
// @route  GET /api/admin/notifications
const listNotifications = async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
  const [items, unread] = await Promise.all([
    notificationService.list(req.admin._id, { limit }),
    notificationService.unreadCount(req.admin._id),
  ]);
  res.json({
    success: true,
    notifications: items.map((n) => ({
      _id: n._id,
      type: n.type,
      title: n.title,
      body: n.body,
      link: n.link,
      read: !!n.read,
      createdAt: n.createdAt,
    })),
    unread,
  });
};

// @desc   Mark one notification read
// @route  POST /api/admin/notifications/:id/read
const markNotificationRead = async (req, res) => {
  await notificationService.markRead(req.admin._id, req.params.id);
  const unread = await notificationService.unreadCount(req.admin._id);
  res.json({ success: true, unread });
};

// @desc   Mark every notification read
// @route  POST /api/admin/notifications/read-all
const markAllNotificationsRead = async (req, res) => {
  await notificationService.markAllRead(req.admin._id);
  res.json({ success: true, unread: 0 });
};

module.exports = {
  login,
  requestAccess,
  requestStatus,
  me,
  updateOwnProfile,
  changePassword,
  sessions,
  revokeSessions,
  listRequests,
  approveRequest,
  rejectRequest,
  listCoAdmins,
  updateCoAdminPermissions,
  revokeCoAdmin,
  deleteCoAdmin,
  listUsers,
  getUserDetail,
  suspendUser,
  restoreUser,
  deleteUser,
  stats,
  systemHealth,
  listAudit,
  getSettings,
  updateSettings,
  listResumes,
  deleteResume,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  _helpers: { cascadeDeleteUser, publicAdmin, publicRequest },
};
