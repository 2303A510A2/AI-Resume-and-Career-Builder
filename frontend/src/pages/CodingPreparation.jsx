import { useState } from 'react';
import { Code2, Loader2, ListChecks } from 'lucide-react';
import { generateCodingProblems } from '../services/resumeService';
import { useToast } from '../hooks/useToast';

const TOPICS = [
  'Arrays', 'Strings', 'HashMap', 'Linked List', 'Stack', 'Queue', 'Trees',
  'Graphs', 'Recursion', 'Sorting', 'Searching', 'Dynamic Programming',
];

const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

export default function CodingPreparation() {
  const { showToast } = useToast();
  const [topic, setTopic] = useState('Arrays');
  const [difficulty, setDifficulty] = useState('Medium');
  const [loading, setLoading] = useState(false);
  const [problems, setProblems] = useState([]);

  const handleGenerate = async () => {
    setLoading(true);
    setProblems([]);
    try {
      const { data } = await generateCodingProblems(topic, difficulty);
      setProblems(data.problems || []);
      showToast(`${difficulty} ${topic} problems generated`);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const diffClass = (d) => (d === 'Easy' ? 'diff-easy' : d === 'Medium' ? 'diff-medium' : 'diff-hard');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Coding Preparation</h1>
          <p className="muted">Relevant DSA problems for your target role, at the difficulty you choose.</p>
        </div>
      </div>

      <div className="glass-card form-card fade-up">
        <h3 className="subsection-title">Pick a topic</h3>
        <div className="category-grid">
          {TOPICS.map((t) => (
            <button key={t} className={`category-chip ${topic === t ? 'active' : ''}`} onClick={() => setTopic(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="form-row align-end">
          <div className="form-group">
            <label htmlFor="difficulty">Difficulty</label>
            <div className="difficulty-row">
              {DIFFICULTIES.map((d) => (
                <button key={d} className={`category-chip ${difficulty === d ? `active ${diffClass(d)}` : ''}`} onClick={() => setDifficulty(d)}>
                  {d}
                </button>
              ))}
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleGenerate} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Generating...</> : <><Code2 size={16} /> Generate Problems</>}
          </button>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="problem-list">
          {problems.map((p, i) => (
            <div key={i} className="glass-card problem-card fade-up">
              <div className="problem-head">
                <span className={`difficulty-badge ${diffClass(p.difficulty)}`}>{p.difficulty}</span>
                <h3>{i + 1}. {p.title}</h3>
              </div>
              <p className="problem-desc">{p.description}</p>
              {p.example && <pre className="problem-example">{p.example}</pre>}
              {p.techniques?.length > 0 && (
                <div className="chip-list small">
                  <ListChecks size={14} /> {p.techniques.map((t) => <span key={t} className="chip">{t}</span>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}