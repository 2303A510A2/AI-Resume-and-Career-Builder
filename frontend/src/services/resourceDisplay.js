// Prevent a structured resource list from being rendered twice.

const isProblemResource = (resource) =>
  resource && (resource.type === 'leetcode' || resource.type === 'problem');

export function visibleResources(resources, answer) {
  const text = String(answer || '').toLowerCase();
  return (Array.isArray(resources) ? resources : []).filter((resource) => {
    if (!isProblemResource(resource)) return true;
    const title = String(resource.title || '').trim().toLowerCase();
    return !title || !text.includes(title);
  });
}
