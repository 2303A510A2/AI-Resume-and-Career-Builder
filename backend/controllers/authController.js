const User = require('../models/User');
const Admin = require('../models/Admin');
const OTP = require('../models/OTP');
const { generateOTP, verifyOTP } = require('../utils/generateOTP');
const { generateToken, generateResetToken } = require('../utils/generateToken');
const { isValidEmail, isValidPassword, sanitizeUser } = require('../utils/validators');
const { sendOTPEmail } = require('../services/emailService');
const jwt = require('jsonwebtoken');

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_WINDOW_SECONDS = 60;

// @desc   Register a new user
// @route  POST /api/auth/register
const register = async (req, res) => {
  const { name, email, password, confirmPassword } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: 'Full name is required' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'A valid email is required' });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Passwords do not match' });
  }

  const exists = await User.findOne({ email: email.toLowerCase() });
  if (exists) {
    return res.status(409).json({ success: false, message: 'An account with this email already exists' });
  }

  const user = await User.create({ name: name.trim(), email: email.toLowerCase(), password });
  const token = generateToken(user);
  res.status(201).json({ success: true, token, user: sanitizeUser(user) });
};

// @desc   Login
// @route  POST /api/auth/login
const login = async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
  if (!user || !(await user.matchPassword(password))) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }
  if (user.isActive === false) {
    return res.status(403).json({
      success: false,
      code: 'ACCOUNT_BLOCKED',
      message: 'This account has been blocked by an administrator. Please contact support.',
    });
  }

  user.lastActiveAt = new Date();
  await user.save();

  res.json({ success: true, token: generateToken(user), user: sanitizeUser(user) });
};

// @desc   Logout (stateless JWT: the client discards the token)
// @route  POST /api/auth/logout
const logout = async (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
};

// @desc   Get current user profile
// @route  GET /api/auth/me
const me = async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user: sanitizeUser(user) });
};

// @desc   Update profile (name, title, company, location, bio, skills, preferences)
// @route  PUT /api/auth/profile
const updateProfile = async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  const { name, profile } = req.body || {};
  if (name && String(name).trim()) user.name = String(name).trim();

  if (profile && typeof profile === 'object') {
    user.profile = {
      ...user.profile,
      title: profile.title ?? user.profile.title,
      company: profile.company ?? user.profile.company,
      location: profile.location ?? user.profile.location,
      bio: profile.bio ?? user.profile.bio,
      skills: Array.isArray(profile.skills) ? profile.skills.map((s) => String(s).trim()).filter(Boolean) : user.profile.skills,
      preferences: {
        targetRoles: Array.isArray(profile.preferences?.targetRoles)
          ? profile.preferences.targetRoles.map(String)
          : user.profile.preferences?.targetRoles || [],
        industries: Array.isArray(profile.preferences?.industries)
          ? profile.preferences.industries.map(String)
          : user.profile.preferences?.industries || [],
      },
    };
  }

  await user.save();
  res.json({ success: true, user: sanitizeUser(user) });
};

// @desc   Forgot password - generate & send OTP
// @route  POST /api/auth/forgot-password
const forgotPassword = async (req, res) => {
  const { email } = req.body || {};
  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, message: 'A valid email is required' });
  }
  const normalizedEmail = email.toLowerCase();

  const user = await User.findOne({ email: normalizedEmail });
  if (!user) {
    // Generic response - never reveal whether an account exists.
    return res.json({
      success: true,
      message: 'If that email is registered, an OTP has been sent to it.',
    });
  }

  const existing = await OTP.findOne({ email: normalizedEmail, purpose: 'reset-password' });
  if (existing) {
    const secondsSince = (Date.now() - existing.createdAt.getTime()) / 1000;
    if (secondsSince < OTP_RESEND_WINDOW_SECONDS) {
      return res.status(429).json({
        success: false,
        message: `Please wait ${Math.ceil(OTP_RESEND_WINDOW_SECONDS - secondsSince)} seconds before requesting a new OTP.`,
      });
    }
  }

  const { otp, hash } = generateOTP();
  await OTP.findOneAndDelete({ email: normalizedEmail, purpose: 'reset-password' });
  await OTP.create({
    email: normalizedEmail,
    purpose: 'reset-password',
    otpHash: hash,
    expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
    attempts: 0,
    maxAttempts: OTP_MAX_ATTEMPTS,
  });

  try {
    await sendOTPEmail(normalizedEmail, otp, OTP_TTL_MINUTES);
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Failed to send OTP email. Check email configuration.' });
  }

  res.json({ success: true, message: 'An OTP has been sent to your email.' });
};

// @desc   Verify OTP -> returns short-lived reset token
// @route  POST /api/auth/verify-otp
const verifyOtp = async (req, res) => {
  const { email, otp } = req.body || {};
  if (!isValidEmail(email) || !otp) {
    return res.status(400).json({ success: false, message: 'Email and OTP are required' });
  }

  const record = await OTP.findOne({ email: email.toLowerCase(), purpose: 'reset-password' });
  if (!record) {
    return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
  }

  if (record.attempts >= record.maxAttempts) {
    await OTP.deleteOne({ _id: record._id });
    return res.status(429).json({ success: false, message: 'Too many failed attempts. Please request a new OTP.' });
  }

  if (record.expiresAt < new Date()) {
    await OTP.deleteOne({ _id: record._id });
    return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
  }

  if (!verifyOTP(String(otp), record.otpHash)) {
    record.attempts += 1;
    await record.save();
    return res.status(400).json({
      success: false,
      message: `Invalid OTP. ${Math.max(0, record.maxAttempts - record.attempts)} attempts remaining.`,
    });
  }

  const user = await User.findOne({ email: record.email });
  if (!user) {
    return res.status(404).json({ success: false, message: 'Account not found' });
  }

  const resetToken = generateResetToken(user);
  await OTP.deleteOne({ _id: record._id });
  res.json({ success: true, resetToken, message: 'OTP verified.' });
};

// @desc   Reset password with reset token
// @route  POST /api/auth/reset-password
const resetPassword = async (req, res) => {
  const { resetToken, password, confirmPassword } = req.body || {};

  if (!resetToken) {
    return res.status(400).json({ success: false, message: 'Reset token is required' });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Passwords do not match' });
  }

  let decoded;
  try {
    decoded = jwt.verify(resetToken, process.env.JWT_RESET_SECRET);
  } catch {
    return res.status(400).json({ success: false, message: 'Reset token is invalid or expired. Please request a new OTP.' });
  }

  if (decoded.purpose !== 'password-reset') {
    return res.status(400).json({ success: false, message: 'Invalid reset token' });
  }

  const user = await User.findById(decoded.id);
  if (!user) return res.status(404).json({ success: false, message: 'Account not found' });

  user.password = password; // hashed by the pre-save hook
  await user.save();

  res.json({ success: true, message: 'Password updated successfully. You can now log in.' });
};

// @desc   Admin login (separate collection + role)
// @route  POST /api/admin/login
const adminLogin = async (req, res) => {
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }
  const admin = await Admin.findOne({ email: email.toLowerCase() }).select('+password');
  if (!admin || !(await admin.matchPassword(password))) {
    return res.status(401).json({ success: false, message: 'Invalid admin email or password' });
  }
  res.json({ success: true, token: generateToken(admin), admin: sanitizeUser(admin) });
};

module.exports = {
  register,
  login,
  logout,
  me,
  updateProfile,
  forgotPassword,
  verifyOtp,
  resetPassword,
  adminLogin,
};