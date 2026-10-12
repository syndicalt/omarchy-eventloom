// Where every action sits on the cloth. Pure and deterministic, shared by the
// browser and node --test. Units are cloth units (one cross-stitch cell);
// the origin is the lower-left corner of the stitched area and y grows upward
// with time.
import { borderKind } from "./motif.mjs";

export const CELL = 12; // one motif: a 9-cell design, its tally, and breathing room
const GUTTER = 8; // bare linen between neighbouring bands
const BORDER_ROW = 0.62; // session borders are shorter than a motif row

const time = (stitch) => {
  const t = typeof stitch.at === "number" ? stitch.at : Date.parse(stitch.ts ?? "");
  return Number.isFinite(t) ? t : null;
};

// A band is a session. Events that carry no session id are gathered into one
// band per actor, so a chatty sessionless source does not fray into dozens of
// one-motif bands.
export function sessionKey(stitch) {
  return stitch.session ?? stitch.actor;
}

// One motif per action, not per log line: a tool's start and end are the same
// piece of work, so they are stitched once. A start with no end stays
// half-stitched.
export function buildActions(stitches) {
  const ordered = stitches
    .map((stitch, index) => ({ stitch, index, t: time(stitch) }))
    .filter((entry) => entry.t !== null)
    .sort((a, b) => a.t - b.t || a.index - b.index);
  const actions = [];
  const open = new Map();
  for (const { stitch, t } of ordered) {
    const key = sessionKey(stitch);
    if (stitch.family === "tool" && stitch.type !== "agent.tool.started") {
      const queue = open.get(key + "\n" + (stitch.tool ?? ""));
      const started = queue?.shift();
      if (started) {
        started.pending = false;
        started.type = stitch.type;
        started.ok = stitch.ok !== false;
        started.t1 = t;
        started.duration = stitch.duration || Math.max(0, t - started.t);
        started.events.push(stitch);
        continue;
      }
    }
    const action = {
      id: stitch.id,
      key,
      actor: stitch.actor,
      type: stitch.type,
      family: stitch.family ?? "other",
      tool: stitch.tool ?? null,
      glyph: stitch.tool ?? stitch.detail?.fleet_event_type ?? stitch.type,
      ok: stitch.ok !== false,
      pending: stitch.type === "agent.tool.started",
      duration: stitch.duration || 0,
      t,
      t1: t,
      border: borderKind(stitch.type),
      events: [stitch],
    };
    if (action.pending) {
      const slot = key + "\n" + (stitch.tool ?? "");
      (open.get(slot) ?? open.set(slot, []).get(slot)).push(action);
    }
    actions.push(action);
  }
  return actions;
}

// How many motifs a band may hold side by side.
export function bandCapacity(count) {
  if (count <= 2) return 1;
  if (count <= 8) return 2;
  if (count <= 24) return 3;
  if (count <= 60) return 4;
  if (count <= 110) return 5;
  if (count <= 180) return 6;
  if (count <= 320) return 8;
  return 10;
}

function packColumns(bands) {
  const columns = [];
  const ordered = [...bands].sort((a, b) => a.y0 - b.y0 || a.y1 - b.y1 || String(a.key).localeCompare(String(b.key)));
  for (const band of ordered) {
    const floor = band.y0 - 1.4; // room for the session tag beneath the band
    let column = columns.find((candidate) => candidate.top <= floor);
    if (!column) {
      column = { index: columns.length, top: -Infinity, capacity: 1 };
      columns.push(column);
    }
    column.top = band.y1 + 0.4;
    column.capacity = Math.max(column.capacity, band.capacity);
    band.column = column.index;
  }
  return columns;
}

