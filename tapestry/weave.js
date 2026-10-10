const canvas = document.querySelector("#cloth");
const ctx = canvas.getContext("2d");
const panel = document.querySelector("#panel");
const empty = document.querySelector("#empty");
const DYES = ["#3e6b4c", "#34597d", "#8d4630", "#684874", "#9a7430", "#2e5c58", "#7a3d4a"];
const state = { spec: null, sessions: [], scale: 1, panX: 0, panY: 0, drag: null, selected: null, layout: [] };

const hash = (value) => {
  let h = 2166136261;
  for (const ch of String(value)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};
const dye = (actor) => DYES[hash(actor) % DYES.length];
function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => {
    if (ch === "&") return "&" + "amp;";
    if (ch === "<") return "&" + "lt;";
    if (ch === ">") return "&" + "gt;";
    return "&" + "quot;";
  });
}

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const channel = (shift) => Math.max(0, Math.min(255, ((n >> shift) & 255) + amount));
  return `rgb(${channel(16)},${channel(8)},${channel(0)})`;
}

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  canvas.style.width = innerWidth + "px";
  canvas.style.height = innerHeight + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function fit() {
  const sessions = state.sessions;
  if (!sessions.length) return;
  const lo = Math.min(...sessions.map((s) => s.start));
  const hi = Math.max(...sessions.map((s) => s.end));
  const span = Math.max(60_000, hi - lo);
  const pad = span * 0.08;
  state.domain = { lo: lo - pad * 0.35, hi: hi + pad };
  state.scale = 1;
  state.panX = 0;
  state.panY = 0;
}

function field() {
  const top = 168;
  const bottom = 52;
  return {
    left: 132,
    right: 56,
    top,
    bottom,
    width: Math.max(240, innerWidth - 188),
    height: Math.max(220, innerHeight - top - bottom),
  };
}

function columnCount() {
  return Math.max(1, state.spec?.columnCount || Math.max(...state.sessions.map((s) => (s.column ?? 0) + 1), 1));
}

function columns(frame) {
  const cols = columnCount();
  const pitch = Math.min(176, frame.width / cols);
  const origin = frame.left + (frame.width - pitch * cols) / 2;
  return { cols, pitch, origin };
}

function position(session, frame) {
  const span = state.domain.hi - state.domain.lo;
  const y = (t) => frame.top + frame.height - ((t - state.domain.lo) / span) * frame.height * state.scale + state.panY;
  const { pitch, origin } = columns(frame);
  return {
    x: origin + ((session.column ?? 0) + 0.5) * pitch * state.scale + state.panX,
    y0: y(session.start),
    y1: y(session.end),
    y,
  };
}

function widthsOf(session) {
  const raw = session.samples?.length ? session.samples : [0.42];
  return raw.map((value) => 11 + Math.max(0, Math.min(1, value)) * 32);
}

function halfAt(widths, t) {
  if (widths.length === 1) return widths[0];
  const x = Math.max(0, Math.min(0.9999, t)) * (widths.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const ease = f * f * (3 - 2 * f);
  return widths[i] * (1 - ease) + (widths[i + 1] ?? widths[i]) * ease;
}

function silhouette(x, y0, y1, widths) {
  const steps = Math.max(10, Math.round(Math.abs(y0 - y1) / 7));
  const left = [];
  const right = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = y0 + (y1 - y0) * t;
    const w = halfAt(widths, t);
    left.push([x - w, y]);
    right.push([x + w, y]);
  }
  return left.concat(right.reverse());
}

function trace(points) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.closePath();
}

function clothRect(frame) {
  return { x: frame.left - 46, y: frame.top - 8, w: frame.width + 92, h: frame.height + 16 };
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawRoom() {
  const g = ctx.createRadialGradient(innerWidth * 0.5, innerHeight * 0.42, 80, innerWidth * 0.5, innerHeight * 0.5, innerWidth * 0.72);
  g.addColorStop(0, "#2a2118");
  g.addColorStop(1, "#100d0b");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, innerWidth, innerHeight);
}

