const multer = require('multer');
const path = require('path');

// File upload validation for all document endpoints (/api/files, /api/resume).
// Allowed: PDF, DOC, DOCX, TXT, PNG, JPG, JPEG. Everything else (including
// executables/scripts like .exe .bat .cmd .ps1 .sh) is rejected explicitly.

const ALLOWED = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

const ALLOWED_EXT = ['pdf', 'doc', 'docx', 'txt', 'png', 'jpg', 'jpeg'];
const FORBIDDEN_EXT = ['exe', 'bat', 'cmd', 'ps1', 'sh', 'msi', 'dll', 'com', 'scr', 'hta', 'vbs', 'jar', 'php', 'py', 'cgi'];

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB (matches the frontend limit)

const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || '').toLowerCase().replace('.', '');
  const allowedType = ALLOWED[file.mimetype];

  if (FORBIDDEN_EXT.includes(ext)) {
    return cb(new Error(`Security: ${ext.toUpperCase()} files are not allowed. Executable/script files are rejected.`));
  }

  // Accept known extensions even if the mimetype reported by the browser is generic.
  if (allowedType || ALLOWED_EXT.includes(ext)) {
    file.extension = ext || allowedType;
    return cb(null, true);
  }
  cb(new Error('Unsupported file type. Supported: PDF, DOC, DOCX, TXT, PNG, JPG, JPEG.'));
};

const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter,
});

const handleUploadError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'File is too large. Maximum size is 10 MB.' });
    }
    return res.status(400).json({ success: false, message: `Upload error: ${err.message}` });
  }
  return res.status(400).json({ success: false, message: err.message || 'Upload failed' });
};

module.exports = { upload, handleUploadError, ALLOWED_EXT };