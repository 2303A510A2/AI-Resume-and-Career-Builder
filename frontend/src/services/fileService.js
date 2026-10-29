import api from './api';

// Document upload for the chat workspace. Uses the same JWT-authenticated
// /api/files/upload endpoint as the app's upload pages. Returns the created
// document(s) with a real document id that can be attached (documentIds) to the
// next chat message so its extracted text feeds the RAG context.
//
// category: 'resume' | 'jd' | 'document' — a light hint from the client; the
// server also classifies from the filename and never trusts it for ownership.
export const uploadChatFiles = (files, category = 'document', onProgress) => {
  const form = new FormData();
  Array.from(files || []).forEach((file) => form.append('file', file));
  if (category) form.append('category', category);
  return api.post('/files/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (e.total) onProgress?.(Math.round((e.loaded * 100) / e.total));
    },
  });
};

export const listDocuments = () => api.get('/files');
export const deleteDocument = (id) => api.delete(`/files/${id}`);

// Fetches the stored image bytes (base64 in Mongo, served as raw bytes) for a
// document the caller owns, as a Blob. The shared axios instance attaches the
// JWT automatically; ownership is validated server-side.
export const fetchDocumentImage = async (id) => {
  const res = await api.get(`/files/${id}/image`, { responseType: 'blob' });
  return res.data; // Blob
};

// Lightweight client-side classifier mirroring the backend heuristics, so the
// attachment chip can show the intended kind before the server confirms.
export const classifyFileName = (name = '') => {
  const lower = String(name).toLowerCase();
  if (/resume|cv\b|curriculum/.test(lower)) return 'resume';
  if (/job|jd\b|descri|requirement|vacan/.test(lower)) return 'jd';
  return 'document';
};

export const ACCEPTED_FILE_TYPES = '.pdf,.doc,.docx,.txt,.png,.jpg,.jpeg,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/png,image/jpeg';