import { useMemo } from 'react';

// ONE component renders the signed-in user's picture everywhere (sidebar, top
// bar, profile card, settings preview). It reads the single source of truth —
// user.profile.avatar — and falls back to initials when there is no picture (or
// when the stored data URL is unusable). Keeping this in one place is what stops
// the header, sidebar and profile card from drifting apart after an upload.
function initialsFor(user) {
  const name = String(user?.name || '').trim();
  if (!name) return 'U';
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] || '';
  const second = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] || '');
  return (first + second).toUpperCase() || 'U';
}

export default function Avatar({ user, className = '', size, alt, style, ...rest }) {
  const src = typeof user?.profile?.avatar === 'string' ? user.profile.avatar.trim() : '';
  const initials = useMemo(() => initialsFor(user), [user]);
  const dims = size ? { width: size, height: size, ...style } : style;

  if (src) {
    return (
      <span className={`${className} has-img`} style={dims} {...rest}>
        <img src={src} alt={alt || user?.name || 'Profile photo'} />
      </span>
    );
  }
  return (
    <span className={className} style={dims} {...rest} aria-label={alt || user?.name || 'User'}>
      {initials}
    </span>
  );
}
