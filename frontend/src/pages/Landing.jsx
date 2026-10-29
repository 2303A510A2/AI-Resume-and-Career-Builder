import { Link } from 'react-router-dom';
import {
  ArrowRight, UploadCloud, Briefcase, Sparkles, Bot, Target, Mic,
  Map, Wand2, Code2, Lock, ShieldCheck, MessagesSquare, BarChart3,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

const FEATURES = [
  { icon: Bot, title: 'AI Career Assistant', desc: 'Ask anything about your career. The AI knows your resume and target job and answers with personalized, retrieved context.' },
  { icon: Target, title: 'Skill Gap Analysis', desc: 'See exactly which required skills you already have and which ones you need for your dream job.' },
  { icon: Mic, title: 'Interview Preparation', desc: 'Generate interview questions from your own resume and practice with a mock interviewer that gives feedback.' },
  { icon: Map, title: 'Personalized Roadmap', desc: 'A step-by-step learning plan built from your current skills and the missing requirements of your target role.' },
  { icon: Wand2, title: 'Resume Improvement', desc: 'Improve summary, skills, projects and bullet points without ever inventing facts about you.' },
  { icon: Code2, title: 'Coding Preparation', desc: 'Relevant DSA problems at the right difficulty, based on the role you are preparing for.' },
];

const STEPS = [
  { icon: UploadCloud, title: 'Upload your resume', desc: 'PDF, DOCX or TXT. We extract your skills, projects, and experience.' },
  { icon: Briefcase, title: 'Add your dream job', desc: 'Paste any job description. We parse its requirements and responsibilities.' },
  { icon: Sparkles, title: 'Get AI guidance', desc: 'A personal RAG knowledge base is built from your documents, powering every answer.' },
];

export default function Landing() {
  const { user } = useAuth();

  return (
    <div className="landing">
      {/* Hero */}
      <section className="hero">
        <div className="hero-glow" aria-hidden="true" />
        <div className="container hero-inner">
          <div className="hero-badge fade-in">
            <Sparkles size={14} /> Powered by AI + RAG
          </div>
          <h1 className="hero-title slide-up">
            Build Your Career <span className="gradient-text">With AI</span>
          </h1>
          <p className="hero-sub slide-up">
            Upload your resume. Add your dream job description.
            Get personalized career guidance powered by AI and RAG.
          </p>
          <div className="hero-actions slide-up">
            {user ? (
              <Link to="/dashboard" className="btn btn-primary btn-lg">
                Open Dashboard <ArrowRight size={18} />
              </Link>
            ) : (
              <>
                <Link to="/signup" className="btn btn-primary btn-lg">
                  Get Started <ArrowRight size={18} />
                </Link>
                <Link to="/login" className="btn btn-outline btn-lg">Login</Link>
              </>
            )}
          </div>
          <div className="hero-stats scale-in">
            <div><strong>1</strong><span>Resume + JD</span></div>
            <div><strong>RAG</strong><span>Personal knowledge base</span></div>
            <div><strong>∞</strong><span>Career questions</span></div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="section container">
        <h2 className="section-title">How It Works</h2>
        <p className="section-sub">Three steps to your personal AI career assistant.</p>
        <div className="steps-grid">
          {STEPS.map((s, i) => (
            <div className="glass-card step-card fade-up" key={s.title} style={{ animationDelay: `${i * 0.1}s` }}>
              <span className="step-num">0{i + 1}</span>
              <s.icon size={28} className="step-icon" />
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="section section-alt container">
        <h2 className="section-title">Everything You Need to Land the Job</h2>
        <p className="section-sub">A real RAG pipeline. Your documents stay private, and answers stay grounded in them.</p>
        <div className="features-grid">
          {FEATURES.map((f, i) => (
            <div className="glass-card feature-card hover-glow fade-up" key={f.title} style={{ animationDelay: `${i * 0.07}s` }}>
              <div className="feature-icon"><f.icon size={22} /></div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Why private */}
      <section className="section container">
        <div className="glass-card privacy-card fade-up">
          <div className="privacy-icon"><Lock size={26} /></div>
          <div>
            <h3>Your career data is private</h3>
            <p>
              Resumes, job descriptions, chats, roadmaps and knowledge base chunks are tied to your
              account. Every retrieval is filtered by your user ID — no one else can ever see your information,
              and admins only see anonymous metadata.
            </p>
          </div>
          <div className="privacy-badges">
            <span className="badge"><ShieldCheck size={13} /> JWT secured</span>
            <span className="badge"><MessagesSquare size={13} /> Owner-only chats</span>
            <span className="badge"><BarChart3 size={13} /> Skill analytics</span>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section container">
        <div className="cta-card scale-in">
          <h2>Ready to build your career with AI?</h2>
          <p>Upload your resume, add your target job, and let your personal AI assistant do the rest.</p>
          {user ? (
            <Link to="/dashboard" className="btn btn-primary btn-lg">Go to Dashboard <ArrowRight size={18} /></Link>
          ) : (
            <Link to="/signup" className="btn btn-primary btn-lg">Get Started Free <ArrowRight size={18} /></Link>
          )}
        </div>
      </section>
    </div>
  );
}