function drawHanging(rect) {
  const rodY = rect.y - 22;
  ctx.strokeStyle = "rgba(214, 186, 140, 0.45)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    const x = rect.x + 28 + ((rect.w - 56) * i) / 6;
    ctx.beginPath();
    ctx.moveTo(x, rodY + 8);
    ctx.lineTo(x + Math.sin(i) * 2, rect.y);
    ctx.stroke();
  }
  const wood = ctx.createLinearGradient(0, rodY - 6, 0, rodY + 10);
  wood.addColorStop(0, "#8a6842");
  wood.addColorStop(0.45, "#e6d0a4");
  wood.addColorStop(1, "#4e341c");
  ctx.fillStyle = wood;
  roundRect(rect.x - 18, rodY, rect.w + 36, 12, 6);
  ctx.fill();
  ctx.fillStyle = "#6a4a2c";
  ctx.beginPath();
  ctx.arc(rect.x - 18, rodY + 6, 8, 0, Math.PI * 2);
  ctx.arc(rect.x + rect.w + 18, rodY + 6, 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 16;
  const linen = ctx.createLinearGradient(rect.x, rect.y, rect.x, rect.y + rect.h);
  linen.addColorStop(0, "#ead7b4");
  linen.addColorStop(0.55, "#d7c094");
  linen.addColorStop(1, "#c6ad80");
  ctx.fillStyle = linen;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x + 7, rect.y + 7, rect.w - 14, rect.h - 14);
  ctx.clip();
  ctx.beginPath();
  for (let y = rect.y + 8; y < rect.y + rect.h - 8; y += 4) {
    const drift = Math.sin(y * 0.05) * 0.8;
    ctx.moveTo(rect.x + 8, y);
    ctx.lineTo(rect.x + rect.w - 8, y + drift);
  }
  ctx.strokeStyle = "rgba(255, 248, 232, 0.28)";
  ctx.lineWidth = 1.15;
  ctx.stroke();
  ctx.beginPath();
  for (let y = rect.y + 10; y < rect.y + rect.h - 8; y += 8) {
    ctx.moveTo(rect.x + 8, y);
    ctx.lineTo(rect.x + rect.w - 8, y + Math.sin(y * 0.03));
  }
  ctx.strokeStyle = "rgba(92, 62, 32, 0.08)";
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "#6d5132";
  ctx.lineWidth = 9;
  ctx.strokeRect(rect.x + 4.5, rect.y + 4.5, rect.w - 9, rect.h - 9);
  ctx.strokeStyle = "rgba(255, 236, 204, 0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 11, rect.y + 11, rect.w - 22, rect.h - 22);
}

function drawWarp(rect) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x + 12, rect.y + 12, rect.w - 24, rect.h - 24);
  ctx.clip();
  ctx.lineWidth = 1;
  for (let x = rect.x + 16; x < rect.x + rect.w - 14; x += 6) {
    const lean = Math.sin(x * 0.08) * 0.7;
    ctx.beginPath();
    ctx.moveTo(x, rect.y + 12);
    ctx.lineTo(x + lean, rect.y + rect.h - 12);
    ctx.strokeStyle = "rgba(86, 58, 30, 0.08)";
    ctx.stroke();
  }
  ctx.restore();
}

function sessionMarks(session) {
  const marks = [];
  for (const event of state.spec?.stitches || []) {
    if (event.session !== session.sessionId) continue;
    const t = Date.parse(event.ts);
    if (!Number.isFinite(t) || t < session.start || t > session.end) continue;
    marks.push(event);
  }
  return marks;
}

