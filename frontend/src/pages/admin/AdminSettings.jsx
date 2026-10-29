import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import {
  UserRound, Lock, Palette, Settings as SettingsIcon, ShieldCheck, KeyRound,
  Save, Loader2, HardDriveUpload, Sparkles, Wrench, Brain, Mic,
  Image as ImageIcon, Database, Activity, Crown, Sun, Moon, Monitor, LogOut,
  ShieldHalf, ScrollText, SlidersHorizontal, ChevronRight, Info,
  Camera, Trash2, Mail, Pencil,
} from 'lucide-react';
import {
  getAdminSettings, updateAdminSettings, adminUpdateProfile, adminSessions, adminRevokeSessions,
  getSystemHealth, adminMe,
} from '../../services/adminService';
import { useAuth } from '../../hooks/useAuth';
import { useToast } from '../../hooks/useToast';
import { useTheme } from '../../context/ThemeContext';
import AdminChangePassword from './AdminChangePassword.jsx';
import Loading from '../../components/Loading.jsx';

const PERMS = [
  ['manageUsers', 'Manage users', 'View, block and unblock ordinary users.'],
  ['deleteUsers', 'Delete users', 'Permanently delete ordinary users and their data.'],
  ['manageResumes', 'Manage resumes', 'View and remove uploaded resumes.'],
  ['manageRequests', 'View access requests', 'See admin-access requests (cannot decide them).'],
  ['viewAudit', 'View audit log', 'Read the administrative audit trail.'],
  ['manageSettings', 'View settings', 'See system settings and provider status.'],
];

const THEMES = [
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
  ['system', 'System', Monitor],
];

