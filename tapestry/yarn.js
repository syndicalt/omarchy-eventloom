// Plied yarn. A link between two log lines is a length of three-ply wool that
// leaves the cloth at one knot, hangs under its own weight, and goes back in
// at another. Each ply is its own tube wound around the yarn's centreline.
import * as THREE from "/vendor/three.module.min.js";

const PLIES = 3;
const SIDES = 6;

// The path a slack yarn takes between two points on a hanging cloth.
export function yarnPath(a, b, seed = 0) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  const lift = Math.max(2.2, Math.min(7, 1.6 + dist * 0.035));
  const sag = Math.max(1.5, Math.min(16, dist * 0.13));
  const side = seed % 2 ? 1 : -1;
  // A near-vertical run would hide behind itself; let it belly sideways.
  const belly = Math.abs(dx) < dist * 0.25 ? side * (3 + dist * 0.07) : 0;
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(a.x, a.y, 0.25),
    new THREE.Vector3(a.x + dx * 0.07 + belly * 0.35, a.y + dy * 0.07 - sag * 0.12, lift * 0.62),
    new THREE.Vector3(a.x + dx * 0.5 + belly, a.y + dy * 0.5 - sag, lift),
    new THREE.Vector3(a.x + dx * 0.93 + belly * 0.35, a.y + dy * 0.93 - sag * 0.12, lift * 0.62),
    new THREE.Vector3(b.x, b.y, 0.25),
  ], false, "centripetal");
  return curve;
}

