import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  UserRound, Lock, Palette, MessageSquare, Bell, ShieldCheck, KeyRound,
  Eye, EyeOff, Loader2, Download, Trash2, LogOut, ArrowLeft, Check, Sun, Moon, Monitor,
  Send, CheckCircle2, XCircle, Clock,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { useTheme } from '../context/ThemeContext';
import {
  getSettings, updateProfileSettings, updatePreferences, changePassword,
  exportMyData, clearChatHistory, deleteAccount, fileToAvatarDataUrl,
} from '../services/settingsService';

const DEFAULT_SETTINGS = {
  appearance: { theme: 'system', accent: 'violet' },
  chat: { enterToSend: true, confirmDelete: true, responseStyle: 'balanced', language: 'auto', voicePlayback: false },
  notifications: { product: false },
};

const TABS = [
  { id: 'profile', label: 'My Profile', icon: UserRound },
  { id: 'security', label: 'Security', icon: Lock },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'chat', label: 'Chat Preferences', icon: MessageSquare },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'privacy', label: 'Privacy & Data', icon: ShieldCheck },
  { id: 'account', label: 'Account', icon: KeyRound },
];

const ACCENTS = [
  { id: 'violet', color: '#8b5cf6' },
  { id: 'pink', color: '#ec4899' },
  { id: 'indigo', color: '#6366f1' },
  { id: 'teal', color: '#14b8a6' },
  { id: 'amber', color: '#f59e0b' },
];

function normalizeSettings(raw) {
  const d = DEFAULT_SETTINGS;
  const ap = raw?.appearance || {};
  const ch = raw?.chat || {};
  const no = raw?.notifications || {};
  return {
    appearance: {
      theme: ['light', 'dark', 'system'].includes(ap.theme) ? ap.theme : d.appearance.theme,
      accent: ACCENTS.some((a) => a.id === ap.accent) ? ap.accent : d.appearance.accent,
    },
    chat: {
      enterToSend: ch.enterToSend !== undefined ? !!ch.enterToSend : d.chat.enterToSend,
      confirmDelete: ch.confirmDelete !== undefined ? !!ch.confirmDelete : d.chat.confirmDelete,
      responseStyle: ['concise', 'balanced', 'detailed'].includes(ch.responseStyle) ? ch.responseStyle : d.chat.responseStyle,
      language: (typeof ch.language === 'string' && ch.language.trim()) ? ch.language.trim() : d.chat.language,
      voicePlayback: ch.voicePlayback !== undefined ? !!ch.voicePlayback : d.chat.voicePlayback,
    },
    notifications: { product: no.product !== undefined ? !!no.product : d.notifications.product },
  };
}

