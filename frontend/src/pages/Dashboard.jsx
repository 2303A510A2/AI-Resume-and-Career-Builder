import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText, Briefcase, Target, Bot, Map, Sparkles, ArrowRight,
  CheckCircle2, XCircle, UploadCloud, Loader2,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { getResume, getJob, getSkillGap, analyze } from '../services/resumeService';
import { useToast } from '../hooks/useToast';

const QUICK_LINKS = [
  { to: '/dashboard/career-assistant', label: 'AI Career Assistant', icon: Bot },
  { to: '/dashboard/skill-gap', label: 'Skill Gap', icon: Target },
  { to: '/dashboard/roadmap', label: 'Learning Roadmap', icon: Map },
  { to: '/dashboard/interview', label: 'Interview Prep', icon: Sparkles },
];

export default function Dashboard() {
  const { user } = useAuth();
  const { showToast } = useToast();
  const [resume, setResume] = useState(null);
  const [job, setJob] = useState(null);
  const [gap, setGap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [res, jd, sg] = await Promise.allSettled([getResume(), getJob(), getSkillGap()]);
      if (res.status === 'fulfilled') setResume(res.value.data.resume);
      if (jd.status === 'fulfilled') setJob(jd.value.data.job);
      if (sg.status === 'fulfilled') setGap(sg.value.data.gap);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAnalyze = async () => {
    setAnalyzing(true);
    try {
      const { data } = await analyze();
      showToast('Analysis complete');
      await load();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading) {
    return <div className="page"><div className="page-head"><h1>Dashboard</h1></div><div className="skeleton-cards"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div></div>;
  }

  const analysis = resume?.analysis;
  const matchPercent = gap?.matchPercent ?? analysis?.matchPercent ?? 0;
  const needsResume = !resume;
  const needsJob = resume && !job;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Welcome, {user?.name?.split(' ')[0] || 'there'} 👋</h1>
          <p className="muted">Here's where your career journey stands.</p>
        </div>
        {(needsResume || needsJob) && (
          <Link to={needsResume ? '/dashboard/resume' : '/dashboard/job-description'} className="btn btn-primary">
            <UploadCloud size={16} /> {needsResume ? 'Upload Resume' : 'Add Job'}
          </Link>
        )}
      </div>

      {/* Onboarding banner */}
      {analysis && (
        <div className="glass-card analysis-banner fade-up">
          <div className="analysis-match">
            <div className="ring" style={{ '--pct': `${matchPercent * 3.6}deg` }}>
              <span>{matchPercent}%</span>
            </div>
            <div>
              <h3>Skill Match — {job?.jobTitle || analysis?.jobTitle}</h3>
              <p className="muted small">{analysis?.summary || 'Your analysis summary will appear here.'}</p>
            </div>
          </div>
          <div className="analysis-chips">
            {gap?.missing?.length > 0 && (
              <span className="badge badge-warn"><XCircle size={13} /> {gap.missing.length} missing skills</span>
            )}
            {gap?.matched?.length > 0 && (
              <span className="badge badge-success"><CheckCircle2 size={13} /> {gap.matched.length} matched</span>
            )}
          </div>
        </div>
      )}

      {needsResume && (
        <div className="glass-card empty-inline fade-up">
          <p><UploadCloud size={20} /> No resume uploaded yet. Upload your resume to unlock your personalized AI career assistant.</p>
          <Link to="/dashboard/resume" className="btn btn-primary">Upload Resume</Link>
        </div>
      )}
      {needsJob && (
        <div className="glass-card empty-inline fade-up">
          <p><Briefcase size={20} /> Add your target job description to start the skill-gap analysis.</p>
          <Link to="/dashboard/job-description" className="btn btn-primary">Add Job Description</Link>
        </div>
      )}

      {/* Status grid */}
      <div className="stat-grid">
        <div className="glass-card stat-card fade-up">
          <div className="stat-icon"><FileText size={20} /></div>
          <div>
            <h3>{resume ? 'Resume' : 'Resume'}</h3>
            <p className={resume ? 'ok' : 'not-ok'}>{resume ? `Uploaded · ${resume.fileName}` : 'Not uploaded'}</p>
          </div>
          {resume && <CheckCircle2 size={18} className="stat-check" />}
        </div>
        <div className="glass-card stat-card fade-up">
          <div className="stat-icon"><Briefcase size={20} /></div>
          <div>
            <h3>Target Job</h3>
            <p className={job ? 'ok' : 'not-ok'}>{job ? `${job.jobTitle}${job.company ? ' · ' + job.company : ''}` : 'Not added'}</p>
          </div>
          {job && <CheckCircle2 size={18} className="stat-check" />}
        </div>
        <div className="glass-card stat-card fade-up">
          <div className="stat-icon"><Target size={20} /></div>
          <div>
            <h3>Skill Match</h3>
            <p>{gap ? `${matchPercent}% match` : analysis ? `${matchPercent}% match` : '—'}</p>
          </div>
          {gap && <span className="stat-pct">{matchPercent}%</span>}
        </div>
        <div className="glass-card stat-card fade-up">
          <div className="stat-icon"><Target size={20} /></div>
          <div>
            <h3>Missing Skills</h3>
            <p>{gap ? `${gap.missing.length} to learn` : analysis ? `${analysis.missingSkills?.length || 0} to learn` : '—'}</p>
          </div>
          {gap?.missing?.length > 0 && <span className="stat-count">{gap.missing.length}</span>}
        </div>
      </div>

      {!needsResume && !needsJob && (
        <div className="page-row">
          <button className="btn btn-outline" onClick={handleAnalyze} disabled={analyzing}>
            {analyzing ? <><Loader2 size={16} className="spin" /> Analyzing...</> : 'Re-run full analysis'}
          </button>
        </div>
      )}

      {/* Quick links */}
      <h2 className="subsection-title">Jump back in</h2>
      <div className="quick-grid">
        {QUICK_LINKS.map((q) => (
          <Link key={q.to} to={q.to} className="glass-card quick-card hover-glow fade-up">
            <q.icon size={20} />
            <span>{q.label}</span>
            <ArrowRight size={16} className="quick-arrow" />
          </Link>
        ))}
      </div>
    </div>
  );
}