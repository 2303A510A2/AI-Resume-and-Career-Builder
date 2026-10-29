import api from './api';

export const generateQuestions = (category, count = 6) =>
  api.post('/interview/generate', { category, count });
export const startMock = (category, count = 5) =>
  api.post('/interview/mock/start', { category, count });
export const answerMock = (sessionId, answer) =>
  api.post('/interview/mock/answer', { sessionId, answer });
export const evaluateAnswer = (question, answer, expectedPoints = []) =>
  api.post('/interview/evaluate', { question, answer, expectedPoints });
export const listSessions = () => api.get('/interview');
export const getSession = (id) => api.get(`/interview/${id}`);
export const deleteSession = (id) => api.delete(`/interview/${id}`);