export default function AdminSettings() {
  const { admin, adminLogout } = useAuth();
  const { showToast } = useToast();
  const { theme, setAppearance } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const isMain = admin?.role === 'main_admin';
  const [tab, setTab] = useState(location.state?.tab || 'profile');

  // The top-right profile dropdown deep-links here with a requested pane; honor
  // a new request even when Settings is already mounted.
  useEffect(() => {
    if (location.state?.tab) setTab(location.state.tab);
  }, [location.state?.tab]);

  const logout = () => {
    adminLogout();
    navigate('/admin/login', { replace: true });
  };

  const visibleTabs = [
    { id: 'profile', label: 'My Profile', icon: UserRound },
    { id: 'security', label: 'Security', icon: Lock },
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'contact', label: 'Contact', icon: Mail },
    isMain
      ? { id: 'administration', label: 'Administration', icon: SettingsIcon }
      : { id: 'permissions', label: 'Permissions', icon: SlidersHorizontal },
  ].filter(Boolean);

  return (
    <>
      <div className="admin-top">
        <h1>Settings</h1>
        <span className={`badge ${isMain ? 'crown' : ''}`}>
          {isMain ? <Crown size={13} /> : <ShieldCheck size={13} />} {isMain ? 'Main Admin Leader' : 'Co-Admin'}
        </span>
      </div>

      <div className="settings-layout admin-settings">
        <nav className="settings-tabs" aria-label="Admin settings sections">
          {visibleTabs.map((t) => (
            <button key={t.id} type="button" className={`settings-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}>
              <t.icon size={16} /> {t.label}
            </button>
          ))}
          <button type="button" className="settings-tab danger" onClick={logout}>
            <LogOut size={16} /> Log out
          </button>
        </nav>

        <div className="settings-pane">
          {tab === 'profile' && <ProfileSection />}
          {tab === 'security' && <SecuritySection />}
          {tab === 'appearance' && <AppearanceSection theme={theme} setAppearance={setAppearance} />}
          {tab === 'contact' && <ContactSection />}
          {tab === 'permissions' && <PermissionsSection admin={admin} />}
          {tab === 'administration' && isMain && <AdministrationSection showToast={showToast} />}
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ Profile */
const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

// Crop to a square and downscale to a small JPEG data URL so a photo persists in
// MongoDB (same base64 approach the ordinary profile page uses — never a local
// file path that would break after deployment).
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
      reject(new Error('Please choose a PNG, JPEG, WEBP or GIF image.'));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      reject(new Error('That image is too large (max 2 MB).'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const size = 320;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const s = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        let q = 0.85;
        let out = canvas.toDataURL('image/jpeg', q);
        while (out.length * 0.75 > 400 * 1024 && q > 0.4) { q -= 0.1; out = canvas.toDataURL('image/jpeg', q); }
        resolve(out);
      };
      img.onerror = () => reject(new Error('Could not read that image.'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Could not read that image.'));
    reader.readAsDataURL(file);
  });
}

function ProfileSection() {
  const { admin, updateAdmin } = useAuth();
  const { showToast } = useToast();
  const fileRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(admin?.name || '');
  const [bio, setBio] = useState(admin?.profile?.bio || '');
  const [avatar, setAvatar] = useState(admin?.profile?.avatar || '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(admin?.name || '');
    setBio(admin?.profile?.bio || '');
    setAvatar(admin?.profile?.avatar || '');
  }, [admin?.name, admin?.profile?.bio, admin?.profile?.avatar]);

  const cancel = () => {
    setEditing(false);
    setName(admin?.name || '');
    setBio(admin?.profile?.bio || '');
    setAvatar(admin?.profile?.avatar || '');
  };

  const pickPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setAvatar(await downscaleImage(file));
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!name.trim()) return showToast('Name is required.', 'error');
    setBusy(true);
    try {
      const { data } = await adminUpdateProfile({ name: name.trim(), bio, avatar });
      updateAdmin(data.admin);
      setEditing(false);
      showToast('Profile updated', 'success');
    } catch (err) {
      showToast(err?.response?.data?.message || 'Update failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const initial = (String(admin?.name || '').trim().charAt(0) || 'A').toUpperCase();

  return (
    <section>
      <h2>My Profile</h2>
      <p className="set-sub">Your photo, name and sign-in email.</p>
      <div className="admin-profile-edit">
        <div className="admin-avatar-pick">
          <span className="admin-avatar xl">{avatar ? <img src={avatar} alt="Profile photo" /> : initial}</span>
          {editing && (
            <div className="admin-avatar-actions">
              <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} hidden onChange={pickPhoto} />
              <button type="button" className="btn btn-outline btn-sm" onClick={() => fileRef.current?.click()}>
                <Camera size={14} /> Change photo
              </button>
              {avatar && (
                <button type="button" className="btn btn-outline btn-sm" onClick={() => setAvatar('')}>
                  <Trash2 size={14} /> Remove
                </button>
              )}
            </div>
          )}
          <span className="field-hint">PNG, JPEG, WEBP or GIF · max 400 KB</span>
        </div>

        <form onSubmit={save} className="form admin-profile-fields" noValidate>
          <div className="form-group">
            <label htmlFor="accName">Full name</label>
            <input id="accName" className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!editing} required />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input className="input" value={admin?.email || ''} disabled />
            <span className="field-hint">The sign-in email cannot be changed here.</span>
          </div>
          <div className="form-group">
            <label htmlFor="accBio">Short bio</label>
            <textarea id="accBio" className="input" rows={3} maxLength={500}
              value={bio} onChange={(e) => setBio(e.target.value)} disabled={!editing} />
          </div>
          {editing ? (
            <div className="row-actions">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? <><Loader2 size={15} className="spin" /> Saving...</> : <><Save size={15} /> Save Changes</>}
              </button>
              <button type="button" className="btn btn-outline" onClick={cancel} disabled={busy}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
              <Pencil size={15} /> Edit Profile
            </button>
          )}
        </form>
      </div>

      <section className="glass-card admin-section-card fade-up" style={{ marginTop: 18 }}>
        <div className="admin-section-head">
          <h3><ShieldCheck size={17} /> Account information</h3>
        </div>
        <div className="provider-grid">
          <div className="provider-row"><ShieldCheck size={16} /><span>Role</span><strong>{admin?.role === 'main_admin' ? 'Main Admin Leader' : 'Co-Admin'}</strong></div>
          <div className="provider-row"><Mail size={16} /><span>Email</span><strong>{admin?.email || '—'}</strong></div>
          <div className="provider-row"><UserRound size={16} /><span>Status</span><strong>{admin?.isActive === false ? 'Blocked' : 'Active'}</strong></div>
          <div className="provider-row"><Info size={16} /><span>Member since</span><strong>{admin?.createdAt ? new Date(admin.createdAt).toLocaleDateString() : '—'}</strong></div>
        </div>
        <p className="muted small">Your role, approval status and administrative privileges are managed on the server and can never be changed from this form.</p>
      </section>
    </section>
  );
}

/* ------------------------------------------------------------------ Contact */
function ContactSection() {
  const { admin } = useAuth();
  const [email, setEmail] = useState('');
  useEffect(() => {
    (async () => {
      try {
        const { data } = await adminMe();
        setEmail(data.mainAdminEmail || '');
      } catch {
        /* best-effort */
      }
    })();
  }, []);
  const contact = email || 'metebharath4@gmail.com';
  const isMain = admin?.role === 'main_admin';
  return (
    <section>
      <h2>Contact Information</h2>
      <p className="set-sub">Official Main Admin Leader contact.</p>
      <div className="glass-card admin-section-card fade-up">
        <div className="admin-section-head"><h3><Mail size={17} /> Main Admin Leader</h3></div>
        <p className="muted small">
          For questions about administrator access or platform management, contact the Main Admin Leader:
        </p>
        <a className="link" href={`mailto:${contact}`}>{contact}</a>
        {isMain && (
          <p className="field-hint">This is your own address, shown to other administrators as the platform contact.</p>
        )}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- Security */
function SecuritySection() {
  const { applyAdminSession } = useAuth();
  const { showToast } = useToast();
  const [session, setSession] = useState(null);
  const [revoking, setRevoking] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await adminSessions();
        setSession(data.session);
      } catch {
        /* session info is best-effort */
      }
    })();
  }, []);

  const revokeSessions = async () => {
    setRevoking(true);
    try {
      const { data } = await adminRevokeSessions();
      applyAdminSession(data.token);
      showToast('All other admin sessions were revoked', 'success');
    } catch (err) {
      showToast(err?.response?.data?.message || 'Could not revoke sessions', 'error');
    } finally {
      setRevoking(false);
    }
  };

  return (
    <section>
      <h2>Security</h2>
      <p className="set-sub">Change your password and manage where you are signed in.</p>

      <AdminChangePassword />

      <section className="glass-card admin-section-card fade-up">
        <div className="admin-section-head"><h3><ShieldCheck size={17} /> Sessions</h3></div>
        <p className="muted small">
          This admin session is stateless and versioned. Revoking signs out every OTHER device immediately
          while keeping you signed in here.
        </p>
        {session && (
          <div className="provider-grid">
            <div className="provider-row"><KeyRound size={16} /><span>Token version</span><strong>{session.tokenVersion}</strong></div>
            <div className="provider-row"><ShieldCheck size={16} /><span>Scope</span><strong>{session.scope || 'admin'}</strong></div>
            <div className="provider-row"><ShieldCheck size={16} /><span>Issued</span><strong>{session.issuedAt ? new Date(session.issuedAt).toLocaleString() : '—'}</strong></div>
            <div className="provider-row"><ShieldCheck size={16} /><span>Expires</span><strong>{session.expiresAt ? new Date(session.expiresAt).toLocaleString() : '—'}</strong></div>
          </div>
        )}
        <button className="btn btn-outline" onClick={revokeSessions} disabled={revoking}>
          {revoking ? <><Loader2 size={15} className="spin" /> Revoking...</> : <><LogOut size={15} /> Sign out all other devices</>}
        </button>
      </section>
    </section>
  );
}

/* --------------------------------------------------------------- Appearance */
function AppearanceSection({ theme, setAppearance }) {
  return (
    <section>
      <h2>Appearance</h2>
      <p className="set-sub">Choose how the admin portal looks. Saved on this device and restored next time.</p>
      <div className="form-group">
        <label>Theme</label>
        <div className="set-seg">
          {THEMES.map(([id, label, Icon]) => (
            <button key={id} type="button" className={theme === id ? 'active' : ''}
              onClick={() => setAppearance(id, null)}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        <span className="field-hint">System follows your device's light/dark setting.</span>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- Permissions */
function PermissionsSection({ admin }) {
  const granted = PERMS.filter(([k]) => admin?.adminPermissions?.[k]);
  return (
    <section>
      <h2>Permissions</h2>
      <p className="set-sub">These are the admin capabilities the Main Admin Leader has granted your account.</p>
      {granted.length === 0 ? (
        <div className="inline-note info"><Info size={16} /> No extra permissions granted yet.</div>
      ) : (
        <ul className="admin-list">
          {granted.map(([k, label, desc]) => (
            <li key={k}>
              <div className="admin-list-main"><strong>{label}</strong><span className="muted small">{desc}</span></div>
              <span className="badge ok">Granted</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small admin-footer-note">
        <Crown size={13} /> Approving requests, managing administrators and changing system settings stay restricted to the Main Admin Leader.
      </p>
    </section>
  );
}

/* ----------------------------------------------------------- Administration */
function AdministrationSection({ showToast }) {
  const [settings, setSettings] = useState(null);
  const [providers, setProviders] = useState({});
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [uploadMaxMB, setUploadMaxMB] = useState(10);
  const [dailyLimit, setDailyLimit] = useState(0);
  const [minuteLimit, setMinuteLimit] = useState(0);
  const [maintEnabled, setMaintEnabled] = useState(false);
  const [maintMessage, setMaintMessage] = useState('');

  const apply = (data) => {
    setSettings(data.settings);
    setProviders(data.providers || {});
    setUploadMaxMB(data.settings.uploadLimits.resumeMaxMB);
    setDailyLimit(data.settings.aiLimits.dailyRequestLimit);
    setMinuteLimit(data.settings.aiLimits.perMinuteUserLimit);
    setMaintEnabled(data.settings.maintenanceMode.enabled);
    setMaintMessage(data.settings.maintenanceMode.message);
  };

  useEffect(() => {
    (async () => {
      try {
        const { data } = await getAdminSettings();
        apply(data);
      } catch (err) {
        showToast(err?.response?.data?.message || 'Failed to load settings', 'error');
      } finally {
        setLoading(false);
      }
      try {
        const { data } = await getSystemHealth();
        setHealth(data.system || null);
      } catch { /* health is best-effort */ }
    })();
  }, [showToast]);

  const save = async (patch, successMsg) => {
    setSaving(true);
    try {
      const { data } = await updateAdminSettings(patch);
      apply(data);
      showToast(successMsg || 'Settings saved', 'success');
    } catch (err) {
      showToast(err?.response?.data?.message || 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loading label="Loading settings..." />;

  const quickLinks = [
    { to: '/admin/controls', state: { tab: 'requests' }, label: 'Admin Controls', desc: 'Pending requests, approved administrators and regular users.', icon: ShieldHalf },
    { to: '/admin/audit', label: 'Review Audit Logs', desc: 'Append-only record of administrative actions.', icon: ScrollText },
  ];

  return (
    <section>
      <h2>Administration</h2>
      <p className="set-sub">Controls only the Main Admin Leader can use.</p>

      <div className="admin-quicklinks">
        {quickLinks.map((l) => (
          <Link key={l.to} to={l.to} state={l.state} className="admin-quicklink">
            <span className="aql-icon"><l.icon size={18} /></span>
            <span className="aql-text"><strong>{l.label}</strong><span className="muted small">{l.desc}</span></span>
            <ChevronRight size={18} />
          </Link>
        ))}
      </div>

      {/* Upload limits */}
      <section className="glass-card admin-section-card fade-up">
        <div className="admin-section-head"><h3><HardDriveUpload size={17} /> Account &amp; Upload Limits</h3></div>
        <div className="form-group admin-inline">
          <label htmlFor="resumeMax">Max resume size (MB)</label>
          <input id="resumeMax" type="number" min={1} max={50} className="input admin-num"
            value={uploadMaxMB} onChange={(e) => setUploadMaxMB(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={saving}
          onClick={() => save({ uploadLimits: { resumeMaxMB: Number(uploadMaxMB) } }, 'Upload limit saved')}>
          {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Save
        </button>
      </section>

      {/* AI limits */}
      <section className="glass-card admin-section-card fade-up">
        <div className="admin-section-head"><h3><Sparkles size={17} /> AI Limits <span className="muted small">(0 = unlimited)</span></h3></div>
        <div className="form-group admin-inline">
          <label htmlFor="dailyLimit">Daily AI request limit (all users)</label>
          <input id="dailyLimit" type="number" min={0} className="input admin-num"
            value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
        </div>
        <div className="form-group admin-inline">
          <label htmlFor="minuteLimit">Per-user request limit per minute</label>
          <input id="minuteLimit" type="number" min={0} max={1000} className="input admin-num"
            value={minuteLimit} onChange={(e) => setMinuteLimit(e.target.value)} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={saving}
          onClick={() => save({ aiLimits: { dailyRequestLimit: Number(dailyLimit), perMinuteUserLimit: Number(minuteLimit) } }, 'AI limits saved')}>
          {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Save
        </button>
      </section>

      {/* Maintenance mode */}
      <section className={`glass-card admin-section-card fade-up ${maintEnabled ? 'maint-on' : ''}`}>
        <div className="admin-section-head">
          <h3><Wrench size={17} /> Maintenance Mode</h3>
          <span className={`badge ${maintEnabled ? 'warn' : 'ok'}`}>{maintEnabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <p className="muted small">
          When enabled, ordinary API traffic returns an honest 503 with your message. Sign-in, health checks
          and the admin portal stay reachable so you can always turn it back off.
        </p>
        <div className="form-group admin-inline">
          <label htmlFor="maintMsg">Message shown to users</label>
          <input id="maintMsg" type="text" maxLength={300} className="input"
            value={maintMessage} onChange={(e) => setMaintMessage(e.target.value)} />
        </div>
        <div className="row-actions">
          <button className={`btn ${maintEnabled ? 'btn-outline' : 'btn-primary'} btn-sm`} disabled={saving}
            onClick={() => save({ maintenanceMode: { enabled: !maintEnabled, message: maintMessage } },
              maintEnabled ? 'Maintenance mode disabled' : 'Maintenance mode enabled')}>
            {saving ? <Loader2 size={15} className="spin" /> : <Wrench size={15} />}
            {maintEnabled ? ' Disable maintenance' : ' Enable maintenance'}
          </button>
          {settings && maintMessage !== settings.maintenanceMode?.message && (
            <button className="btn btn-outline btn-sm" disabled={saving}
              onClick={() => save({ maintenanceMode: { message: maintMessage } }, 'Message saved')}>
              Save message
            </button>
          )}
        </div>
      </section>

      {/* Backend + provider status (health only — never keys) */}
      <section className="glass-card admin-section-card fade-up">
        <div className="admin-section-head">
          <h3><Activity size={17} /> Backend &amp; Provider Status <span className="muted small">(no keys are ever shown)</span></h3>
        </div>
        <div className="provider-grid">
          <div className="provider-row"><Database size={16} /><span>Database</span><strong>{providers.mongodb || (health?.mongodb ?? '—')}</strong></div>
          <div className="provider-row"><Activity size={16} /><span>Backend API</span><strong>{health?.backend === 'online' ? 'Online' : (providers.backend || '—')}</strong></div>
          <div className="provider-row"><Brain size={16} /><span>AI provider</span><strong>{providers.aiProvider || '—'}</strong></div>
          <div className="provider-row"><Sparkles size={16} /><span>Model</span><strong>{providers.aiModel || '—'}</strong></div>
          <div className="provider-row"><Mic size={16} /><span>Speech-to-Text</span><strong>{providers.speechToText || '—'}</strong></div>
          <div className="provider-row"><Mic size={16} /><span>Text-to-Speech</span><strong>{providers.textToSpeech || '—'}</strong></div>
          <div className="provider-row"><ImageIcon size={16} /><span>Image Generation</span><strong>{providers.imageGeneration || '—'}</strong></div>
          <div className="provider-row"><Database size={16} /><span>Embeddings</span><strong>{providers.embeddings || '—'}</strong></div>
          <div className="provider-row"><Activity size={16} /><span>Web Search</span><strong>{providers.webSearch || '—'}</strong></div>
        </div>
      </section>

      <p className="muted small admin-footer-note">
        <Crown size={13} /> Settings changes are recorded in the audit log.
      </p>
    </section>
  );
}