// `shadow` is the cloth-plane offset a shadow travels per unit of height.
export function buildYarn(curve, { radius = 0.5, colors, seed = 1, shadow = { x: 0.5, y: -0.6 } }) {
  const length = curve.getLength();
  const pitch = radius * 7;
  const samples = Math.max(48, Math.min(900, Math.ceil((length / pitch) * 12)));
  const centre = curve.getSpacedPoints(samples);
  let rnd = seed >>> 0;
  const rand = () => {
    rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0;
    return rnd / 4294967296;
  };

  // Parallel-transport frames keep the plies from flipping along the curve.
  const tangents = centre.map((point, i) => {
    const next = centre[Math.min(samples, i + 1)];
    const prev = centre[Math.max(0, i - 1)];
    return next.clone().sub(prev).normalize();
  });
  const normals = [];
  let normal = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i <= samples; i++) {
    normal = normal.clone().addScaledVector(tangents[i], -normal.dot(tangents[i])).normalize();
    normals.push(normal);
  }

  const plyRadius = radius * 0.56;
  const orbit = radius * 0.5;
  const ring = SIDES + 1;
  const count = (samples + 1) * ring * PLIES;
  const position = new Float32Array(count * 3);
  const normalAttr = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const index = [];
  const plyCentre = [];
  for (let p = 0; p < PLIES; p++) {
    const line = [];
    for (let i = 0; i <= samples; i++) {
      const s = (i / samples) * length;
      const angle = (s / pitch) * Math.PI * 2 + (p / PLIES) * Math.PI * 2;
      const binormal = tangents[i].clone().cross(normals[i]);
      const out = normals[i].clone().multiplyScalar(Math.cos(angle)).addScaledVector(binormal, Math.sin(angle));
      const end = Math.min(1, Math.min(i, samples - i) / 6);
      line.push({ at: centre[i].clone().addScaledVector(out, orbit * (0.4 + 0.6 * end)), out, end });
    }
    plyCentre.push(line);
  }
  const tint = new THREE.Color();
  for (let p = 0; p < PLIES; p++) {
    const base = new THREE.Color(colors[p % colors.length]);
    for (let i = 0; i <= samples; i++) {
      const here = plyCentre[p][i];
      const ahead = plyCentre[p][Math.min(samples, i + 1)].at;
      const behind = plyCentre[p][Math.max(0, i - 1)].at;
      const along = ahead.clone().sub(behind).normalize();
      const side = along.clone().cross(here.out).normalize();
      const r = plyRadius * (0.55 + 0.45 * here.end) * (0.94 + rand() * 0.12);
      for (let k = 0; k <= SIDES; k++) {
        const a = (k / SIDES) * Math.PI * 2;
        const dir = here.out.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
        const v = (p * (samples + 1) + i) * ring + k;
        position[v * 3] = here.at.x + dir.x * r;
        position[v * 3 + 1] = here.at.y + dir.y * r;
        position[v * 3 + 2] = here.at.z + dir.z * r;
        normalAttr[v * 3] = dir.x;
        normalAttr[v * 3 + 1] = dir.y;
        normalAttr[v * 3 + 2] = dir.z;
        // The inner face of a ply sits in the yarn's own shade.
        const occlusion = 0.62 + 0.38 * Math.max(0, Math.cos(a));
        tint.copy(base).multiplyScalar(occlusion * (0.93 + rand() * 0.14));
        color[v * 3] = tint.r;
        color[v * 3 + 1] = tint.g;
        color[v * 3 + 2] = tint.b;
        uv[v * 2] = k / SIDES;
        uv[v * 2 + 1] = ((i / samples) * length) / (radius * 2.2);
      }
    }
  }
  // Indexed sample by sample across all plies, so a draw range reveals the
  // whole yarn from one end.
  for (let i = 0; i < samples; i++) {
    for (let p = 0; p < PLIES; p++) {
      for (let k = 0; k < SIDES; k++) {
        const a = (p * (samples + 1) + i) * ring + k;
        const b = a + ring;
        index.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normalAttr, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);

  // The shadow widens and fades as the yarn lifts away from the cloth.
  const sPos = new Float32Array((samples + 1) * 2 * 3);
  const sUv = new Float32Array((samples + 1) * 2 * 2);
  const sAlpha = new Float32Array((samples + 1) * 2);
  const sIndex = [];
  for (let i = 0; i <= samples; i++) {
    const c = centre[i];
    const gx = c.x + c.z * shadow.x;
    const gy = c.y + c.z * shadow.y;
    const t = tangents[i];
    const flat = Math.hypot(t.x, t.y) || 1;
    const nx = -t.y / flat;
    const ny = t.x / flat;
    const half = radius * (1.5 + c.z * 0.55);
    const alpha = 0.62 / (1 + c.z * 0.42);
    for (let k = 0; k < 2; k++) {
      const sign = k ? 1 : -1;
      const v = i * 2 + k;
      sPos[v * 3] = gx + nx * half * sign;
      sPos[v * 3 + 1] = gy + ny * half * sign;
      sPos[v * 3 + 2] = 0.016;
      sUv[v * 2] = k;
      sUv[v * 2 + 1] = i / samples;
      sAlpha[v] = alpha;
    }
    if (i < samples) sIndex.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  const shadowGeometry = new THREE.BufferGeometry();
  shadowGeometry.setAttribute("position", new THREE.BufferAttribute(sPos, 3));
  shadowGeometry.setAttribute("uv", new THREE.BufferAttribute(sUv, 2));
  shadowGeometry.setAttribute("alpha", new THREE.BufferAttribute(sAlpha, 1));
  shadowGeometry.setIndex(sIndex);

  return {
    geometry,
    shadowGeometry,
    length,
    indexCount: index.length,
    shadowIndexCount: sIndex.length,
    perSample: PLIES * SIDES * 6,
    samples,
    ends: [centre[0], centre[samples]],
  };
}

export function yarnShadowMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute float alpha;
      varying float vAlpha;
      varying vec2 vUv;
      void main() {
        vAlpha = alpha;
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying float vAlpha;
      varying vec2 vUv;
      void main() {
        float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
        float ends = smoothstep(0.0, 0.02, vUv.y) * smoothstep(1.0, 0.98, vUv.y);
        gl_FragColor = vec4(0.13, 0.07, 0.03, vAlpha * smoothstep(0.0, 1.0, across) * ends);
      }`,
  });
}
