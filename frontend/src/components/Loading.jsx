import { Loader2 } from 'lucide-react';

export default function Loading({ label = 'Loading...', full = false, small = false }) {
  if (small) {
    return (
      <span className="loading-small" role="status" aria-label={label}>
        <Loader2 size={16} className="spin" />
      </span>
    );
  }
  return (
    <div className={`loading ${full ? 'loading-full' : ''}`} role="status" aria-label={label}>
      <div className="loading-orbit">
        <span className="orb orb-1" />
        <span className="orb orb-2" />
        <span className="orb orb-3" />
      </div>
      <p className="loading-label">{label}</p>
    </div>
  );
}