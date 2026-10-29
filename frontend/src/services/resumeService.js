import api from './api';

export const uploadResume = (file, onProgress) => {
  const form = new FormData();
  form.append('resume', file);
  return api.post('/resume/upload', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => onProgress?.(Math.round((e.loaded * 100) / e.total)),
  });
};

export const getResume = () => api.get('/resume');
export const deleteResume = () => api.delete('/resume');
export const improveResumeSection = (feature, text) =>
  api.post('/resume/improve', { feature, text });
export const saveJob = (payload) => api.post('/career/jobs', payload);
export const getJob = () => api.get('/career/jobs');
export const deleteJob = () => api.delete('/career/jobs');
export const analyze = () => api.post('/career/analyze');
export const getSkillGap = () => api.get('/career/skill-gap');
export const generateRoadmap = () => api.post('/career/roadmap/generate');
export const getRoadmap = () => api.get('/career/roadmap');
export const updateRoadmapProgress = (phaseIndex, topicIndex, status) =>
  api.put('/career/roadmap/progress', { phaseIndex, topicIndex, status });
export const deleteRoadmap = () => api.delete('/career/roadmap');
export const generateCodingProblems = (topic, difficulty) =>
  api.post('/career/coding/generate', { topic, difficulty });