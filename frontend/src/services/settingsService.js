import api from './api';

// All /api/settings calls are authenticated by the shared axios interceptor,
// which attaches the JWT. The backend scopes every query by the authenticated
// user (req.user.id), so these helpers never pass a user id from the client.

export const getSettings = () => api.get('/settings');

// payload: { name?, email?, bio?, avatar? } — avatar is a data URL ("" removes it)
export const updateProfileSettings = (payload) => api.put('/settings/profile', payload);

// payload mirrors the stored shape: { appearance?, chat?, notifications? }
export const updatePreferences = (payload) => api.put('/settings/preferences', payload);

export const changePassword = (payload) => api.post('/settings/change-password', payload);

export const exportMyData = () => api.get('/settings/export');

export const clearChatHistory = () => api.post('/settings/clear-chats');

export const deleteAccount = (password) => api.delete('/settings/account', { data: { password } });

// Client-side downscale: converts a picked image File into a small JPEG data
// URL (max 256px) so the avatar payload stays well under the server's 400KB cap.
export const fileToAvatarDataUrl = (file) =>
  new Promise((resolve, reject) => {
    if (!file) return reject(new Error('No file selected.'));
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
      return reject(new Error('Please choose a PNG, JPG or WebP image.'));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That image could not be read.'));
      img.onload = () => {
        const max = 256;
        let w = img.width;
        let h = img.height;
        if (w >= h) {
          if (w > max) { h = Math.round((h * max) / w); w = max; }
        } else if (h > max) { w = Math.round((w * max) / h); h = max; }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
