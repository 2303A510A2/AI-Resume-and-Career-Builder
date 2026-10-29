const crypto = require('crypto');

// Generates a cryptographically secure 6-digit OTP plus a salted SHA-256 hash.
// Only the hash is stored; the plain OTP is never persisted.
const generateOTP = (length = 6) => {
  const otp = crypto
    .randomInt(0, Math.pow(10, length))
    .toString()
    .padStart(length, '0');
  const hash = hashOTP(otp);
  return { otp, hash };
};

const hashOTP = (otp) => {
  const pepper = process.env.JWT_SECRET || 'otp-pepper';
  return crypto.createHash('sha256').update(`${otp}:${pepper}`).digest('hex');
};

const verifyOTP = (otp, storedHash) => {
  if (!otp || typeof otp !== 'string') return false;
  return crypto.timingSafeEqual(
    Buffer.from(hashOTP(otp.trim())),
    Buffer.from(storedHash)
  );
};

module.exports = { generateOTP, hashOTP, verifyOTP };