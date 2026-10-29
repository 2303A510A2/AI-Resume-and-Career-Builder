const jwt = require('jsonwebtoken');
const { getAuthSecret, getResetSecret } = require('./authConfig');

const generateToken = (user, expiresIn = process.env.JWT_EXPIRES_IN || '7d', extra = {}) => {
  return jwt.sign(
    { id: user._id.toString(), role: user.role || 'user', ...extra },
    getAuthSecret(),
    { expiresIn }
  );
};

const generateResetToken = (user) => {
  return jwt.sign({ id: user._id.toString(), purpose: 'password-reset' }, getResetSecret(), {
    expiresIn: process.env.JWT_RESET_EXPIRES_IN || '10m',
  });
};

module.exports = { generateToken, generateResetToken };