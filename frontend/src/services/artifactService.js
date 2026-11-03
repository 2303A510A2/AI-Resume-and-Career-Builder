import api from './api';

export async function downloadArtifact(artifact) {
  const id = artifact?.artifactId || artifact?._id;
  if (!id) throw new Error('Artifact identifier is missing.');
  const response = await api.get(`/artifacts/${id}/download`, { responseType: 'blob' });
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${String(artifact.title || 'artifact').replace(/[^\w.-]+/g, '_')}.${artifact.extension || 'bin'}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