export function layoutWeave(spec) {
  const actions = buildActions(spec.stitches ?? []);
  const empty = { actions, bands: [], links: [], ruler: [], breaks: [], width: 0, height: 0, rows: 0 };
  if (!actions.length) return empty;

  const bands = new Map();
  for (const action of actions) {
    let band = bands.get(action.key);
    if (!band) {
      band = { key: action.key, actor: action.actor, sessionId: action.events[0].session ?? action.key, actions: [] };
      bands.set(action.key, band);
    }
    band.actions.push(action);
  }
  for (const band of bands.values()) {
    band.capacity = bandCapacity(band.actions.filter((action) => !action.border).length);
  }

  // Picks: short runs of wall-clock time that share a stretch of cloth. Rows
  // are shared by every band, so height always reads as time, but idle time
  // is gathered up rather than woven at full length.
  const t0 = actions[0].t;
  const t1 = actions.at(-1).t;
  const bucketMs = Math.max(20_000, Math.min(30 * 60_000, (t1 - t0) / 24));
  const picks = [];
  for (const action of actions) {
    let pick = picks.at(-1);
    if (!pick || action.t - pick.t0 > bucketMs) {
      pick = { t0: action.t, t1: action.t, actions: [] };
      picks.push(pick);
    }
    pick.t1 = action.t;
    pick.actions.push(action);
  }

  let cursor = 0;
  const breaks = [];
  picks.forEach((pick, index) => {
    if (index) {
      const idle = pick.t0 - picks[index - 1].t1;
      if (idle > bucketMs * 3) {
        const gap = 0.35 + Math.min(1.6, Math.log10(idle / bucketMs) * 0.7);
        breaks.push({ y: (cursor + gap / 2) * CELL, ms: idle });
        cursor += gap;
      }
    }
    pick.y = cursor;
    let tallest = 0;
    const perBand = new Map();
    for (const action of pick.actions) (perBand.get(action.key) ?? perBand.set(action.key, []).get(action.key)).push(action);
    for (const [key, list] of perBand) {
      const band = bands.get(key);
      let y = cursor;
      let row = [];
      const flush = () => {
        if (!row.length) return;
        const reverse = Math.round(y) % 2 === 1; // boustrophedon, as a hand works
        row.forEach((action, slot) => {
          const place = reverse ? row.length - 1 - slot : slot;
          action.row = y;
          action.offset = place - (row.length - 1) / 2;
          action.span = row.length;
        });
        y += 1;
        row = [];
      };
      for (const action of list) {
        if (action.border) {
          flush();
          action.row = y;
          action.offset = 0;
          action.span = band.capacity;
          y += BORDER_ROW;
          continue;
        }
        row.push(action);
        if (row.length === band.capacity) flush();
      }
      flush();
      tallest = Math.max(tallest, y - cursor);
    }
    pick.rows = tallest;
    cursor += tallest;
  });

  const list = [...bands.values()];
  for (const band of list) {
    band.y0 = Math.min(...band.actions.map((action) => action.row));
    band.y1 = Math.max(...band.actions.map((action) => action.row + (action.border ? BORDER_ROW : 1)));
    band.t0 = band.actions[0].t;
    band.t1 = band.actions.at(-1).t1;
  }
  const columns = packColumns(list);
  let x = 0;
  for (const column of columns) {
    column.width = column.capacity * CELL + GUTTER;
    column.x = x + column.width / 2;
    x += column.width;
  }
  const width = x;
  const height = cursor * CELL;

  for (const band of list) {
    band.x = columns[band.column].x;
    band.width = band.capacity * CELL;
    const final = band.actions.at(-1);
    band.status = final.type === "agent.session.completed" ? "completed" : final.type === "agent.session.failed" ? "failed" : "open";
    band.completion = band.status === "completed" || band.actions.some((action) => action.events.some((event) => event.goal_completed));
    band.failure = band.status === "failed" || band.actions.some((action) => !action.ok);
    band.toolCount = band.actions.filter((action) => action.family === "tool").length;
    band.approvalCount = band.actions.filter((action) => action.family === "approval").length;
    band.eventCount = band.actions.reduce((sum, action) => sum + action.events.length, 0);

    // The activity envelope: the band's edge follows how many motifs each row
    // holds, and draws in to a thread where the session went quiet.
    const rows = new Map();
    for (const action of band.actions) {
      action.band = band;
      action.x = band.x + action.offset * CELL;
      action.height = action.border ? BORDER_ROW * CELL : CELL;
      action.y = action.row * CELL + action.height / 2;
      action.width = action.border ? band.width : CELL;
      const half = action.border ? band.width / 2 : (action.span * CELL) / 2;
      const previous = rows.get(action.row);
      if (!previous || previous.half < half) rows.set(action.row, { y0: action.row, y1: action.row + action.height / CELL, half });
    }
    const spans = [...rows.values()].sort((a, b) => a.y0 - b.y0);
    const envelope = [];
    spans.forEach((span, index) => {
      const before = spans[index - 1];
      if (before && span.y0 - before.y1 > 0.8) {
        const pad = Math.min(0.5, (span.y0 - before.y1) / 3);
        envelope.push({ y: (before.y1 + pad) * CELL, half: 0.9 });
        envelope.push({ y: (span.y0 - pad) * CELL, half: 0.9 });
      }
      envelope.push({ y: (span.y0 + 0.12) * CELL, half: span.half + 0.4 });
      envelope.push({ y: (span.y1 - 0.12) * CELL, half: span.half + 0.4 });
    });
    band.envelope = envelope;
    band.y0 *= CELL;
    band.y1 *= CELL;
  }

  // Yarn joins actions, so several log lines inside one action collapse.
  const owner = new Map();
  for (const action of actions) for (const event of action.events) owner.set(event.id, action);
  const links = [];
  const joined = new Set();
  for (const link of spec.links ?? []) {
    const from = owner.get(link.from);
    const to = owner.get(link.to);
    if (!from || !to || from === to) continue;
    // A resume that follows straight on needs no splice; the darn says it.
    if (link.kind === "resume" && Math.abs(to.row - from.row) < 1.6) continue;
    // A shared goal inside one band is already told by the band itself.
    if (link.kind === "correlation" && from.key === to.key) continue;
    const pair = from.id + ">" + to.id;
    if (joined.has(pair)) continue;
    joined.add(pair);
    links.push({ kind: link.kind, from, to });
  }

  const ruler = [];
  let last = -Infinity;
  for (const pick of picks) {
    if (pick.y - last < 2.4) continue;
    last = pick.y;
    ruler.push({ y: pick.y * CELL, t: pick.t0 });
  }

  return { actions, bands: list, links, ruler, breaks, width, height, rows: cursor, span: { t0, t1 } };
}
