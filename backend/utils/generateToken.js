const jwt = require('jsonwebtoken');

const generateToken = (user, expiresIn = process.env.JWT_EXPIRES_IN || '7d', extra = {}) => {
  return jwt.sign(
    { id: user._id.toString(), role: user.role || 'user', ...extra },
    process.env.JWT_SECRET,
    { expiresIn }
  );
};

const generateResetToken = (user) => {
  return jwt.sign({ id: user._id.toString(), purpose: 'password-reset' }, process.env.JWT_RESET_SECRET, {
    expiresIn: process.env.JWT_RESET_EXPIRES_IN || '10m',
  });
};

module.exports = { generateToken, generateResetToken };