// Derive from the full list, never the filtered/sorted table or old queue results.
export function getQueueProgress(packages, queueIds) {
  const byId = new Map(packages.map((item) => [item.id, item]));
  const queue = queueIds.map((id) => byId.get(id)).filter(Boolean);
  const current = queue.find((item) => item.status === 'running') ?? null;
  const completed = queue.filter((item) => ['success', 'failed'].includes(item.status)).length;
  const total = queueIds.length;
  return {
    current,
    position: current ? queueIds.indexOf(current.id) + 1 : 0,
    completed,
    total,
    percent: total ? Math.round(completed / total * 100) : null
  };
}
