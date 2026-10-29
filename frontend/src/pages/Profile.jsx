import { useEffect, useState } from 'react';
import { UserRound, Mail, Loader2, Save } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import { updateProfile } from '../services/authService';
import { getResume, getJob } from '../services/resumeService';
import Avatar from '../components/Avatar.jsx';

export default function Profile() {
  const { user, updateUser } = useAuth();
  const { showToast } = useToast();

  const [form, setForm] = useState({
    name: user?.name || '',
    title: user?.profile?.title || '',
    company: user?.profile?.company || '',
    location: user?.profile?.location || '',
    bio: user?.profile?.bio || '',
    skills: (user?.profile?.skills || []).join(', '),
    targetRoles: (user?.profile?.preferences?.targetRoles || []).join(', '),
  });
  const [saving, setSaving] = useState(false);
  const [resume, setResume] = useState(null);
  const [job, setJob] = useState(null);

  useEffect(() => {
    Promise.allSettled([getResume(), getJob()]).then(([r, j]) => {
      if (r.status === 'fulfilled') setResume(r.value.data.resume);
      if (j.status === 'fulfilled') setJob(j.value.data.job);
    });
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSave = async () => {
    if (!form.name.trim()) return showToast('Name cannot be empty.', 'error');
    setSaving(true);
    try {
      const payload = {
        name: form.name,
        profile: {
          title: form.title,
          company: form.company,
          location: form.location,
          bio: form.bio,
          skills: form.skills.split(',').map((s) => s.trim()).filter(Boolean),
          preferences: {
            targetRoles: form.targetRoles.split(',').map((s) => s.trim()).filter(Boolean),
            industries: (user?.profile?.preferences?.industries || []),
          },
        },
      };
      const { data } = await updateProfile(payload);
      updateUser(data.user);
      showToast('Profile updated');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <p className="muted">Your account and career preferences.</p>
        </div>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? <><Loader2 size={16} className="spin" /> Saving...</> : <><Save size={16} /> Save</>}
        </button>
      </div>

      <div className="profile-grid">
        <div className="glass-card profile-card fade-up">
          <Avatar user={user} className="profile-avatar" />
          <h3>{user?.name}</h3>
          <p className="muted"><Mail size={13} /> {user?.email}</p>
          <p className="muted small">Member since {new Date(user?.createdAt).toLocaleDateString()}</p>

          <div className="profile-stats">
            <div><strong>Resume</strong><span className={resume ? 'ok' : 'not-ok'}>{resume ? 'Uploaded' : 'Not uploaded'}</span></div>
            <div><strong>Target Role</strong><span>{job?.jobTitle || '—'}</span></div>
            <div><strong>Target Company</strong><span>{job?.company || '—'}</span></div>
            <div><strong>Skills</strong><span>{resume?.parsed?.skills?.length || user?.profile?.skills?.length || 0} detected</span></div>
          </div>
        </div>

        <div className="glass-card form-card fade-up">
          <h3 className="subsection-title">Edit details</h3>
          <div className="form-group">
            <label htmlFor="name"><UserRound size={15} /> Full Name</label>
            <input id="name" className="input" value={form.name} onChange={set('name')} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="title">Current / target title</label>
              <input id="title" className="input" placeholder="e.g. Backend Developer" value={form.title} onChange={set('title')} />
            </div>
            <div className="form-group">
              <label htmlFor="company">Company</label>
              <input id="company" className="input" placeholder="e.g. Acme Corp" value={form.company} onChange={set('company')} />
            </div>
          </div>
          <div className="form-group">
            <label htmlFor="location">Location</label>
            <input id="location" className="input" placeholder="City, Country" value={form.location} onChange={set('location')} />
          </div>
          <div className="form-group">
            <label htmlFor="bio">Short bio</label>
            <textarea id="bio" className="input textarea" rows={3} placeholder="A line about you..." value={form.bio} onChange={set('bio')} />
          </div>
          <div className="form-group">
            <label htmlFor="skills">Skills (comma separated)</label>
            <input id="skills" className="input" placeholder="Java, Spring Boot, SQL" value={form.skills} onChange={set('skills')} />
          </div>
          <div className="form-group">
            <label htmlFor="targetRoles">Career preferences / target roles (comma separated)</label>
            <input id="targetRoles" className="input" placeholder="Backend Developer, Full Stack" value={form.targetRoles} onChange={set('targetRoles')} />
          </div>
        </div>
      </div>
    </div>
  );
}