export default function Settings() {
  const { user, updateUser, logout, adminRequestStatus, requestAdminAccess } = useAuth();
  const { showToast } = useToast();
  const { setAppearance } = useTheme();

  const [tab, setTab] = useState('profile');
  const [settings, setSettings] = useState(() => normalizeSettings(user?.settings));
  const [stats, setStats] = useState(null);

  // Profile form state
  const [editProfile, setEditProfile] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', bio: '' });
  const [pendingAvatar, setPendingAvatar] = useState(null); // null | '' | dataURL
  const [savingProfile, setSavingProfile] = useState(false);

  // Password state
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [showPw, setShowPw] = useState({ current: false, next: false, confirm: false });
  const [savingPw, setSavingPw] = useState(false);

  // Privacy / account state
  const [exporting, setExporting] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletePw, setDeletePw] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Administrator-access request (a normal user asking to be considered).
  const [adminReq, setAdminReq] = useState({ loading: true, request: null, canRequest: true });
  const [adminReason, setAdminReason] = useState('');
  const [adminPw, setAdminPw] = useState('');
  const [sendingReq, setSendingReq] = useState(false);

  const avatarSrc = useMemo(() => {
    if (pendingAvatar !== null) return pendingAvatar;
    return user?.profile?.avatar || '';
  }, [pendingAvatar, user]);

  const initials = useMemo(() => {
    const source = (user?.name || '?').trim();
    return (source.split(/\s+/).map((w) => w.charAt(0)).join('').slice(0, 2) || '?').toUpperCase();
  }, [user]);

  const syncProfileForm = () => {
    setForm({ name: user?.name || '', email: user?.email || '', bio: user?.profile?.bio || '' });
    setPendingAvatar(null);
  };

  // Seed the form from the single source of truth (AuthContext user) on mount
  // and whenever the profile changes underneath us — but NEVER while the user is
  // actively editing, so saving an unrelated preference cannot wipe unsaved
  // profile edits or a freshly picked (not yet saved) photo.
  useEffect(() => {
    if (!editProfile) syncProfileForm();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [user, editProfile]);

  useEffect(() => {
    let active = true;
    getSettings()
      .then(({ data }) => {
        if (!active) return;
        if (data?.settings) setSettings(normalizeSettings(data.settings));
        if (data?.stats) setStats(data.stats);
      })
      .catch(() => { /* keep local settings; the page still works */ });
    return () => { active = false; };
  }, []);

  // Load this user's admin-access request status (their own request only).
  useEffect(() => {
    let active = true;
    adminRequestStatus()
      .then(({ data }) => {
        if (!active) return;
        setAdminReq({ loading: false, request: data?.request || null, canRequest: data?.canRequest !== false });
      })
      .catch(() => { if (active) setAdminReq({ loading: false, request: null, canRequest: true }); });
    return () => { active = false; };
  }, [adminRequestStatus]);

  const submitAdminRequest = async () => {
    if (adminReason.trim().length < 5) return showToast('Please provide a short reason (at least 5 characters).', 'error');
    if (!adminPw) return showToast('Enter your account password to confirm.', 'error');
    setSendingReq(true);
    try {
      const { data } = await requestAdminAccess({ email: user?.email, password: adminPw, reason: adminReason.trim() });
      setAdminReq({ loading: false, request: data?.request || { status: 'pending' }, canRequest: false });
      setAdminReason('');
      setAdminPw('');
      showToast(data?.code === 'ALREADY_PENDING' ? 'Your request is already pending.' : 'Request submitted for the Main Admin Leader to review.', 'success');
    } catch (err) {
      showToast(err?.response?.data?.message || 'Could not submit the request.', 'error');
    } finally {
      setSendingReq(false);
    }
  };

  // ---- Profile ----
  const onPickAvatar = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      setPendingAvatar(dataUrl);
      setEditProfile(true);
      showToast('Photo ready — click Save Changes to apply.', 'info');
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const saveProfile = async () => {
    const name = form.name.trim();
    const email = form.email.trim().toLowerCase();
    if (!name) return showToast('Please enter your full name.', 'error');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showToast('Please enter a valid email address.', 'error');
    setSavingProfile(true);
    try {
      const payload = { name, email, bio: form.bio };
      if (pendingAvatar !== null) payload.avatar = pendingAvatar;
      const { data } = await updateProfileSettings(payload);
      if (data?.user) updateUser(data.user);
      setPendingAvatar(null);
      setEditProfile(false);
      showToast('Profile updated', 'success');
    } catch (err) {
      showToast(err?.response?.data?.message || 'Could not save your profile.', 'error');
    } finally {
      setSavingProfile(false);
    }
  };

  const cancelProfile = () => { syncProfileForm(); setEditProfile(false); };

  // ---- Password ----
  const submitPassword = async () => {
    if (!pw.current) return showToast('Enter your current password.', 'error');
    if (pw.next.length < 6) return showToast('New password must be at least 6 characters.', 'error');
    if (pw.next !== pw.confirm) return showToast('New passwords do not match.', 'error');
    if (pw.next === pw.current) return showToast('New password must be different from the current one.', 'error');
    setSavingPw(true);
    try {
      await changePassword({ currentPassword: pw.current, newPassword: pw.next, confirmPassword: pw.confirm });
      setPw({ current: '', next: '', confirm: '' });
      showToast('Password updated', 'success');
    } catch (err) {
      showToast(err?.response?.data?.message || 'Could not update your password.', 'error');
    } finally {
      setSavingPw(false);
    }
  };

  // ---- Preferences (appearance / chat / notifications) ----
  const savePrefs = async (patch, okText) => {
    try {
      const { data } = await updatePreferences(patch);
      if (data?.settings) {
        setSettings(normalizeSettings(data.settings));
        // Keep the auth user in sync so the chat page reads the new chat
        // preferences and the theme context adopts them immediately.
        updateUser({ ...user, settings: data.settings });
      }
      if (okText) showToast(okText, 'success');
    } catch (err) {
      showToast(err?.response?.data?.message || 'Could not save that preference.', 'error');
    }
  };

  const pickTheme = (theme) => {
    setSettings((s) => ({ ...s, appearance: { ...s.appearance, theme } }));
    setAppearance(theme, null);
    savePrefs({ appearance: { theme } }, 'Theme saved');
  };
  const pickAccent = (accent) => {
    setSettings((s) => ({ ...s, appearance: { ...s.appearance, accent } }));
    setAppearance(null, accent);
    savePrefs({ appearance: { accent } }, 'Accent saved');
  };
  const setChat = (key, value) => {
    setSettings((s) => ({ ...s, chat: { ...s.chat, [key]: value } }));
    savePrefs({ chat: { [key]: value } }, 'Preference saved');
  };
  const setProduct = (value) => {
    setSettings((s) => ({ ...s, notifications: { ...s.notifications, product: value } }));
    savePrefs({ notifications: { product: value } }, 'Notification preference saved');
  };

  // ---- Privacy ----
  const doExport = async () => {
    setExporting(true);
    try {
      const { data } = await exportMyData();
      const payload = data?.data || data;
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'my-career-ai-data.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      showToast('Data export downloaded', 'success');
    } catch (err) {
      showToast(err?.response?.data?.message || 'Could not export your data.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const doClearHistory = async () => {
    if (!window.confirm('Delete ALL of your conversations?\n\nThis cannot be undone. Your resume, job description, uploads and account are kept.')) return;
    setClearingHistory(true);
    try {
      await clearChatHistory();
      showToast('Chat history cleared', 'success');
      setStats((s) => (s ? { ...s, conversationCount: 0 } : s));
    } catch (err) {
      showToast(err?.response?.data?.message || 'Could not clear your chat history.', 'error');
    } finally {
      setClearingHistory(false);
    }
  };

  const doDeleteAccount = async () => {
    if (!deletePw) return showToast('Enter your password to confirm.', 'error');
    setDeleting(true);
    try {
      await deleteAccount(deletePw);
      showToast('Your account and data were deleted.', 'success');
      logout();
      window.location.href = '/';
    } catch (err) {
      showToast(err?.response?.data?.message || 'Could not delete your account.', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const memberSince = stats?.memberSince || user?.createdAt;

  return (
    <div className="page settings-page">
      <div className="page-head settings-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Manage your account, security and app preferences.</p>
        </div>
        <Link to="/dashboard/career-assistant" className="btn btn-outline btn-sm">
          <ArrowLeft size={15} /> Back to chat
        </Link>
      </div>

      <div className="settings-card fade-up">
        <div className="settings-layout">
          <nav className="settings-tabs" aria-label="Settings sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`settings-tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <t.icon size={16} /> {t.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane">
            {/* ---------- PROFILE ---------- */}
            {tab === 'profile' && (
              <section>
                <h2>My Profile</h2>
                <p className="set-sub">Update your name, photo, email and a short bio.</p>
                <div className="set-avatar-row">
                  <div className="set-avatar">
                    {avatarSrc ? <img src={avatarSrc} alt="" /> : initials}
                  </div>
                  <div>
                    <label className="set-btn ghost" style={{ cursor: 'pointer' }}>
                      Change photo
                      <input type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }} onChange={onPickAvatar} />
                    </label>
                    {avatarSrc && (
                      <button type="button" className="set-btn ghost" style={{ marginLeft: 8 }} onClick={() => { setPendingAvatar(''); setEditProfile(true); }}>
                        Remove
                      </button>
                    )}
                    <div className="set-help">PNG, JPG or WebP. Large photos are resized automatically.</div>
                  </div>
                </div>
                <div className="set-field">
                  <label htmlFor="set-name">Full name</label>
                  <input id="set-name" className="set-input" maxLength={100} disabled={!editProfile} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="set-field">
                  <label htmlFor="set-email">Email address</label>
                  <input id="set-email" type="email" className="set-input" disabled={!editProfile} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
                </div>
                <div className="set-field">
                  <label htmlFor="set-bio">Short bio (optional)</label>
                  <textarea id="set-bio" className="set-input" maxLength={500} disabled={!editProfile} placeholder="A sentence or two about you…" value={form.bio} onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))} />
                </div>
                <div className="set-actions">
                  {!editProfile ? (
                    <button type="button" className="set-btn ghost" onClick={() => setEditProfile(true)}>✏️ Edit Profile</button>
                  ) : (
                    <>
                      <button type="button" className="set-btn primary" onClick={saveProfile} disabled={savingProfile}>
                        {savingProfile ? <><Loader2 size={15} className="spin" /> Saving…</> : <><Check size={15} /> Save Changes</>}
                      </button>
                      <button type="button" className="set-btn ghost" onClick={cancelProfile} disabled={savingProfile}>Cancel</button>
                    </>
                  )}
                </div>
              </section>
            )}

            {/* ---------- SECURITY ---------- */}
            {tab === 'security' && (
              <section>
                <h2>Account Security</h2>
                <p className="set-sub">Change your password. You must enter your current password to confirm.</p>
                {[
                  ['current', 'Current password'],
                  ['next', 'New password'],
                  ['confirm', 'Confirm new password'],
                ].map(([key, label]) => (
                  <div className="set-field" key={key}>
                    <label htmlFor={`pw-${key}`}>{label}</label>
                    <div className="set-pw-wrap">
                      <input
                        id={`pw-${key}`}
                        type={showPw[key] ? 'text' : 'password'}
                        className="set-input"
                        autoComplete={key === 'current' ? 'current-password' : 'new-password'}
                        value={pw[key]}
                        onChange={(e) => setPw((p) => ({ ...p, [key]: e.target.value }))}
                      />
                      <button type="button" className="set-pw-toggle" onClick={() => setShowPw((s) => ({ ...s, [key]: !s[key] }))} aria-label={showPw[key] ? `Hide ${label}` : `Show ${label}`}>
                        {showPw[key] ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>
                ))}
                <div className="set-actions">
                  <button type="button" className="set-btn primary" onClick={submitPassword} disabled={savingPw}>
                    {savingPw ? <><Loader2 size={15} className="spin" /> Updating…</> : 'Update password'}
                  </button>
                </div>
                <div className="set-divider" />
                <p className="set-sub" style={{ marginBottom: 8 }}>Forgot your current password? Reset it securely with an email code.</p>
                <Link className="set-link" to="/forgot-password">Forgot password?</Link>
              </section>
            )}

            {/* ---------- APPEARANCE ---------- */}
            {tab === 'appearance' && (
              <section>
                <h2>Appearance</h2>
                <p className="set-sub">Choose how the app looks. Saved to your account and restored on your next login.</p>
                <div className="set-field">
                  <label>Theme</label>
                  <div className="set-seg">
                    <button type="button" className={settings.appearance.theme === 'light' ? 'active' : ''} onClick={() => pickTheme('light')}><Sun size={14} /> Light</button>
                    <button type="button" className={settings.appearance.theme === 'dark' ? 'active' : ''} onClick={() => pickTheme('dark')}><Moon size={14} /> Dark</button>
                    <button type="button" className={settings.appearance.theme === 'system' ? 'active' : ''} onClick={() => pickTheme('system')}><Monitor size={14} /> System</button>
                  </div>
                  <div className="set-help">System follows your device's light/dark setting.</div>
                </div>
                <div className="set-field">
                  <label>Accent colour</label>
                  <div className="set-accent">
                    {ACCENTS.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        className={`set-swatch ${settings.appearance.accent === a.id ? 'active' : ''}`}
                        style={{ background: a.color }}
                        title={a.id}
                        aria-label={`${a.id} accent`}
                        onClick={() => pickAccent(a.id)}
                      />
                    ))}
                  </div>
                  <div className="set-help">Accent tints buttons, the brand mark and highlights.</div>
                </div>
              </section>
            )}

            {/* ---------- CHAT ---------- */}
            {tab === 'chat' && (
              <section>
                <h2>Chat Preferences</h2>
                <p className="set-sub">Control how the assistant replies and how the composer behaves.</p>
                <div className="set-row">
                  <div><div className="sr-title">Enter to send</div><div className="sr-desc">Send with Enter. Turn off to use Enter for a new line (send with the button).</div></div>
                  <label className="set-switch"><input type="checkbox" checked={settings.chat.enterToSend} onChange={(e) => setChat('enterToSend', e.target.checked)} /><i /></label>
                </div>
                <div className="set-row">
                  <div><div className="sr-title">Confirm before deleting a chat</div><div className="sr-desc">Ask before a conversation is deleted.</div></div>
                  <label className="set-switch"><input type="checkbox" checked={settings.chat.confirmDelete} onChange={(e) => setChat('confirmDelete', e.target.checked)} /><i /></label>
                </div>
                <div className="set-row">
                  <div><div className="sr-title">Voice playback</div><div className="sr-desc">Read each new answer aloud automatically.</div></div>
                  <label className="set-switch"><input type="checkbox" checked={settings.chat.voicePlayback} onChange={(e) => setChat('voicePlayback', e.target.checked)} /><i /></label>
                </div>
                <div className="set-field" style={{ marginTop: 16 }}>
                  <label>Default answer style</label>
                  <div className="set-seg">
                    {['concise', 'balanced', 'detailed'].map((s) => (
                      <button key={s} type="button" className={settings.chat.responseStyle === s ? 'active' : ''} onClick={() => setChat('responseStyle', s)}>{s[0].toUpperCase() + s.slice(1)}</button>
                    ))}
                  </div>
                  <div className="set-help">A request like “explain in 1000 words” always overrides this style.</div>
                </div>
                <div className="set-field">
                  <label htmlFor="set-lang">Preferred language</label>
                  <input id="set-lang" className="set-input" list="settings-langs" placeholder="Auto — match the language I write in" value={settings.chat.language === 'auto' ? '' : settings.chat.language} onChange={(e) => setSettings((s) => ({ ...s, chat: { ...s.chat, language: e.target.value } }))} onBlur={() => setChat('language', settings.chat.language.trim() || 'auto')} />
                  <datalist id="settings-langs">
                    <option value="auto" /><option value="English" /><option value="Hindi" /><option value="Telugu" /><option value="Tamil" /><option value="Spanish" /><option value="French" /><option value="German" /><option value="Arabic" />
                  </datalist>
                  <div className="set-help">The assistant replies in the language you write in; this is the fallback when it is unclear.</div>
                </div>
              </section>
            )}

            {/* ---------- NOTIFICATIONS ---------- */}
            {tab === 'notifications' && (
              <section>
                <h2>Notifications</h2>
                <p className="set-sub">Only the notifications this app actually sends are listed here.</p>
                <div className="set-row">
                  <div><div className="sr-title">Account &amp; security emails <span className="set-badge">Required</span></div><div className="sr-desc">Important messages such as your password-reset verification code. Always on.</div></div>
                  <label className="set-switch"><input type="checkbox" checked disabled /><i /></label>
                </div>
                <div className="set-row">
                  <div><div className="sr-title">Product updates &amp; tips</div><div className="sr-desc">Occasional emails about new features and career tips. Off by default; change this anytime.</div></div>
                  <label className="set-switch"><input type="checkbox" checked={settings.notifications.product} onChange={(e) => setProduct(e.target.checked)} /><i /></label>
                </div>
                <p className="set-help" style={{ marginTop: 14 }}>We never send product email without your consent, and never for a feature that does not exist.</p>
              </section>
            )}

            {/* ---------- PRIVACY ---------- */}
            {tab === 'privacy' && (
              <section>
                <h2>Privacy &amp; Data</h2>
                <p className="set-sub">You are in control of your data. These actions only affect your own account.</p>
                <div className="set-row">
                  <div><div className="sr-title">Export my data</div><div className="sr-desc">Download a JSON file with your profile, settings and conversations.</div></div>
                  <button type="button" className="set-btn ghost" onClick={doExport} disabled={exporting}>
                    {exporting ? <><Loader2 size={15} className="spin" /> Exporting…</> : <><Download size={15} /> Export</>}
                  </button>
                </div>
                <div className="set-row">
                  <div><div className="sr-title">Clear chat history</div><div className="sr-desc">Permanently delete all of your conversations and generated images. Your resume, job description and account are kept.</div></div>
                  <button type="button" className="set-btn ghost" onClick={doClearHistory} disabled={clearingHistory}>
                    {clearingHistory ? <><Loader2 size={15} className="spin" /> Clearing…</> : <><Trash2 size={15} /> Clear history</>}
                  </button>
                </div>
              </section>
            )}

            {/* ---------- ACCOUNT ---------- */}
            {tab === 'account' && (
              <section>
                <h2>Account</h2>
                <p className="set-sub">Your account details and account-level actions.</p>
                <div className="set-acct">
                  <div className="acct-row"><span>Name</span><span>{user?.name || '—'}</span></div>
                  <div className="acct-row"><span>Email</span><span>{user?.email || '—'}</span></div>
                  <div className="acct-row"><span>Member since</span><span>{memberSince ? new Date(memberSince).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : '—'}</span></div>
                  <div className="acct-row"><span>Conversations</span><span>{stats?.conversationCount ?? '—'}</span></div>
                </div>

                <div className="set-divider" />
                <div className="set-admin">
                  <div className="sa-title"><ShieldCheck size={15} /> Administrator access</div>
                  {adminReq.loading ? (
                    <div className="sa-desc">Checking your request status…</div>
                  ) : adminReq.request && adminReq.request.status === 'pending' ? (
                    <div className="set-msg ok"><Clock size={14} /> Your request is pending review by the Main Admin Leader.</div>
                  ) : (
                    <>
                      {adminReq.request && adminReq.request.status === 'rejected' && (
                        <div className="set-msg err">
                          <XCircle size={14} /> Your previous request was rejected
                          {adminReq.request.decisionNote ? `: ${adminReq.request.decisionNote}` : '.'}
                        </div>
                      )}
                      {adminReq.request && adminReq.request.status === 'revoked' && (
                        <div className="set-msg err"><XCircle size={14} /> Your administrator access was revoked.</div>
                      )}
                      {adminReq.canRequest && (
                        <>
                          <p className="sa-desc">
                            Request administrator access. The Main Admin Leader reviews every request —
                            a request grants no access by itself.
                          </p>
                          <div className="set-field">
                            <label htmlFor="admin-reason">Why do you need access?</label>
                            <textarea id="admin-reason" className="set-input" rows={3} maxLength={500}
                              value={adminReason} onChange={(e) => setAdminReason(e.target.value)}
                              placeholder="Briefly explain your reason…" />
                          </div>
                          <div className="set-field">
                            <label htmlFor="admin-req-pw">Confirm your password</label>
                            <input id="admin-req-pw" type="password" className="set-input" autoComplete="current-password"
                              value={adminPw} onChange={(e) => setAdminPw(e.target.value)} />
                          </div>
                          <div className="set-actions">
                            <button type="button" className="set-btn primary" onClick={submitAdminRequest} disabled={sendingReq}>
                              {sendingReq ? <><Loader2 size={15} className="spin" /> Submitting…</> : <><Send size={15} /> Request access</>}
                            </button>
                          </div>
                        </>
                      )}
                      {adminReq.request && adminReq.request.status === 'approved' && (
                        <div className="set-msg info"><CheckCircle2 size={14} /> You already have administrator access.</div>
                      )}
                    </>
                  )}
                </div>

                <div className="set-actions" style={{ marginTop: 16 }}>
                  <button type="button" className="set-btn ghost" onClick={() => { logout(); window.location.href = '/'; }}>
                    <LogOut size={15} /> Log out
                  </button>
                </div>
                <div className="set-divider" />
                <div className="set-danger">
                  <div className="sd-title">Delete my account</div>
                  <div className="sd-desc">This permanently deletes your account, profile, conversations, generated images, uploaded resumes and job descriptions. This cannot be undone.</div>
                  {confirmDelete ? (
                    <>
                      <div className="set-field">
                        <label htmlFor="del-pw">Enter your password to confirm</label>
                        <input id="del-pw" type="password" className="set-input" autoComplete="current-password" value={deletePw} onChange={(e) => setDeletePw(e.target.value)} />
                      </div>
                      <div className="set-actions">
                        <button type="button" className="set-btn danger solid" onClick={doDeleteAccount} disabled={deleting}>
                          {deleting ? <><Loader2 size={15} className="spin" /> Deleting…</> : 'Permanently delete'}
                        </button>
                        <button type="button" className="set-btn ghost" onClick={() => { setConfirmDelete(false); setDeletePw(''); }}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <button type="button" className="set-btn danger" onClick={() => setConfirmDelete(true)}>Delete account</button>
                  )}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
