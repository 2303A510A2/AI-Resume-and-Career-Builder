const isValidEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
};

const isValidPassword = (password) => {
  return typeof password === 'string' && password.length >= 6;
};

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const emailLookup = (email) => ({
  email: {
    $regex: `^${normalizeEmail(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    $options: 'i',
  },
});

const sanitizeUser = (user) => {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : { ...user };
  delete obj.password;
  delete obj.__v;
  return obj;
};

module.exports = { isValidEmail, isValidPassword, normalizeEmail, emailLookup, sanitizeUser };