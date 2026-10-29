import { useEffect, useState, useCallback } from 'react';
import { Briefcase, Trash2, Target, ListChecks, GraduationCap, Wrench } from 'lucide-react';
import JobDescriptionForm from '../components/JobDescriptionForm.jsx';
import { getJob, deleteJob } from '../services/resumeService';
import { useToast } from '../hooks/useToast';

export default function JobDescription() {
  const { showToast } = useToast();
  const [job, setJob] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getJob();
      setJob(data.job);
      setAnalysis(data.job?.analysis || null);
    } catch {
      setJob(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSaved = (savedJob, savedAnalysis) => {
    setJob(savedJob);
    setAnalysis(savedAnalysis);
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this job description? Your analysis will be cleared.')) return;
    setDeleting(true);
    try {
      await deleteJob();
      showToast('Job description deleted');
      setJob(null);
      setAnalysis(null);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <div className="page"><div className="page-head"><h1>Job Description</h1></div><div className="skeleton skeleton-lg" /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Job Description</h1>
          <p className="muted">What job are you preparing for? Paste the full description — we analyze it against your resume.</p>
        </div>
        {job && (
          <button className="btn btn-danger btn-sm" onClick={handleDelete} disabled={deleting}>
            <Trash2 size={15} /> {deleting ? 'Deleting...' : 'Delete Job'}
          </button>
        )}
      </div>

      {job && (
        <div className="glass-card jd-summary fade-up">
          <h3>
            <Briefcase size={17} /> {job.jobTitle} {job.company && <span className="muted">· {job.company}</span>}
          </h3>
          <div className="chip-list">
            <span className="chip"><Target size={13} /> Required: {job.parsed?.requiredSkills?.join(', ') || '—'}</span>
          </div>
          {job.parsed?.preferredSkills?.length > 0 && (
            <div className="chip-list">
              <span className="chip chip-alt"><Wrench size={13} /> Preferred: {job.parsed.preferredSkills.join(', ')}</span>
            </div>
          )}
          <div className="parsed-grid">
            {job.parsed?.responsibilities?.length > 0 && (
              <div className="parsed-block">
                <h4><ListChecks size={14} /> Responsibilities</h4>
                <ul className="parsed-list">{job.parsed.responsibilities.slice(0, 8).map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}
            {job.parsed?.qualifications?.length > 0 && (
              <div className="parsed-block">
                <h4><GraduationCap size={14} /> Qualifications</h4>
                <ul className="parsed-list">{job.parsed.qualifications.slice(0, 8).map((q, i) => <li key={i}>{q}</li>)}</ul>
              </div>
            )}
          </div>
          {job.parsed?.experienceLevel && <p className="muted small">Experience level: <strong>{job.parsed.experienceLevel}</strong></p>}
          {analysis && (
            <div className="analysis-note">
              <Target size={14} /> Match: <strong>{analysis.matchPercent}%</strong> — {analysis.summary}
            </div>
          )}
        </div>
      )}

      <h2 className="subsection-title">{job ? 'Update job description' : 'Add your target job'}</h2>
      <div className="glass-card form-card">
        <JobDescriptionForm onSaved={handleSaved} existing={job} />
      </div>
    </div>
  );
}