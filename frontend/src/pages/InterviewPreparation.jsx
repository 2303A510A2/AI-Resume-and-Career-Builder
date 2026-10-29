import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Presentation, Loader2, ListChecks, Trash2, Mic } from 'lucide-react';
import { generateQuestions, listSessions, getSession, deleteSession } from '../services/careerService';
import { useToast } from '../hooks/useToast';

const CATEGORIES = [
  'resume questions', 'project questions', 'technical', 'java', 'python',
  'sql', 'dsa', 'web development', 'hr', 'behavioral', 'system design',
];

const CATEGORY_EMOJI = {
  'resume questions': '📄', 'project questions': '🛠️', technical: '💻',
  java: '☕', python: '🐍', sql: '🗄️', dsa: '🧩', 'web development': '🌐',
  hr: '🤝', behavioral: '💬', 'system design': '🏗️',
};

export default function InterviewPreparation() {
  const { showToast } = useToast();
  const [category, setCategory] = useState('technical');
  const [count, setCount] = useState(6);
  const [generating, setGenerating] = useState(false);
  const [session, setSession] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [viewing, setViewing] = useState(null);

  const loadSessions = async () => {
    try {
      const { data } = await listSessions();
      setSessions(data.sessions || []);
    } catch { /* ignore */ }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setSession(null);
    try {
      const { data } = await generateQuestions(category, count);
      setSession(data.session);
      showToast('Questions generated');
      loadSessions();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const openSession = async (id) => {
    try {
      const { data } = await getSession(id);
      setViewing(data.session);
    } catch { /* ignore */ }
  };

  const handleDeleteSession = async (id) => {
    if (!window.confirm('Delete this interview session?')) return;
    try {
      await deleteSession(id);
      showToast('Session deleted');
      loadSessions();
      if (viewing?._id === id) setViewing(null);
    } catch { /* ignore */ }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Interview Preparation</h1>
          <p className="muted">Questions generated from your resume + target job — not a generic list.</p>
        </div>
        <Link to="/dashboard/mock-interview" className="btn btn-primary">
          <Mic size={16} /> Mock Interview
        </Link>
      </div>

      <div className="glass-card form-card fade-up">
        <h3 className="subsection-title">Generate questions</h3>
        <div className="category-grid">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={`category-chip ${category === c ? 'active' : ''}`}
              onClick={() => setCategory(c)}
            >
              <span>{CATEGORY_EMOJI[c]}</span> {c}
            </button>
          ))}
        </div>
        <div className="form-row align-end">
          <div className="form-group">
            <label htmlFor="count">Number of questions</label>
            <select id="count" className="input" value={count} onChange={(e) => setCount(Number(e.target.value))}>
              {[4, 6, 8, 10].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" onClick={handleGenerate} disabled={generating}>
            {generating ? <><Loader2 size={16} className="spin" /> Generating...</> : <><Presentation size={16} /> Generate Questions</>}
          </button>
        </div>
      </div>

      {session && (
        <div className="glass-card fade-up qa-card">
          <div className="qa-head">
            <h3>{CATEGORY_EMOJI[session.category]} {session.title}</h3>
            <span className="badge">{session.questions.length} questions</span>
          </div>
          <ol className="qa-list">
            {session.questions.map((q, i) => (
              <li key={i} className="qa-item">
                <div className="qa-question"><span className="qa-num">{i + 1}</span> {q.question}</div>
                {q.expectedPoints?.length > 0 && (
                  <div className="qa-points">
                    <ListChecks size={13} /> Cover: {q.expectedPoints.join(' · ')}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}

      {sessions.length > 0 && (
        <div className="glass-card fade-up">
          <h3 className="subsection-title">Past sessions</h3>
          <div className="session-list">
            {sessions.map((s) => (
              <div key={s._id} className="session-row">
                <div onClick={() => openSession(s._id)} className="session-row-main">
                  <strong>{s.title}</strong>
                  <span className="muted small">{s.type} · {s.status} · {new Date(s.createdAt).toLocaleDateString()} {s.averageScore ? `· avg ${s.averageScore}` : ''}</span>
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => handleDeleteSession(s._id)}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewing && viewing._id !== session?._id && (
        <div className="glass-card fade-up qa-card">
          <div className="qa-head">
            <h3>{viewing.title}</h3>
            <button className="btn btn-outline btn-sm" onClick={() => setViewing(null)}>Close</button>
          </div>
          <ol className="qa-list">
            {viewing.questions?.map((q, i) => (
              <li key={i} className="qa-item">
                <div className="qa-question"><span className="qa-num">{i + 1}</span> {q.question}</div>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}