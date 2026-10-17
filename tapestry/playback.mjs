// A reversible presentation clock. It never changes the log or the layout.
export function progressAt(time, start, end) {
  return end > start ? Math.max(0, Math.min(1, (time - start) / (end - start))) : 1;
}

// Translate a wall-clock position to the sewing clock. A merged tool action
// occupies its start position; the full range includes its completion time.
export function sewingAt(actions, fraction, until) {
  if (!actions.length) return until;
  const first = actions[0].t;
  const last = Math.max(...actions.map((action) => action.t1));
  if (fraction >= 1) return until;
  if (fraction <= 0) return Math.min(0, actions[0].birth - 0.01);
  const time = first + Math.max(0, fraction) * (last - first);
  const next = actions.find((action) => action.t > time);
  if (!next) return actions.at(-1).sewn;
  const index = actions.indexOf(next);
  if (!index) return Math.min(0, next.birth - 0.01);
  const previous = actions[index - 1];
  const k = progressAt(time, previous.t, next.t);
  return previous.birth + (next.birth - previous.birth) * k;
}

export function connectedActions(links, selection) {
  const ids = new Set();
  if (!selection) return ids;
  const actions = selection.action ? [selection.action] : selection.band.actions;
  for (const action of actions) ids.add(action.id);
  for (const link of links) {
    if (actions.includes(link.from) || actions.includes(link.to)) {
      ids.add(link.from.id);
      ids.add(link.to.id);
    }
  }
  return ids;
}
