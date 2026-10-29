import { useEffect, useState, useCallback } from 'react';
import { FileText, Trash2, CheckCircle2, User, Mail, Phone } from 'lucide-react';
import ResumeUploader from '../components/ResumeUploader.jsx';
import { getResume, deleteResume } from '../services/resumeService';
import { useToast } from '../hooks/useToast';

export default function Resume() {
  const { showToast } = useToast();
  const [resume, setResume] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getResume();
      setResume(data.resume);
    } catch {
      setResume(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleUploaded = (updated) => {
    setResume(updated);
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete your resume? This removes it and its knowledge base chunks.')) return;
    setDeleting(true);
    try {
      await deleteResume();
      showToast('Resume deleted');
      setResume(null);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <div className="page"><div className="page-head"><h1>My Resume</h1></div><div className="skeleton skeleton-lg" /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>My Resume</h1>
          <p className="muted">Upload a PDF, DOCX, or TXT resume. We parse it and build your personal knowledge base.</p>
        </div>
      </div>

      {!resume ? (
        <ResumeUploader onUploaded={handleUploaded} />
      ) : (
        <>
          <div className="glass-card resume-summary fade-up">
            <div className="resume-summary-head">
              <div className="resume-file-icon"><FileText size={24} /></div>
              <div>
                <h3>{resume.fileName}</h3>
                <p className="muted small">
                  {resume.fileType?.toUpperCase()} · {(resume.fileSize / 1024).toFixed(0)} KB · parsed {new Date(resume.updatedAt).toLocaleDateString()}
                </p>
              </div>
              <button className="btn btn-danger btn-sm" onClick={handleDelete} disabled={deleting}>
                <Trash2 size={15} /> {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>

            <div className="resume-parsed">
              <div className="parsed-block">
                <h4><User size={15} /> {resume.parsed?.name || 'Name not detected'}</h4>
                <div className="parsed-contact">
                  {resume.parsed?.contact?.email && <span><Mail size={13} /> {resume.parsed.contact.email}</span>}
                  {resume.parsed?.contact?.phone && <span><Phone size={13} /> {resume.parsed.contact.phone}</span>}
                  {resume.parsed?.contact?.linkedin && <span>{resume.parsed.contact.linkedin}</span>}
                  {resume.parsed?.contact?.github && <span>{resume.parsed.contact.github}</span>}
                </div>
              </div>

              {resume.parsed?.summary && (
                <div className="parsed-block">
                  <h4>Summary</h4><p>{resume.parsed.summary}</p>
                </div>
              )}

              <div className="parsed-grid">
                {resume.parsed?.skills?.length > 0 && (
                  <div className="parsed-block">
                    <h4>Skills ({resume.parsed.skills.length})</h4>
                    <div className="chip-list">
                      {resume.parsed.skills.slice(0, 30).map((s) => <span className="chip" key={s}>{s}</span>)}
                      {resume.parsed.skills.length > 30 && <span className="chip">+{resume.parsed.skills.length - 30} more</span>}
                    </div>
                  </div>
                )}
                {resume.parsed?.programmingLanguages?.length > 0 && (
                  <div className="parsed-block">
                    <h4>Programming Languages</h4>
                    <div className="chip-list">{resume.parsed.programmingLanguages.map((s) => <span className="chip" key={s}>{s}</span>)}</div>
                  </div>
                )}
                {resume.parsed?.frameworks?.length > 0 && (
                  <div className="parsed-block">
                    <h4>Frameworks &amp; Tools</h4>
                    <div className="chip-list">{resume.parsed.frameworks.map((s) => <span className="chip" key={s}>{s}</span>)}</div>
                  </div>
                )}
              </div>

              {resume.parsed?.projects?.length > 0 && (
                <div className="parsed-block">
                  <h4>Projects ({resume.parsed.projects.length})</h4>
                  <ul className="parsed-list">
                    {resume.parsed.projects.slice(0, 6).map((p, i) => (
                      <li key={i}><strong>{p.name}</strong>{p.description ? <span> — {p.description.slice(0, 140)}</span> : null}</li>
                    ))}
                  </ul>
                </div>
              )}

              {resume.parsed?.experience?.length > 0 && (
                <div className="parsed-block">
                  <h4>Experience ({resume.parsed.experience.length})</h4>
                  <ul className="parsed-list">
                    {resume.parsed.experience.slice(0, 5).map((e, i) => (
                      <li key={i}><strong>{e.role}</strong>{e.company ? ` — ${e.company}` : ''}{e.duration ? ` (${e.duration})` : ''}</li>
                    ))}
                  </ul>
                </div>
              )}

              {resume.parsed?.certifications?.length > 0 && (
                <div className="parsed-block">
                  <h4>Certifications</h4>
                  <ul className="parsed-list">{resume.parsed.certifications.slice(0, 8).map((c, i) => <li key={i}>{c}</li>)}</ul>
                </div>
              )}

              <div className="parsed-note">
                <CheckCircle2 size={14} /> Extracted automatically — only information found in your resume. Text sections feed your RAG knowledge base.
              </div>
            </div>
          </div>

          <div className="page-row">
            <ResumeUploader onUploaded={handleUploaded} />
          </div>
        </>
      )}
    </div>
  );
}