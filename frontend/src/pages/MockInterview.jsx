import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mic, Loader2, Send, RotateCcw, Award, CheckCircle2, AlertTriangle } from 'lucide-react';
import { startMock, answerMock } from '../services/careerService';
import { useToast } from '../hooks/useToast';

const CATEGORIES = ['technical', 'java', 'python', 'sql', 'dsa', 'web development', 'hr', 'behavioral'];

export default function MockInterview() {
  const { showToast } = useToast();
  const [stage, setStage] = useState('setup'); // setup | live | done
  const [category, setCategory] = useState('technical');
  const [session, setSession] = useState(null);
  const [question, setQuestion] = useState(null);
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const [evaluations, setEvaluations] = useState([]);
  const [summary, setSummary] = useState(null);

  const handleStart = async () => {
    setSending(true);
    try {
      const { data } = await startMock(category, 5);
      setSession(data.session);
      setQuestion(data.question);
      setStage('live');
      showToast('Mock interview started');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSending(false);
    }
  };

  const handleAnswer = async () => {
    if (!answer.trim()) return showToast('Please write an answer first.', 'error');
    setSending(true);
    try {
      const { data } = await answerMock(session._id, answer);
      setEvaluations((prev) => [...prev, data.feedback]);
      setAnswer('');
      if (data.finished) {
        setSummary({ average: data.session.averageScore, session: data.session });
        setStage('done');
        showToast('Mock interview completed');
      } else {
        setQuestion(data.question);
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSending(false);
    }
  };

  const reset = () => {
    setStage('setup');
    setSession(null);
    setQuestion(null);
    setEvaluations([]);
    setSummary(null);
    setAnswer('');
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Mock Interview</h1>
          <p className="muted">Practise with an AI interviewer that asks questions from your own resume and target job, then evaluates each answer.</p>
        </div>
      </div>

      {stage === 'setup' && (
        <div className="glass-card form-card fade-up">
          <h3 className="subsection-title">Choose an interview type</h3>
          <div className="category-grid">
            {CATEGORIES.map((c) => (
              <button key={c} className={`category-chip ${category === c ? 'active' : ''}`} onClick={() => setCategory(c)}>
                {c}
              </button>
            ))}
          </div>
          <button className="btn btn-primary" onClick={handleStart} disabled={sending}>
            {sending ? <><Loader2 size={16} className="spin" /> Starting...</> : <><Mic size={16} /> Start Mock Interview</>}
          </button>
          <p className="muted small pad-top">
            You'll get 5 questions one at a time. Each answer is evaluated on relevance, technical coverage, clarity, and structure.
          </p>
        </div>
      )}

      {stage === 'live' && question && (
        <div className="mock-live">
          <div className="glass-card mock-question fade-up">
            <div className="mock-progress">
              <span className="badge">Question {session.currentIndex + 1} of {session.questions.length}</span>
            </div>
            <h3 className="mock-question-text">{question.question}</h3>
            {question.expectedPoints?.length > 0 && (
              <p className="muted small">Good answers touch on: {question.expectedPoints.join(' · ')}</p>
            )}
          </div>

          <div className="glass-card fade-up">
            <label className="label" htmlFor="mockAnswer">Your answer</label>
            <textarea
              id="mockAnswer"
              className="input textarea"
              rows={6}
              placeholder="Type your answer here..."
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              disabled={sending}
            />
            <div className="page-row end">
              <button className="btn btn-primary" onClick={handleAnswer} disabled={sending || !answer.trim()}>
                {sending ? <><Loader2 size={16} className="spin" /> Evaluating...</> : <><Send size={16} /> Submit Answer</>}
              </button>
            </div>
          </div>

          {evaluations.length > 0 && (
            <div className="glass-card fade-up">
              <h3 className="subsection-title">Recent feedback</h3>
              {evaluations.slice(-1).map((e, i) => (
                <div key={i} className="eval-block">
                  <div className="score-row">
                    {[
                      ['Relevance', e.scores.relevance],
                      ['Technical', e.scores.technicalCoverage],
                      ['Clarity', e.scores.clarity],
                      ['Structure', e.scores.structure],
                    ].map(([label, val]) => (
                      <div key={label} className="score-pill">
                        <span>{label}</span>
                        <strong>{val}</strong>
                      </div>
                    ))}
                  </div>
                  <p className="eval-feedback">{e.feedback}</p>
                  {e.missingPoints?.length > 0 && (
                    <p className="muted small warn-text"><AlertTriangle size={13} /> Missing: {e.missingPoints.join(' · ')}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {stage === 'done' && summary && (
        <div className="glass-card center-text fade-up mock-done">
          <span className="auth-icon success"><Award size={28} /></span>
          <h2>Mock interview complete!</h2>
          <p className="muted">Your average score across {summary.session.answers.length} answers:</p>
          <div className="big-score glow-text">{summary.average}<span>/100</span></div>
          <div className="score-row wrap">
            {summary.session.answers.map((a, i) => (
              <div key={i} className="score-pill">
                <span>Q{i + 1}</span>
                <strong>{Math.round((a.scores.relevance + a.scores.technicalCoverage + a.scores.clarity + a.scores.structure) / 4)}</strong>
              </div>
            ))}
          </div>
          <div className="page-row center">
            <button className="btn btn-primary" onClick={reset}><RotateCcw size={16} /> New Interview</button>
            <Link to="/dashboard/career-assistant" className="btn btn-outline">Ask the Assistant</Link>
          </div>
          <p className="muted small pad-top"><CheckCircle2 size={13} /> Feedback is per-answer; review each evaluation in the session tab of Interview Preparation.</p>
        </div>
      )}
    </div>
  );
}