import { useRef, useState } from 'react';
import { UploadCloud, FileText, CheckCircle2, Loader2 } from 'lucide-react';
import { uploadResume } from '../services/resumeService';
import { useToast } from '../hooks/useToast';

const ACCEPT = '.pdf,.doc,.docx,.txt';

const LOADING_STEPS = [
  'Analyzing your resume...',
  'Extracting skills...',
  'Understanding your projects...',
  'Building your knowledge base...',
];

export default function ResumeUploader({ onUploaded }) {
  const inputRef = useRef(null);
  const { showToast } = useToast();
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [progress, setProgress] = useState(0);

  const handleFile = (file) => {
    if (!file) return;
    const okExt = /\.(pdf|docx?|txt)$/i.test(file.name);
    const okType = ['application/pdf', 'text/plain', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(file.type);
    if (!okExt && !okType) {
      showToast('Unsupported file type. Use PDF, DOCX, or TXT.', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast('File is too large. Maximum size is 5 MB.', 'error');
      return;
    }
    setFileName(file.name);
    setUploading(true);
    setStepIndex(0);

    const stepTimer = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, LOADING_STEPS.length - 1));
    }, 900);

    uploadResume(file, setProgress)
      .then((res) => {
        clearInterval(stepTimer);
        showToast(res.data.message || 'Resume uploaded successfully');
        onUploaded?.(res.data.resume, res.data.rag);
      })
      .catch((err) => {
        clearInterval(stepTimer);
        showToast(err.message, 'error');
      })
      .finally(() => {
        setTimeout(() => {
          setUploading(false);
          setFileName('');
        }, 400);
      });
  };

  return (
    <div
      className={`uploader ${dragOver ? 'dragover' : ''} ${uploading ? 'uploading' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]); }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => handleFile(e.target.files?.[0])}
        aria-label="Choose resume file"
      />

      {!uploading && (
        <button type="button" className="uploader-body" onClick={() => inputRef.current?.click()} aria-label="Upload resume">
          <span className="uploader-icon"><UploadCloud size={34} /></span>
          <h3>{fileName || 'Click to upload or drag & drop your resume'}</h3>
          <p className="muted">PDF, DOCX, or TXT · up to 5 MB</p>
        </button>
      )}

      {uploading && (
        <div className="uploader-progress">
          <div className="uploader-progress-row">
            <FileText size={18} />
            <span className="file-name">{fileName}</span>
            <Loader2 size={16} className="spin" />
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="step-list">
            {LOADING_STEPS.map((s, i) => (
              <div key={s} className={`step ${i < stepIndex ? 'done' : i === stepIndex ? 'active' : ''}`}>
                {i < stepIndex ? <CheckCircle2 size={14} /> : <span className="step-dot" />}
                {s}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}