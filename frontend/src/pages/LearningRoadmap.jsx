import { useEffect, useState, useCallback } from 'react';
import { Map, Loader2, RefreshCw, CheckCircle2, Circle, Clock, BookOpen } from 'lucide-react';
import { generateRoadmap, getRoadmap, updateRoadmapProgress } from '../services/resumeService';
import { useToast } from '../hooks/useToast';
import EmptyState from '../components/EmptyState.jsx';

const STATUS_META = {
  'not-started': { icon: Circle, label: 'Not started', cls: '' },
  'in-progress': { icon: Clock, label: 'In progress', cls: 'warn' },
  completed: { icon: CheckCircle2, label: 'Completed', cls: 'success' },
};

export default function LearningRoadmap() {
  const { showToast } = useToast();
  const [roadmap, setRoadmap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getRoadmap();
      setRoadmap(data.roadmap);
    } catch {
      setRoadmap(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const { data } = await generateRoadmap();
      setRoadmap(data.roadmap);
      showToast('Roadmap generated');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setGenerating(false);
    }
  };

  const cycleStatus = async (phaseIndex, topicIndex, current) => {
    const next = current === 'not-started' ? 'in-progress' : current === 'in-progress' ? 'completed' : 'not-started';
    const updated = { ...roadmap };
    updated.phases[phaseIndex].topics[topicIndex].status = next;
    setRoadmap(updated);
    showToast(`Marked "${updated.phases[phaseIndex].topics[topicIndex].title}" as ${next.replace('-', ' ')}`);
    try {
      const { data } = await updateRoadmapProgress(phaseIndex, topicIndex, next);
      setRoadmap(data.roadmap);
    } catch (err) {
      showToast(err.message, 'error');
      load();
    }
  };

  if (loading) return <div className="page"><div className="page-head"><h1>Learning Roadmap</h1></div><div className="skeleton skeleton-lg" /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Learning Roadmap</h1>
          <p className="muted">A personalized plan to close your skill gap for {roadmap?.targetRole || 'your target role'}.</p>
        </div>
        <button className="btn btn-outline" onClick={handleGenerate} disabled={generating}>
          {generating ? <><Loader2 size={16} className="spin" /> Building...</> : <><RefreshCw size={16} /> Regenerate</>}
        </button>
      </div>

      {!roadmap ? (
        <EmptyState
          icon={<Map size={34} />}
          title="No roadmap yet"
          description="Generate a personalized learning roadmap based on your resume and target job."
          action={<button className="btn btn-primary" onClick={handleGenerate} disabled={generating}>
            {generating ? <><Loader2 size={16} className="spin" /> Building your roadmap...</> : 'Generate Roadmap'}
          </button>}
        />
      ) : (
        <div className="roadmap">
          <div className="roadmap-progress glass-card fade-up">
            <BookOpen size={18} />
            <div className="progress-track wide">
              <div className="progress-fill" style={{ width: `${roadmap.progressPercent}%` }} />
            </div>
            <strong>{roadmap.progressPercent}% complete</strong>
          </div>

          {roadmap.phases.map((phase, pi) => (
            <div key={pi} className={`roadmap-phase phase-${pi + 1} glass-card fade-up`}>
              <div className="phase-marker">{pi + 1}</div>
              <div className="phase-body">
                <h3>{phase.title}</h3>
                {phase.description && <p className="muted small">{phase.description}</p>}
                <div className="topic-list">
                  {phase.topics.map((topic, ti) => {
                    const meta = STATUS_META[topic.status] || STATUS_META['not-started'];
                    const Icon = meta.icon;
                    return (
                      <div key={ti} className="topic-row">
                        <button
                          className={`topic-status ${meta.cls}`}
                          onClick={() => cycleStatus(pi, ti, topic.status)}
                          aria-label={`${topic.title} is ${meta.label}. Click to change.`}
                          title={`Status: ${meta.label} (click to change)`}
                        >
                          <Icon size={17} />
                          <span className="topic-status-label">{meta.label}</span>
                        </button>
                        <div className="topic-info">
                          <strong>{topic.title}</strong>
                          {topic.description && <p className="muted small">{topic.description}</p>}
                          {topic.resources?.length > 0 && (
                            <div className="chip-list small">
                              {topic.resources.map((r, i) => r && <span className="chip chip-alt" key={i}>{r}</span>)}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}