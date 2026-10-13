// Stitch patterns for the tapestry. Pure and deterministic: the same action
// always produces the same embroidery, in the browser and under node --test.
//
// A motif is a list of thread stitches in cloth units (one unit = one
// cross-stitch cell = two linen threads), centred on the origin, in the order
// a needle would lay them:
//   stitches: [x0, y0, x1, y1, tone, flags]
//   knots:    [x, y, tone, size]
export const TONE = { dye: 0, light: 1, dark: 2, gold: 3, rust: 4, violet: 5, cream: 6, ink: 7 };
export const LOOSE = 1; // a frayed end that lifts off the cloth
export const FINE = 2; // a thinner thread

export function hashSeed(value) {
  let hash = 2166136261;
  for (const char of String(value)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// An eight-fold symmetric counted-thread glyph, the way folk samplers repeat a
// design around its centre. Returns rows of tones (-1 = bare linen).
export function glyph(key, size) {
  const half = (size - 1) / 2;
  const rand = rng(hashSeed("glyph:" + key));
  const rings = [];
  for (let r = 0; r <= half; r++) rings.push(rand() < 0.34 ? TONE.light : rand() < 0.3 ? TONE.dark : TONE.dye);
  rings[0] = TONE.light;
  const wedge = new Map();
  let filled = 0;
  for (let a = 0; a <= half; a++) {
    for (let b = 0; b <= a; b++) {
      const edge = a === half;
      let on = rand() < (edge ? 0.42 : 0.66);
      if (a === half && b === half) on = false;
      if (a === 0) on = true;
      if (a === 1 && b === 0) on = true;
      if (on) filled++;
      wedge.set(a + ":" + b, on ? rings[a] : -1);
    }
  }
  if (filled < 5) for (let a = 0; a <= half; a++) wedge.set(a + ":" + Math.min(a, 1), rings[a]);
  const grid = [];
  for (let y = -half; y <= half; y++) {
    const row = [];
    for (let x = -half; x <= half; x++) {
      const a = Math.max(Math.abs(x), Math.abs(y));
      const b = Math.min(Math.abs(x), Math.abs(y));
      row.push(wedge.get(a + ":" + b));
    }
    grid.push(row);
  }
  return grid;
}

const INSET = 0.06;

// Counted cross stitch, sewn the Danish way: every under-leg of a row first,
// then back along the row laying the top legs.
function crossStitch(out, grid, options = {}) {
  const size = grid.length;
  const half = size / 2;
  const { rand, failed = false, pending = false } = options;
  for (let j = 0; j < size; j++) {
    const row = [];
    for (let i = 0; i < size; i++) {
      let tone = grid[j][i];
      if (tone < 0) continue;
      let top = !pending;
      if (failed) {
        const roll = rand();
        if (roll < 0.16) continue; // a dropped stitch
        if (roll < 0.52) tone = TONE.rust;
        if (roll > 0.7) top = false; // left as a half stitch
      }
      row.push({ x: i - half, y: j - half, tone, top });
    }
    for (const c of row) out.push([c.x + INSET, c.y + INSET, c.x + 1 - INSET, c.y + 1 - INSET, c.tone, 0]);
    for (const c of row.reverse()) {
      if (c.top) out.push([c.x + 1 - INSET, c.y + INSET, c.x + INSET, c.y + 1 - INSET, c.tone, 0]);
    }
  }
}

function fray(out, rand, radius, count, spread = Math.PI * 2, heading = 0) {
  for (let i = 0; i < count; i++) {
    const angle = heading + (rand() - 0.5) * spread;
    const from = radius * (0.55 + rand() * 0.35);
    const length = 1.6 + rand() * 2.4;
    const bend = angle + (rand() - 0.5) * 0.9;
    out.push([
      Math.cos(angle) * from, Math.sin(angle) * from,
      Math.cos(angle) * from + Math.cos(bend) * length, Math.sin(angle) * from + Math.sin(bend) * length,
      rand() < 0.6 ? TONE.rust : TONE.dye, LOOSE | FINE,
    ]);
  }
}

// How long the action took, tallied in short bars beneath the design.
function tally(out, duration, y) {
  if (!(duration > 0)) return;
  const n = Math.max(1, Math.min(6, Math.round(Math.log10(duration + 1) - 1.4)));
  const pitch = 1.3;
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * pitch;
    out.push([x - 0.45, y, x + 0.45, y, TONE.dark, FINE]);
  }
}

function ring(out, radius, segments, tone, flags = FINE, phase = 0) {
  for (let i = 0; i < segments; i++) {
    const a = phase + (i / segments) * Math.PI * 2;
    const b = phase + ((i + 1) / segments) * Math.PI * 2;
    out.push([Math.cos(a) * radius, Math.sin(a) * radius, Math.cos(b) * radius, Math.sin(b) * radius, tone, flags]);
  }
}

const designs = {
  // Tool calls: one counted glyph per tool name, so `bash` always reads as
  // the same figure and `read` as another.
  tool(action, m, rand) {
    crossStitch(m.stitches, glyph(action.glyph, 9), { rand, failed: !action.ok, pending: action.pending });
    tally(m.stitches, action.duration, -5.5);
    if (!action.ok) fray(m.stitches, rand, 4.5, 6);
  },
  // Approval: an Algerian eye in gold, closed with a ring once resolved.
  approval(action, m) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r = i % 2 ? 2.6 : 4.2;
      m.stitches.push([Math.cos(a) * r, Math.sin(a) * r, Math.cos(a) * 0.35, Math.sin(a) * 0.35, i % 4 === 0 ? TONE.cream : TONE.gold, 0]);
    }
    if (/resolved/.test(action.type)) ring(m.stitches, 4.6, 14, TONE.gold);
    m.knots.push([0, 0, TONE.gold, 0.55]);
  },
  // Model turns: a spiral of French knots.
  model(action, m, rand) {
    ring(m.stitches, 4.2, 16, TONE.dark);
    const count = 13;
    for (let i = 0; i < count; i++) {
      const a = i * 2.39996 + rand() * 0.2;
      const r = 0.55 * Math.sqrt(i) + (i ? 0.5 : 0);
      m.knots.push([Math.cos(a) * r, Math.sin(a) * r, i % 3 === 0 ? TONE.light : TONE.dye, 0.42 + rand() * 0.12]);
    }
  },
  // File mutations: a satin-stitch lozenge.
  file(action, m) {
    for (let y = -4; y <= 4; y += 0.5) {
      const w = 4.2 - Math.abs(y) * 0.95;
      if (w <= 0.2) continue;
      m.stitches.push([-w, y - 0.12, w, y + 0.12, Math.abs(y) < 1.6 ? TONE.light : TONE.dye, 0]);
    }
    m.stitches.push([0, -4.4, 0, 4.4, TONE.dark, FINE]);
  },
  // Git mutations: a feather-stitched branch.
  git(action, m) {
    for (let i = 0; i < 4; i++) m.stitches.push([0, -4.4 + i * 2.2, 0, -2.2 + i * 2.2, TONE.dark, 0]);
    for (let i = 0; i < 6; i++) {
      const y = -3.6 + i * 1.35;
      const side = i % 2 ? 1 : -1;
      const reach = 3.4 - i * 0.36;
      m.stitches.push([0, y, side * reach, y + reach * 0.8, TONE.dye, 0]);
      m.stitches.push([side * reach * 0.5, y + reach * 0.4, side * reach * 0.5 + side * reach * 0.42, y + reach * 0.1, TONE.light, FINE]);
      m.knots.push([side * reach, y + reach * 0.8, TONE.light, 0.4]);
    }
  },
  // Handoff: a buttonholed eyelet. The cord to the receiving session leaves
  // through it.
  handoff(action, m) {
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      m.stitches.push([Math.cos(a) * 1.5, Math.sin(a) * 1.5, Math.cos(a) * 3.9, Math.sin(a) * 3.9, i % 3 ? TONE.violet : TONE.light, 0]);
    }
    ring(m.stitches, 4.2, 18, TONE.dark);
  },
  // Resume: a darned patch joining the old thread to the new.
  resume(action, m) {
    for (let i = -2; i <= 2; i++) m.stitches.push([-2.6, i * 0.8, 2.6, i * 0.8, TONE.light, 0]);
    for (let i = -2; i <= 2; i++) m.stitches.push([i * 0.8, -2.6, i * 0.8, 2.6, i % 2 ? TONE.dark : TONE.dye, 0]);
  },
  // Memory. A summary is a wound bobbin: thread laid by for later, gold at
  // its core. A recall is the empty eye that thread is drawn through.
  memory(action, m) {
    if (action.type === "agent.memory.recalled") {
      ring(m.stitches, 3.1, 20, TONE.gold, 0);
      ring(m.stitches, 2.3, 16, TONE.cream);
      return;
    }
    for (let i = 0; i < 4; i++) ring(m.stitches, 3.4 - i * 0.75, 20 - i * 3, i % 2 ? TONE.cream : TONE.gold, i ? FINE : 0, i * 0.4);
    for (let i = -3; i <= 3; i++) m.stitches.push([-2.4, i * 0.7, 2.4, i * 0.7 + 0.35, i % 2 ? TONE.light : TONE.dye, FINE]);
    m.knots.push([0, 0, TONE.gold, 0.7]);
  },
  // Notes and anything unrecognised: a small counted glyph keyed by subtype.
  note(action, m, rand) {
    crossStitch(m.stitches, glyph(action.glyph, 5), { rand, failed: !action.ok });
  },
  other(action, m, rand) {
    crossStitch(m.stitches, glyph(action.glyph, 7), { rand, failed: !action.ok });
    if (!action.ok) fray(m.stitches, rand, 3.5, 4);
  },
};

