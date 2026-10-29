import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Target, ArrowRight, UploadCloud, Briefcase, CheckCircle2, AlertTriangle, PlusCircle, Star } from 'lucide-react';
import { getSkillGap, getResume, getJob } from '../services/resumeService';
import EmptyState from '../components/EmptyState.jsx';

const skillLevel = (index, priorityIdx) => {
  // descriptive bar: matched skills are strong, missing prioritized at the top
  const base = priorityIdx !== undefined ? Math.max(10, 92 - priorityIdx * 22) : 0;
  return base;
};

export default function SkillGap() {
  const [gap, setGap] = useState(null);
  const [resume, setResume] = useState(null);
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [gapRes, resumeRes, jobRes] = await Promise.allSettled([getSkillGap(), getResume(), getJob()]);
      if (gapRes.status === 'fulfilled') setGap(gapRes.value.data.gap);
      if (resumeRes.status === 'fulfilled') setResume(resumeRes.value.data.resume);
      if (jobRes.status === 'fulfilled') setJob(jobRes.value.data.job);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="page"><div className="page-head"><h1>Skill Gap</h1></div><div className="skeleton skeleton-lg" /></div>;

  if (gap === null) {
    const needsResume = !resume;
    return (
      <div className="page">
        <div className="page-head"><div><h1>Skill Gap</h1><p className="muted">Compare your skills with the job's requirements.</p></div></div>
        <EmptyState
          icon={needsResume ? <UploadCloud size={34} /> : <Briefcase size={34} />}
          title={needsResume ? 'No resume uploaded yet' : 'No job description added yet'}
          description={needsResume
            ? 'Upload your resume to unlock your personalized AI career assistant.'
            : 'Add a job description to compare your skills with its requirements.'}
          action={
            <Link to={needsResume ? '/dashboard/resume' : '/dashboard/job-description'} className="btn btn-primary">
              {needsResume ? 'Upload Resume' : 'Add Job Description'}
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Skill Gap</h1>
          <p className="muted">
            Your skills vs <strong>{job?.jobTitle}</strong> — a descriptive comparison, not a scientific score.
          </p>
        </div>
        <div className="match-badge">
          <span className="match-ring" style={{ '--pct': `${gap.matchPercent * 3.6}deg` }}>
            <strong>{gap.matchPercent}%</strong>
          </span>
          <span>Match</span>
        </div>
      </div>

      <div className="gap-grid">
        {gap.matched?.length > 0 && (
          <div className="glass-card gap-card fade-up">
            <h3 className="gap-title success"><CheckCircle2 size={17} /> Matching Skills</h3>
            <ul className="gap-list">
              {gap.matched.map((s) => (
                <li key={s}>
                  <span className="skill-name">{s}</span>
                  <span className="skill-bar"><span className="bar bar-match" style={{ width: '95%' }} /></span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {gap.missing?.length > 0 ? (
          <div className="glass-card gap-card fade-up">
            <h3 className="gap-title warn"><AlertTriangle size={17} /> Missing Skills</h3>
            <ul className="gap-list">
              {gap.missing.map((s, i) => (
                <li key={s}>
                  <span className="skill-name">{s}</span>
                  <span className="skill-bar">
                    <span className="bar bar-missing" style={{ width: `${skillLevel(i, i)}%` }} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="glass-card gap-card fade-up">
            <h3 className="gap-title success"><CheckCircle2 size={17} /> Missing Skills</h3>
            <p className="muted">You cover every required skill. Focus on interview preparation!</p>
          </div>
        )}

        {gap.additional?.length > 0 && (
          <div className="glass-card gap-card fade-up">
            <h3 className="gap-title"><PlusCircle size={17} /> Additional Skills</h3>
            <div className="chip-list">
              {gap.additional.slice(0, 24).map((s) => <span className="chip" key={s}>{s}</span>)}
              {gap.additional.length > 24 && <span className="chip">+{gap.additional.length - 24}</span>}
            </div>
          </div>
        )}

        {gap.priority?.length > 0 && (
          <div className="glass-card gap-card gap-card-wide fade-up">
            <h3 className="gap-title"><Star size={17} /> Priority Skills to Learn</h3>
            <div className="priority-list">
              {gap.priority.map((s, i) => (
                <div key={s} className="priority-item">
                  <span className="priority-num">{i + 1}</span>
                  <span>{s}</span>
                </div>
              ))}
            </div>
            <Link to="/dashboard/roadmap" className="btn btn-primary btn-sm">
              Build my roadmap <ArrowRight size={15} />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}