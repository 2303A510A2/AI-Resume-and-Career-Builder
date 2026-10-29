import { useState } from 'react';
import { Wand2, Loader2, FileText, ShieldCheck } from 'lucide-react';
import { improveResumeSection } from '../services/resumeService';
import { useToast } from '../hooks/useToast';

const FEATURES = [
  { key: 'summary', label: 'Improve Summary', icon: FileText },
  { key: 'skills', label: 'Improve Skills Section', icon: FileText },
  { key: 'project', label: 'Improve Project Description', icon: FileText },
  { key: 'experience', label: 'Improve Experience', icon: FileText },
  { key: 'optimize', label: 'Optimize Resume for JD', icon: Wand2 },
  { key: 'bullets', label: 'Improve Bullet Points', icon: FileText },
];

export default function ResumeImprover() {
  const { showToast } = useToast();
  const [feature, setFeature] = useState('summary');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleImprove = async () => {
    if (!text.trim()) return showToast('Paste the section you want improved first.', 'error');
    setLoading(true);
    setResult(null);
    try {
      const { data } = await improveResumeSection(feature, text);
      setResult(data);
      showToast(data.reason?.length ? 'Improvement generated' : 'Improvement generated');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Resume Improver</h1>
          <p className="muted">Rewrite sections with stronger language — without ever adding facts you don't have.</p>
        </div>
      </div>

      <div className="glass-card form-card fade-up">
        <div className="improver-features">
          {FEATURES.map((f) => (
            <button key={f.key} className={`category-chip ${feature === f.key ? 'active' : ''}`} onClick={() => { setFeature(f.key); setResult(null); }}>
              <f.icon size={14} /> {f.label}
            </button>
          ))}
        </div>

        <div className="form-group">
          <label htmlFor="improveText">Original content</label>
          <textarea
            id="improveText"
            className="input textarea"
            rows={7}
            placeholder={`Paste the ${feature} section of your resume here...`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <button className="btn btn-primary" onClick={handleImprove} disabled={loading}>
          {loading ? <><Loader2 size={16} className="spin" /> Improving...</> : <><Wand2 size={16} /> Improve Section</>}
        </button>

        <p className="muted small pad-top truth-note">
          <ShieldCheck size={13} /> We never invent experience, projects, skills, certifications, or achievements. Quantified results are only kept when your original text includes the numbers.
        </p>
      </div>

      {result && (
        <div className="improve-result fade-up">
          <div className="glass-card">
            <h3 className="subsection-title">Original</h3>
            <pre className="improve-text original">{result.original}</pre>
          </div>
          <div className="glass-card improve-new">
            <h3 className="subsection-title">Improved</h3>
            <pre className="improve-text">{result.improved}</pre>
          </div>
          {result.reason?.length > 0 && (
            <div className="glass-card">
              <h3 className="subsection-title">Why</h3>
              <ul className="parsed-list">{result.reason.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}