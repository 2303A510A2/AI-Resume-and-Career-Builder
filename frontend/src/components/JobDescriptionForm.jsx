import { useState } from 'react';
import { Briefcase, Building2, FileText, Loader2 } from 'lucide-react';
import { saveJob } from '../services/resumeService';
import { useToast } from '../hooks/useToast';

export default function JobDescriptionForm({ onSaved, existing }) {
  const { showToast } = useToast();
  const [jobTitle, setJobTitle] = useState(existing?.jobTitle || '');
  const [company, setCompany] = useState(existing?.company || '');
  const [description, setDescription] = useState(existing?.description || '');
  const [saving, setSaving] = useState(false);
  const [stage, setStage] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!jobTitle.trim() || !description.trim()) {
      showToast('Job title and description are required.', 'error');
      return;
    }
    setSaving(true);
    try {
      setStage('Saving job description...');
      const { data } = await saveJob({ jobTitle, company, description });
      showToast(data.message || 'Job description saved');
      onSaved?.(data.job, data.analysis);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSaving(false);
      setStage('');
    }
  };

  return (
    <form className="form jd-form" onSubmit={handleSubmit} noValidate>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="jobTitle">
            <Briefcase size={15} /> Job Title
          </label>
          <input
            id="jobTitle"
            className="input"
            placeholder="e.g. Senior Java Developer"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            required
          />
        </div>
        <div className="form-group">
          <label htmlFor="company">
            <Building2 size={15} /> Company <span className="muted small">(optional)</span>
          </label>
          <input
            id="company"
            className="input"
            placeholder="e.g. Acme Corp"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="description">
          <FileText size={15} /> Job Description
        </label>
        <textarea
          id="description"
          className="input textarea"
          rows={9}
          placeholder="Paste the full job description here..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
      </div>

      <button className="btn btn-primary" type="submit" disabled={saving}>
        {saving ? (
          <>
            <Loader2 size={16} className="spin" /> {stage || 'Saving...'}
          </>
        ) : (
          'Save & Analyze Job'
        )}
      </button>
    </form>
  );
}