function drawUpright(session, frame) {
  const p = position(session, frame);
  const widths = widthsOf(session);
  const points = silhouette(p.x, p.y0, p.y1, widths);
  const color = dye(session.actor);
  const selected = state.selected?.id === session.id;

  ctx.save();
  ctx.translate(3, 5);
  trace(points);
  ctx.fillStyle = "rgba(48, 28, 12, 0.22)";
  ctx.fill();
  ctx.restore();

  ctx.save();
  trace(points);
  ctx.clip();
  const top = Math.min(p.y0, p.y1);
  const bot = Math.max(p.y0, p.y1);
  const ground = ctx.createLinearGradient(p.x - 40, 0, p.x + 40, 0);
  ground.addColorStop(0, shade(color, -28));
  ground.addColorStop(0.5, color);
  ground.addColorStop(1, shade(color, -28));
  ctx.fillStyle = ground;
  ctx.globalAlpha = selected ? 0.96 : 0.9;
  ctx.fillRect(p.x - 80, top, 160, bot - top);
  ctx.globalAlpha = 1;

  let pass = (session.seed || 0) % 2;
  for (let y = top + 2; y < bot - 1; y += 2.7) {
    const t = (y - p.y0) / (p.y1 - p.y0 || 1);
    const w = halfAt(widths, Math.max(0, Math.min(1, t)));
    const shed = pass % 2 === 0;
    ctx.beginPath();
    ctx.moveTo(p.x - w + (shed ? 1.4 : 0), y);
    ctx.lineTo(p.x + w - (shed ? 0 : 1.4), y);
    ctx.strokeStyle = shed ? shade(color, 36) : shade(color, -18);
    ctx.globalAlpha = shed ? 0.55 : 0.9;
    ctx.lineWidth = 1.7;
    ctx.stroke();
    pass++;
  }
  ctx.globalAlpha = 1;

  for (let ply = -1; ply <= 1; ply++) {
    ctx.beginPath();
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = p.y0 + (p.y1 - p.y0) * t;
      const w = halfAt(widths, t);
      const x = p.x + ply * w * 0.42 + Math.sin(y * 0.06 + session.seed + ply) * 0.8;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = ply === 0 ? "rgba(255, 246, 226, 0.72)" : shade(color, ply > 0 ? 18 : -8);
    ctx.lineWidth = ply === 0 ? 1.15 : 2.1;
    ctx.stroke();
  }

  let lastY = null;
  for (const event of sessionMarks(session)) {
    const y = p.y(Date.parse(event.ts));
    if (lastY !== null && Math.abs(y - lastY) < 8) continue;
    lastY = y;
    const t = (y - p.y0) / (p.y1 - p.y0 || 1);
    const w = halfAt(widths, Math.max(0, Math.min(1, t))) * 0.72;
    if (event.family === "tool") {
      ctx.strokeStyle = "rgba(255, 248, 232, 0.92)";
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(p.x - w, y + 3);
      ctx.lineTo(p.x - w * 0.25, y - 3);
      ctx.moveTo(p.x - w * 0.15, y + 3);
      ctx.lineTo(p.x + w * 0.55, y - 3);
      ctx.stroke();
    } else if (event.family === "approval") {
      ctx.strokeStyle = "#e8b15a";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x - 6, y - 4);
      ctx.lineTo(p.x + 6, y + 4);
      ctx.moveTo(p.x + 6, y - 4);
      ctx.lineTo(p.x - 6, y + 4);
      ctx.stroke();
    }
  }
  ctx.restore();

  trace(points);
  ctx.strokeStyle = selected ? "rgba(255, 248, 230, 0.95)" : shade(color, -40);
  ctx.lineWidth = selected ? 2.2 : 1;
  ctx.stroke();

  drawCap(session, p, color);
  if (Math.abs(p.y0 - p.y1) > 72) {
    ctx.save();
    ctx.translate(p.x, (p.y0 + p.y1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = "13px Palatino, Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255, 247, 232, 0.92)";
    ctx.shadowColor = "rgba(40, 22, 10, 0.45)";
    ctx.shadowBlur = 3;
    ctx.fillText(session.actor, 0, 4);
    ctx.restore();
  }
  state.layout.push({ s: session, p, widths, width: Math.max(...widths) });
}

function drawCap(session, p, color) {
  const y = p.y1;
  const x = p.x;
  if (session.failure) {
    const rnd = hash(session.id + ":fray");
    for (let i = -3; i <= 3; i++) {
      const len = 10 + ((rnd >> (i + 4)) & 15);
      const lean = i * 3.2;
      ctx.beginPath();
      ctx.moveTo(x + i * 2.2, y);
      ctx.quadraticCurveTo(x + lean, y - len * 0.55, x + lean * 1.15, y - len);
      ctx.strokeStyle = i % 2 ? "#efb28a" : shade(color, 20);
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (session.completion) {
    ctx.strokeStyle = "#f4e2b8";
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.ellipse(x, y - 5 - i * 4, 12 - i, 3.1, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = shade(color, 30);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x - 5, y - 20, 5.5, 0.4, Math.PI * 1.7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x + 5, y - 19, 5.5, Math.PI * 1.15, Math.PI * 2.55);
    ctx.stroke();
    ctx.fillStyle = "#f7ecd4";
    ctx.beginPath();
    ctx.arc(x, y - 18, 2.2, 0, Math.PI * 2);
    ctx.fill();
  } else if (!session.failure) {
    ctx.strokeStyle = "rgba(255, 244, 224, 0.8)";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(x - 8, y);
    ctx.lineTo(x, y - 9);
    ctx.lineTo(x + 8, y);
    ctx.stroke();
  }
}

function drawSplice(from, to) {
  const color = dye(to.s.actor);
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineCap = "round";
  for (const offset of [-2.2, 2.2]) {
    ctx.beginPath();
    ctx.moveTo(from.p.x + offset, from.p.y1);
    ctx.bezierCurveTo(from.p.x + 42, from.p.y1 - 28, to.p.x - 42, to.p.y0 + 28, to.p.x + offset, to.p.y0);
    ctx.strokeStyle = offset < 0 ? shade(color, -15) : shade(color, 28);
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.stroke();
  }
  ctx.restore();
}

function drawHandoff(handoff) {
  const from = state.layout.find((row) => row.s.sessionId === handoff.fromSession && handoff.at >= row.s.start && handoff.at <= row.s.end)
    || state.layout.find((row) => row.s.sessionId === handoff.fromSession);
  const to = state.layout.find((row) => row.s.sessionId === handoff.toSession);
  if (!from || !to) return;
  const y = from.p.y(handoff.at);
  ctx.save();
  ctx.setLineDash([7, 5]);
  ctx.lineCap = "round";
  for (const offset of [-1.6, 1.6]) {
    ctx.beginPath();
    ctx.moveTo(from.p.x, y + offset);
    ctx.quadraticCurveTo((from.p.x + to.p.x) / 2, y - 46, to.p.x + offset, to.p.y0);
    ctx.strokeStyle = offset < 0 ? "#8d5ea8" : "#e7c0f2";
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = "#f0d8f6";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(to.p.x, to.p.y0, 4.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawRuler(frame) {
  const { lo, hi } = state.domain;
  const multi = hi - lo > 36 * 60 * 60 * 1000;
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const t = lo + ((hi - lo) * i) / 5;
    const y = frame.top + frame.height - (i / 5) * frame.height * state.scale + state.panY;
    if (y < frame.top - 4 || y > frame.top + frame.height + 8) continue;
    ctx.strokeStyle = "rgba(214, 196, 164, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(frame.left - 28, y);
    ctx.lineTo(frame.left - 16, y);
    ctx.stroke();
    const when = new Date(t);
    const label = multi
      ? when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    ctx.fillStyle = "#cbbba4";
    ctx.fillText(label, frame.left - 34, y + 3);
  }
}

function drawKey(rect) {
  const actors = state.spec?.warp || [];
  if (!actors.length) return;
  ctx.font = "14px Palatino, Georgia, serif";
  ctx.textAlign = "left";
  const y = rect.y + rect.h + 22;
  actors.forEach((actor, i) => {
    const x = rect.x + 8 + i * 124;
    const color = dye(actor.actor);
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.bezierCurveTo(x + 8, y - 3, x + 16, y + 3, x + 28, y);
    ctx.stroke();
    ctx.fillStyle = "#eadcc4";
    ctx.fillText(actor.actor, x + 36, y + 5);
  });
}

function draw() {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  drawRoom();
  const frame = field();
  const rect = clothRect(frame);
  drawHanging(rect);
  if (!state.sessions.length) return;
  state.layout = [];
  for (const session of state.sessions) drawUpright(session, frame);
  for (const row of state.layout) {
    if (!row.s.resumed || !row.s.resumeOf) continue;
    const from = state.layout.find((other) => other.s.id === row.s.resumeOf);
    if (from) drawSplice(from, row);
  }
  for (const handoff of state.spec?.handoffs || []) drawHandoff(handoff);
  drawWarp(rect);
  drawRuler(frame);
  drawKey(rect);
}

function select(row) {
  state.selected = row.s;
  const session = row.s;
  const tools = session.toolCount ?? 0;
  const approvals = session.approvalCount ?? 0;
  const count = session.eventCount ?? session.events?.length ?? 0;
  const title = session.failure && session.completion
    ? "Completed, with a frayed pass"
    : session.completion
      ? "Bound and finished"
      : session.status === "failed"
        ? "Frayed, unfinished"
        : "Still on the loom";
  panel.innerHTML = `<h2>${esc(title)}</h2><p><b>${esc(session.actor)}</b> · ${esc(session.sessionId)}</p><p>${count} sealed events · ${tools} tools · ${approvals} approvals</p><p><code>${new Date(session.start).toLocaleString()} → ${new Date(session.end).toLocaleString()}</code></p>`;
  panel.classList.add("show");
  draw();
}

canvas.addEventListener("pointerdown", (event) => {
  state.drag = { x: event.clientX, y: event.clientY, px: state.panX, py: state.panY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!state.drag) return;
  state.panX = state.drag.px + event.clientX - state.drag.x;
  state.panY = state.drag.py + event.clientY - state.drag.y;
  draw();
});
canvas.addEventListener("pointerup", (event) => {
  if (!state.drag) return;
  const moved = Math.hypot(event.clientX - state.drag.x, event.clientY - state.drag.y);
  state.drag = null;
  if (moved >= 5) return;
  const hit = state.layout.slice().reverse().find((row) => {
    const top = Math.min(row.p.y0, row.p.y1) - 22;
    const bot = Math.max(row.p.y0, row.p.y1) + 10;
    if (event.clientY < top || event.clientY > bot) return false;
    const t = (event.clientY - row.p.y0) / (row.p.y1 - row.p.y0 || 1);
    const w = halfAt(row.widths, Math.max(0, Math.min(1, t)));
    return Math.abs(event.clientX - row.p.x) <= w + 10;
  });
  if (hit) select(hit);
  else {
    state.selected = null;
    panel.classList.remove("show");
    draw();
  }
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const frame = field();
  const { origin } = columns(frame);
  const old = state.scale;
  const next = Math.max(0.6, Math.min(3.4, old * (event.deltaY > 0 ? 0.9 : 1.1)));
  const factor = next / old;
  state.panX = event.clientX - origin - (event.clientX - origin - state.panX) * factor;
  state.panY = event.clientY - frame.top - frame.height + (frame.top + frame.height + state.panY - event.clientY) * factor;
  state.scale = next;
  draw();
}, { passive: false });

async function boot() {
  try {
    state.spec = await fetch("/weave.json").then((res) => res.json());
    state.sessions = state.spec.sessions || [];
    empty.hidden = state.sessions.length > 0;
    fit();
    resize();
  } catch {
    empty.hidden = false;
    resize();
  }
}

addEventListener("resize", resize);
boot();