// Session boundaries span the whole band rather than one cell.
const borders = {
  // Cast on: a satin hem under a row of crosses.
  started(action, m, rand, width) {
    const half = width / 2;
    for (let x = -half; x <= half + 0.01; x += 0.5) {
      m.stitches.push([x, -1.6, x + 0.1, 0.3, Math.round(x * 2) % 8 === 0 ? TONE.light : TONE.dye, 0]);
    }
    const cells = Math.floor(width);
    const xs = [];
    for (let i = 0; i < cells; i += 2) xs.push(-cells / 2 + i + (cells % 2 ? 0 : 0.5));
    for (const x of xs) m.stitches.push([x + INSET, 1.2 + INSET, x + 1 - INSET, 2.2 - INSET, TONE.dark, 0]);
    for (const x of xs.reverse()) m.stitches.push([x + 1 - INSET, 1.2 + INSET, x + INSET, 2.2 - INSET, TONE.dark, 0]);
  },
  // Bind off: a herringbone seam, then the completion knot.
  completed(action, m, rand, width) {
    const half = width / 2;
    for (let x = -half; x < half - 0.01; x += 1.5) {
      m.stitches.push([x, -1.5, x + 1.9, 1.1, TONE.light, 0]);
      m.stitches.push([x + 1.5, -1.5, x - 0.4, 1.1, TONE.cream, 0]);
    }
    for (let x = -half; x <= half + 0.01; x += 0.5) m.stitches.push([x, 2, x + 0.1, 3.2, TONE.dye, 0]);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 1.9 - 0.3;
        const b = ((i + 1) / 7) * Math.PI * 1.9 - 0.3;
        const loop = (t) => [side * (1.5 + Math.cos(t) * 1.25), 2.6 + Math.sin(t) * 0.95];
        m.stitches.push([...loop(a), ...loop(b), TONE.cream, 0]);
      }
    }
    m.knots.push([0, 2.6, TONE.cream, 0.95], [-0.5, 1.5, TONE.light, 0.45], [0.5, 1.5, TONE.light, 0.45]);
  },
  // Abandoned: a ragged row with the ends left hanging.
  failed(action, m, rand, width) {
    const half = width / 2;
    for (let x = -half; x < half - 0.01; x += 1) {
      if (rand() < 0.22) continue;
      m.stitches.push([x + INSET, -1, x + 1 - INSET, 0, rand() < 0.6 ? TONE.rust : TONE.dye, 0]);
      if (rand() < 0.45) m.stitches.push([x + 1 - INSET, -1, x + INSET, 0, TONE.rust, 0]);
    }
    for (let x = -half + 0.5; x < half; x += 1.1 + rand()) {
      const lean = (rand() - 0.5) * 1.6;
      const len = 1.8 + rand() * 3.4;
      m.stitches.push([x, 0, x + lean, len, rand() < 0.5 ? TONE.rust : TONE.light, LOOSE | FINE]);
    }
  },
};

const BORDER = {
  "agent.session.started": "started",
  "agent.session.completed": "completed",
  "agent.session.failed": "failed",
};

export function borderKind(type) {
  return BORDER[type] ?? null;
}

export function designKind(action) {
  if (action.type === "agent.session.resumed") return "resume";
  if (designs[action.family]) return action.family;
  return "other";
}

// `width` is only used by session borders: the band width in cells.
export function motifFor(action, width = 9) {
  const m = { stitches: [], knots: [], kind: null };
  const rand = rng(hashSeed("motif:" + action.id));
  const border = borderKind(action.type);
  if (border) {
    m.kind = border;
    borders[border](action, m, rand, width);
  } else {
    m.kind = designKind(action);
    designs[m.kind](action, m, rand);
  }
  return m;
}
