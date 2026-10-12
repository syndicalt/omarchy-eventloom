// The tapestry: a read-only projection of the sealed log, stitched onto linen.
// Every action is embroidered as its own counted design, sessions run upward
// as bands, and whatever links one log line to another is a length of yarn.
import * as THREE from "/vendor/three.module.min.js";
import { layoutWeave } from "/layout.mjs";
import { FINE, LOOSE, TONE, hashSeed, motifFor, rng } from "/motif.mjs";
import { LINEN_THREADS, linenMaps, plasterMap, softRectMap, stitchShadowMap, textMap, threadMaps, woodMap } from "/fabric.js";
import { buildYarn, yarnPath, yarnShadowMaterial } from "/yarn.js";

const canvas = document.querySelector("#cloth");
const panel = document.querySelector("#panel");
const empty = document.querySelector("#empty");
const tip = document.querySelector("#tip");
const params = new URLSearchParams(location.search);
const STILL = params.has("still") || matchMedia("(prefers-reduced-motion: reduce)").matches;
const FREEZE = params.has("at") ? Math.max(0, Math.min(1, Number(params.get("at")))) : null;

// Madder, indigo, weld, woad green, cochineal, onion skin, walnut, verdigris.
const DYES = ["#b23a2a", "#2c5a8f", "#c9992a", "#487a45", "#b4577c", "#c86a2b", "#75502f", "#2f8580"];
const FIXED = { gold: "#d0a13a", rust: "#9c4a27", violet: "#7c52a6", cream: "#efe2c6", ink: "#3a2a1c" };
const LINEN_THREAD = "#cdb98f";
// Light rakes in from the upper left; a shadow falls this far per unit height.
const SHADOW = { x: 0.5, y: -0.62 };
const MARGIN = { left: 30, right: 14, bottom: 24, top: 16 };

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: params.has("still") });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
const scene = new THREE.Scene();
scene.background = new THREE.Color("#14100d");
const camera = new THREE.PerspectiveCamera(26, 1, 1, 10000);
const TAN = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

const sun = new THREE.DirectionalLight("#fff0d8", 2.9);
sun.position.set(-0.52, 0.66, 0.78);
scene.add(sun, new THREE.HemisphereLight("#fff3e0", "#4a3626", 0.85));
const fill = new THREE.DirectionalLight("#cfd8ff", 0.35);
fill.position.set(0.7, -0.2, 0.6);
scene.add(fill);

const clock = { value: 1e6 }; // sewing time, in seconds; shared by every sewn material
const maps = { linen: linenMaps(), thread: threadMaps(), wood: woodMap(), plaster: plasterMap(), blob: stitchShadowMap(), rect: softRectMap(0.2), halo: softRectMap(0.45) };

const state = {
  spec: null, weave: null, signature: "", world: null, size: { w: 0, h: 0 },
  cam: { x: 0, y: 0, d: 400 }, fit: 400, tilt: { x: 0, y: 0, tx: 0, ty: 0 },
  drag: null, selected: null, hover: null, yarns: [], timed: [], touched: false, sewnUntil: 0, sewing: null, last: null, pin: null, follow: null, dirty: true,
};

// ---------------------------------------------------------------- materials

// A stitch is drawn out of the cloth along its own length; a knot swells.
function sewn(material, mode) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uClock = clock;
    shader.vertexShader = "attribute float aBirth;\nuniform float uClock;\n" + shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\n  float sewnK = clamp((uClock - aBirth) * 7.0, 0.0, 1.0);\n" + (mode === "pull"
        ? "  transformed.x *= sewnK; transformed.yz *= step(0.001, sewnK);"
        : "  transformed *= sewnK;"),
    );
  };
  material.customProgramCacheKey = () => "sewn-" + mode;
  return material;
}

const threadMaterial = sewn(new THREE.MeshPhysicalMaterial({
  map: maps.thread.map, bumpMap: maps.thread.bumpMap, bumpScale: 0.9,
  roughness: 0.72, sheen: 1, sheenRoughness: 0.45, sheenColor: new THREE.Color("#5a5148"),
}), "pull");
const knotMaterial = sewn(new THREE.MeshPhysicalMaterial({
  map: maps.thread.map, bumpMap: maps.thread.bumpMap, bumpScale: 1.2,
  roughness: 0.75, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color("#5a5148"),
}), "swell");
const blobMaterial = sewn(new THREE.MeshBasicMaterial({
  map: maps.blob, color: "#231206", transparent: true, opacity: 0.5, depthWrite: false,
}), "pull");
const yarnMaterial = new THREE.MeshPhysicalMaterial({
  vertexColors: true, map: maps.thread.map, bumpMap: maps.thread.bumpMap, bumpScale: 1.4,
  roughness: 0.82, sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color("#6b6156"),
});
const yarnShadow = yarnShadowMaterial();
const woodMaterial = new THREE.MeshStandardMaterial({ map: maps.wood, roughness: 0.5, color: "#c8a37a" });

function stitchGeometry() {
  const along = 6;
  const around = 4;
  const position = [];
  const normal = [];
  const uv = [];
  const index = [];
  for (let i = 0; i <= along; i++) {
    const u = i / along;
    const swell = Math.pow(Math.sin(Math.PI * u), 0.45);
    const r = 0.55 + 0.45 * swell;
    for (let k = 0; k <= around; k++) {
      const a = (k / around) * Math.PI;
      const cy = Math.cos(a);
      const sz = Math.sin(a);
      position.push(u, cy * r, sz * r * (0.22 + 0.78 * swell));
      const tilt = -Math.cos(Math.PI * u) * 0.7 * sz;
      const inv = 1 / Math.hypot(tilt, cy, sz);
      normal.push(tilt * inv, cy * inv, sz * inv);
      uv.push(u, k / around);
    }
  }
  for (let i = 0; i < along; i++) {
    for (let k = 0; k < around; k++) {
      const a = i * (around + 1) + k;
      const b = a + around + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  return geometry;
}

const STITCH = stitchGeometry();
const BLOB = new THREE.PlaneGeometry(1.36, 1).translate(0.5, 0, 0);
const KNOT = new THREE.TorusKnotGeometry(0.62, 0.3, 40, 6, 2, 3);
const UNIT = new THREE.PlaneGeometry(1, 1);

function toneSet(dye) {
  const base = new THREE.Color(dye);
  const set = [];
  set[TONE.dye] = base;
  // The second shade stays darker than the linen, or it would vanish into it.
  const hsl = base.getHSL({}, THREE.SRGBColorSpace);
  set[TONE.light] = new THREE.Color().setHSL((hsl.h + 0.03) % 1, hsl.s * 0.8, Math.min(0.56, hsl.l + 0.17), THREE.SRGBColorSpace);
  set[TONE.dark] = base.clone().multiplyScalar(0.6);
  set[TONE.gold] = new THREE.Color(FIXED.gold);
  set[TONE.rust] = new THREE.Color(FIXED.rust);
  set[TONE.violet] = new THREE.Color(FIXED.violet);
  set[TONE.cream] = new THREE.Color(FIXED.cream);
  set[TONE.ink] = new THREE.Color(FIXED.ink);
  return set;
}

// ---------------------------------------------------------------- the weave

function dispose(group) {
  group.traverse((node) => {
    if (node.geometry && ![STITCH, BLOB, KNOT, UNIT].includes(node.geometry)) node.geometry.dispose();
    if (node.userData.ownMaterial) {
      node.material.map?.dispose();
      node.material.dispose();
    }
  });
  scene.remove(group);
}

// Collects every stitch, then hands them to the GPU as three instanced draws.
function threadBag() {
  const stitches = [];
  const knots = [];
  return {
    stitch(x0, y0, x1, y1, color, birth, { radius = 0.2, loose = false, z = 0, shadow = true, jitter = 0.5 } = {}) {
      stitches.push({ x0, y0, x1, y1, color, birth, radius, loose, z, shadow, jitter });
    },
    knot(x, y, color, birth, size) {
      knots.push({ x, y, color, birth, size });
    },
    get count() {
      return stitches.length;
    },
    build(group) {
      const rand = rng(77);
      const n = stitches.length;
      const threads = new THREE.InstancedMesh(STITCH, threadMaterial, n);
      const shadows = new THREE.InstancedMesh(BLOB, blobMaterial, n);
      const birth = new Float32Array(n);
      const colors = new Float32Array(n * 3);
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const lift = new THREE.Quaternion();
      const axisZ = new THREE.Vector3(0, 0, 1);
      const axisY = new THREE.Vector3(0, 1, 0);
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const tint = new THREE.Color();
      let shadowCount = 0;
      const shadowBirth = new Float32Array(n);
      stitches.forEach((s, i) => {
        const dx = s.x1 - s.x0;
        const dy = s.y1 - s.y0;
        const length = Math.hypot(dx, dy);
        quaternion.setFromAxisAngle(axisZ, Math.atan2(dy, dx));
        if (s.loose) quaternion.multiply(lift.setFromAxisAngle(axisY, -0.42 - rand() * 0.3));
        position.set(s.x0, s.y0, 0.03 + s.z);
        scale.set(length, s.radius, s.radius * 0.85);
        threads.setMatrixAt(i, matrix.compose(position, quaternion, scale));
        tint.copy(s.color).multiplyScalar(1 - s.jitter * 0.12 + rand() * s.jitter * 0.24);
        colors[i * 3] = tint.r;
        colors[i * 3 + 1] = tint.g;
        colors[i * 3 + 2] = tint.b;
        birth[i] = s.birth;
        if (s.shadow) {
          const reach = s.loose ? 2.4 : 1;
          quaternion.setFromAxisAngle(axisZ, Math.atan2(dy, dx));
          position.set(s.x0 + SHADOW.x * 0.36 * reach, s.y0 + SHADOW.y * 0.36 * reach, 0.012);
          scale.set(length, s.radius * (s.loose ? 5.5 : 4.4), 1);
          shadows.setMatrixAt(shadowCount, matrix.compose(position, quaternion, scale));
          shadowBirth[shadowCount++] = s.birth;
        }
      });
      threads.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
      threads.geometry = STITCH.clone();
      threads.geometry.setAttribute("aBirth", new THREE.InstancedBufferAttribute(birth, 1));
      shadows.count = shadowCount;
      shadows.geometry = BLOB.clone();
      shadows.geometry.setAttribute("aBirth", new THREE.InstancedBufferAttribute(shadowBirth, 1));
      threads.frustumCulled = shadows.frustumCulled = false;
      group.add(shadows, threads);

      const k = knots.length;
      if (k) {
        const mesh = new THREE.InstancedMesh(KNOT, knotMaterial, k);
        const kBirth = new Float32Array(k);
        const kColors = new Float32Array(k * 3);
        const kShadow = new THREE.InstancedMesh(BLOB, blobMaterial, k);
        knots.forEach((knot, i) => {
          quaternion.setFromAxisAngle(axisZ, rand() * Math.PI * 2);
          position.set(knot.x, knot.y, 0.05 + knot.size * 0.22);
          scale.set(knot.size, knot.size, knot.size * 0.72);
          mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
          tint.copy(knot.color).multiplyScalar(0.94 + rand() * 0.12);
          kColors[i * 3] = tint.r;
          kColors[i * 3 + 1] = tint.g;
          kColors[i * 3 + 2] = tint.b;
          kBirth[i] = knot.birth;
          quaternion.identity();
          position.set(knot.x - knot.size * 1.1 + SHADOW.x * knot.size * 0.7, knot.y + SHADOW.y * knot.size * 0.7, 0.013);
          scale.set(knot.size * 2.2, knot.size * 2.6, 1);
          kShadow.setMatrixAt(i, matrix.compose(position, quaternion, scale));
        });
        mesh.instanceColor = new THREE.InstancedBufferAttribute(kColors, 3);
        mesh.geometry = KNOT.clone();
        mesh.geometry.setAttribute("aBirth", new THREE.InstancedBufferAttribute(kBirth, 1));
        kShadow.geometry = BLOB.clone();
        kShadow.geometry.setAttribute("aBirth", new THREE.InstancedBufferAttribute(kBirth, 1));
        mesh.frustumCulled = kShadow.frustumCulled = false;
        group.add(kShadow, mesh);
      }
    },
  };
}

function plane(map, width, height, x, y, z, options = {}) {
  const material = options.basic
    ? new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, color: options.color ?? "#ffffff", opacity: options.opacity ?? 1 })
    : new THREE.MeshStandardMaterial({ map, transparent: !!options.transparent, depthWrite: !options.transparent, roughness: 0.95, color: options.color ?? "#ffffff" });
  const mesh = new THREE.Mesh(UNIT, material);
  mesh.scale.set(width, height, 1);
  mesh.position.set(x, y, z);
  mesh.userData.ownMaterial = !!options.ownMap;
  return mesh;
}

// Lettering inked onto the linen. `align` is -1 left, 0 centre, 1 right.
function ink(group, text, x, y, height, align = 0, options = {}) {
  const { map, aspect } = textMap(text, options);
  const width = height * aspect;
  const mesh = plane(map, width, height, x - (align * width) / 2, y, options.tag ? 0.09 : 0.02, { transparent: !options.tag, ownMap: true });
  group.add(mesh);
  return { mesh, width };
}

function smoothNoise(seed) {
  const rand = rng(seed);
  const size = 64;
  const grid = Array.from({ length: size * size }, () => rand());
  const at = (x, y) => grid[((y % size) + size) % size * size + ((x % size) + size) % size];
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    return (at(xi, yi) * (1 - sx) + at(xi + 1, yi) * sx) * (1 - sy) + (at(xi, yi + 1) * (1 - sx) + at(xi + 1, yi + 1) * sx) * sy;
  };
}

function ribbon(points, width, material) {
  const position = [];
  const uv = [];
  const index = [];
  let s = 0;
  points.forEach((p, i) => {
    if (i) s += Math.hypot(p.y - points[i - 1].y, p.z - points[i - 1].z);
    position.push(-width / 2, p.y, p.z, width / 2, p.y, p.z);
    uv.push(0, s / (LINEN_THREADS / 2), width / (LINEN_THREADS / 2), s / (LINEN_THREADS / 2));
    if (i) index.push(i * 2 - 2, i * 2 - 1, i * 2, i * 2 - 1, i * 2 + 1, i * 2);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

// The ground: linen, its hems and selvedges, the rod it hangs from, a fringe.
function hangCloth(group, bag, W, H) {
  const tile = LINEN_THREADS / 2;
  const linen = new THREE.MeshStandardMaterial({ map: maps.linen.map.clone(), normalMap: maps.linen.normalMap.clone(), normalScale: new THREE.Vector2(1.1, 1.1), roughness: 0.96, vertexColors: true });
  linen.map.repeat.set(W / tile, H / tile);
  linen.normalMap.repeat.set(W / tile, H / tile);
  const sx = Math.min(180, Math.max(8, Math.ceil(W / 3)));
  const sy = Math.min(360, Math.max(8, Math.ceil(H / 3)));
  const geometry = new THREE.PlaneGeometry(W, H, sx, sy).translate(W / 2, H / 2, 0);
  const noise = smoothNoise(31);
  const colors = [];
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    // Uneven dye lots, a faint memory of folds, and wear toward the edges.
    const mottle = noise(x / 34, y / 34) * 0.6 + noise(x / 9, y / 9) * 0.4;
    const fold = Math.sin((x / W) * Math.PI * 5 + noise(0.5, y / 80) * 2) * 0.018;
    const edge = Math.min(x, W - x, y, H - y);
    const wear = 1 - 0.07 * Math.exp(-edge / 5);
    const c = (0.9 + mottle * 0.13 + fold) * wear;
    colors.push(c, c * (0.992 + noise(x / 60 + 9, y / 60) * 0.012), c * (0.97 + noise(x / 50, y / 50 + 7) * 0.04));
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const cloth = new THREE.Mesh(geometry, linen);
  cloth.userData.ownMaterial = true;
  group.add(cloth);

  // Turned hems at head and foot: a doubled strip, held by running stitch.
  const hemMaterial = new THREE.MeshStandardMaterial({ map: maps.linen.map.clone(), normalMap: maps.linen.normalMap.clone(), roughness: 0.96, color: "#efe9dc" });
  hemMaterial.map.repeat.set(W / tile, 5 / tile);
  hemMaterial.normalMap.repeat.set(W / tile, 5 / tile);
  const thread = new THREE.Color(LINEN_THREAD);
  for (const y of [2.5, H - 2.5]) {
    const hem = new THREE.Mesh(new THREE.PlaneGeometry(W, 5).translate(W / 2, y, 0.05), hemMaterial);
    group.add(hem);
    group.add(plane(maps.rect, W + 2, 2.2, W / 2 + 0.4, y + (y < H / 2 ? 2.5 : -2.9), 0.008, { basic: true, color: "#2a1608", opacity: 0.2 }));
    const seam = y < H / 2 ? y + 1.7 : y - 1.7;
    for (let x = 1.5; x < W - 2; x += 1.9) bag.stitch(x, seam, x + 1.25, seam, thread, -1e3, { radius: 0.15, z: 0.05, shadow: false });
  }
  // Selvedges, whipped.
  for (let y = 0.6; y < H - 1; y += 1.15) {
    bag.stitch(0.05, y, 0.95, y + 0.55, thread, -1e3, { radius: 0.16, shadow: false });
    bag.stitch(W - 0.05, y, W - 0.95, y + 0.55, thread, -1e3, { radius: 0.16, shadow: false });
  }
  // Knotted fringe: the warp ends, gathered and tied.
  const rand = rng(404);
  const pale = new THREE.Color("#d9c8a2");
  for (let x = 2; x < W - 1.5; x += 3.1) {
    const knotY = -1.7 - rand() * 0.5;
    for (let i = 0; i < 5; i++) bag.stitch(x - 1.3 + i * 0.65, 0.4, x + (rand() - 0.5) * 0.3, knotY, pale, -1e3, { radius: 0.13, shadow: false, z: -0.02 });
    bag.knot(x, knotY, pale, -1e3, 0.55);
    for (let i = 0; i < 7; i++) {
      const lean = (i - 3) * 0.24 + (rand() - 0.5) * 0.5;
      bag.stitch(x + (rand() - 0.5) * 0.2, knotY, x + lean, knotY - 6.5 - rand() * 3.2, pale, -1e3, { radius: 0.12, shadow: false, z: -0.02 });
    }
  }

  // The rod and the tabs that carry the cloth over it.
  const rodY = H + 6.2;
  const rodZ = -1.5;
  const rodR = 1.55;
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(rodR, rodR, W + 26, 24, 1).rotateZ(Math.PI / 2), woodMaterial);
  rod.position.set(W / 2, rodY, rodZ);
  group.add(rod);
  for (const side of [-1, 1]) {
    const finial = new THREE.Mesh(new THREE.SphereGeometry(rodR * 1.55, 24, 16), woodMaterial);
    finial.position.set(W / 2 + side * (W / 2 + 13.6), rodY, rodZ);
    group.add(finial);
  }
  const tabMaterial = new THREE.MeshStandardMaterial({ map: maps.linen.map, normalMap: maps.linen.normalMap, roughness: 0.96, color: "#ebe4d6", side: THREE.DoubleSide });
  const tabs = Math.max(3, Math.round(W / 26));
  const path = [{ y: H - 4, z: 0.07 }, { y: H + 2.2, z: 0.12 }];
  for (let a = -0.5; a <= 2.3; a += 0.2) path.push({ y: rodY + Math.sin(a) * (rodR + 0.16), z: rodZ + Math.cos(a) * (rodR + 0.16) });
  for (let i = 0; i < tabs; i++) {
    const x = 7 + ((W - 14) * i) / (tabs - 1);
    const tab = ribbon(path, 7.5, tabMaterial);
    tab.position.x = x;
    group.add(tab);
    for (const dx of [-2.6, -0.9, 0.9, 2.6]) {
      bag.stitch(x + dx - 0.5, H - 3.4, x + dx + 0.5, H - 2.4, thread, -1e3, { radius: 0.17, z: 0.08, shadow: false });
      bag.stitch(x + dx + 0.5, H - 3.4, x + dx - 0.5, H - 2.4, thread, -1e3, { radius: 0.17, z: 0.1, shadow: false });
    }
  }

  // The wall, and the cloth's shadow on it.
  const wallMap = maps.plaster.clone();
  wallMap.repeat.set(60, 60);
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(9000, 9000), new THREE.MeshStandardMaterial({ map: wallMap, color: "#4a3b30", roughness: 1 }));
  wall.position.set(W / 2, H / 2, -9);
  wall.userData.ownMaterial = true;
  group.add(wall);
  const spread = 9 + Math.min(W, H) * 0.05;
  group.add(plane(maps.halo, W + spread * 5, H + spread * 5, W / 2 + spread * 0.7, H / 2 - spread * 0.9, -8.9, { basic: true, color: "#000000", opacity: 0.62 }));
}

function stitchBand(bag, band, ox, oy, tones, birthAt) {
  // Sample the activity envelope into a smooth edge, then backstitch it.
  const env = band.envelope;
  if (env.length < 2) return;
  const half = (y) => {
    let i = 1;
    while (i < env.length - 1 && env[i].y < y) i++;
    const a = env[i - 1];
    const b = env[i];
    const t = Math.max(0, Math.min(1, (y - a.y) / Math.max(1e-6, b.y - a.y)));
    return a.half + (b.half - a.half) * (t * t * (3 - 2 * t));
  };
  const y0 = env[0].y;
  const y1 = env.at(-1).y;
  const steps = Math.max(1, Math.round((y1 - y0) / 1.5));
  for (const side of [-1, 1]) {
    let px = band.x + side * half(y0);
    let py = y0;
    for (let i = 1; i <= steps; i++) {
      const y = y0 + ((y1 - y0) * i) / steps;
      const x = band.x + side * half(y);
      const gx = (x - px) * 0.08;
      const gy = (y - py) * 0.08;
      bag.stitch(ox + px + gx, oy + py + gy, ox + x - gx, oy + y - gy, tones[TONE.dark], birthAt(py), { radius: 0.17 });
      px = x;
      py = y;
    }
  }
  for (const [y, at] of [[y0, env[0].half], [y1, env.at(-1).half]]) {
    const n = Math.max(1, Math.round((at * 2) / 1.5));
    for (let i = 0; i < n; i++) {
      const a = band.x - at + ((at * 2) * i) / n;
      const b = band.x - at + ((at * 2) * (i + 1)) / n;
      bag.stitch(ox + a + 0.1, oy + y, ox + b - 0.1, oy + y, tones[TONE.dark], birthAt(y), { radius: 0.17 });
    }
  }
}

function anchor(action, toward) {
  const dx = toward.x - action.x;
  const dy = toward.y - action.y;
  const length = Math.hypot(dx, dy) || 1;
  if (action.family === "handoff") return { x: action.x, y: action.y + 0.5 };
  const hx = action.width / 2 - 0.6;
  const hy = action.height / 2 - 0.6;
  const k = Math.min(hx / Math.abs(dx / length || 1e-6), hy / Math.abs(dy / length || 1e-6));
  return { x: action.x + (dx / length) * k, y: action.y + (dy / length) * k };
}

function build(spec, known) {
  if (state.world) dispose(state.world);
  const weave = layoutWeave(spec);
  const group = new THREE.Group();
  const multiDay = weave.span && weave.span.t1 - weave.span.t0 > 20 * 3600_000;
  const left = MARGIN.left + (multiDay ? 12 : 0);
  const W = Math.max(96, weave.width + left + MARGIN.right);
  const H = Math.max(110, weave.height + MARGIN.bottom + MARGIN.top);
  const ox = left + Math.max(0, (W - left - MARGIN.right - weave.width) / 2);
  const oy = MARGIN.bottom;
  const bag = threadBag();
  state.timed = [];
  hangCloth(group, bag, W, H);

  const actors = [...new Set(weave.actions.map((action) => action.actor))].sort();
  const dyes = new Map(actors.map((actor, i) => [actor, toneSet(DYES[i % DYES.length])]));
  const inkTones = toneSet(FIXED.ink);

  // Sewing order is log order. Anything already on the cloth stays put; only
  // new work is drawn through.
  const fresh = weave.actions.filter((action) => !known || !known.has(action.id));
  const motifs = new Map(weave.actions.map((action) => [action, motifFor(action, action.border ? action.width - 1 : 9)]));
  const work = fresh.reduce((sum, action) => sum + motifs.get(action).stitches.length + 8, 0);
  const begin = known ? clock.value + 0.2 : 0.7;
  const duration = STILL ? 0 : known ? Math.min(4, 0.4 + fresh.length * 0.25) : Math.max(4, Math.min(11, 2.5 + fresh.length * 0.045));
  let done = 0;
  for (const action of weave.actions) {
    if (known?.has(action.id) || STILL) {
      action.birth = -1e3;
      action.sewn = -1e3;
      continue;
    }
    const share = motifs.get(action).stitches.length + 8;
    action.birth = begin + (done / work) * duration;
    done += share;
    action.sewn = begin + (done / work) * duration;
  }
  // A band's edge is worked up to each design just as that design begins.
  const railClock = (band) => {
    const marks = [...band.actions].sort((a, b) => a.y - b.y);
    return (y) => (marks.find((action) => action.y + action.height / 2 >= y) ?? marks.at(-1)).birth;
  };

  for (const band of weave.bands) {
    const tones = dyes.get(band.actor);
    const first = Math.min(...band.actions.map((action) => action.birth));
    stitchBand(bag, band, ox, oy, tones, railClock(band));
    const label = String(band.sessionId).length > 22 ? String(band.sessionId).slice(0, 21) + "…" : String(band.sessionId);
    const tagHeight = 3.6;
    const { mesh, width } = ink(group, label, ox + band.x, oy + band.y0 - 3.1, tagHeight, 0, { tag: true });
    const limit = band.width + 6;
    if (width > limit) mesh.scale.set(limit, (tagHeight * limit) / width, 1);
    const tw = Math.min(width, limit);
    const th = mesh.scale.y;
    const shade = plane(maps.rect, tw + 2.2, th + 2.2, mesh.position.x + 0.5, mesh.position.y - 0.62, 0.02, { basic: true, color: "#1e1006", opacity: 0.5 });
    group.add(shade);
    // The tag is sewn on when the session's first stitch goes in.
    state.timed.push({ born: first - 0.25, nodes: [mesh, shade] });
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = mesh.position.x + sx * (tw / 2 - 0.25);
      const cy = mesh.position.y + sy * (th / 2 - 0.25);
      bag.stitch(cx - 0.45, cy - 0.45, cx + 0.45, cy + 0.45, tones[TONE.dye], first - 0.2, { radius: 0.15, z: 0.1, shadow: false });
      bag.stitch(cx + 0.45, cy - 0.45, cx - 0.45, cy + 0.45, tones[TONE.dye], first - 0.1, { radius: 0.15, z: 0.12, shadow: false });
    }
    band.tag = { x: mesh.position.x, y: mesh.position.y, w: tw, h: th };
  }

  for (const action of weave.actions) {
    const tones = dyes.get(action.actor);
    const motif = motifs.get(action);
    const cx = ox + action.x;
    const cy = oy + action.y + (action.border ? 0 : 0.5);
    const n = motif.stitches.length;
    const per = n ? (action.sewn - action.birth) / n : 0;
    motif.stitches.forEach((s, i) => {
      bag.stitch(cx + s[0], cy + s[1], cx + s[2], cy + s[3], tones[s[4]], action.birth + per * i, {
        radius: s[5] & FINE ? 0.13 : 0.215,
        loose: !!(s[5] & LOOSE),
        z: Math.min(0.12, i * 0.0012),
      });
    });
    for (const k of motif.knots) bag.knot(cx + k[0], cy + k[1], tones[k[2]], action.sewn, k[3]);
    action.wx = cx;
    action.wy = cy;
    action.dye = tones[TONE.dye];
  }

  // The time ruler, stamped and tacked down the left margin.
  const tickX = left - 7;
  for (const mark of weave.ruler) {
    const y = oy + mark.y + 0.4;
    bag.stitch(tickX, y, tickX + 2.4, y, inkTones[TONE.dye], -1e3, { radius: 0.15, jitter: 0.2 });
    const when = new Date(mark.t);
    const label = multiDay
      ? when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
      : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    ink(group, label, tickX - 1.4, y, 2.5, 1, { weight: 500 });
  }
  for (const gap of weave.breaks) {
    const y = oy + gap.y;
    for (let i = 0; i < 3; i++) {
      bag.stitch(tickX + 0.2 + i * 0.7, y + (i % 2 ? 0.45 : -0.45), tickX + 0.9 + i * 0.7, y + (i % 2 ? -0.45 : 0.45), inkTones[TONE.dye], -1e3, { radius: 0.13, jitter: 0.2 });
    }
  }

  // The dye key, worked along the foot.
  let keyX = W - 8;
  for (const actor of [...actors].reverse()) {
    const { width } = ink(group, actor, keyX, 12.2, 3, 1, { weight: 600 });
    keyX -= width + 1.2;
    const tones = dyes.get(actor);
    for (let i = 0; i < 9; i++) {
      bag.stitch(keyX - 4.2 + i * 0.5, 10.8, keyX - 4.1 + i * 0.5, 13.6, tones[i % 4 === 1 ? TONE.light : TONE.dye], -1e3, { radius: 0.22 });
    }
    keyX -= 8.5;
  }

  bag.build(group);

  // Yarn.
  state.yarns = [];
  const violet = new THREE.Color(FIXED.violet);
  const cream = new THREE.Color(FIXED.cream);
  for (const link of weave.links) {
    const from = { x: link.from.wx, y: link.from.wy };
    const to = { x: link.to.wx, y: link.to.wy };
    const a = anchor({ ...link.from, x: from.x, y: from.y }, to);
    const b = anchor({ ...link.to, x: to.x, y: to.y }, from);
    const source = dyes.get(link.from.actor);
    const target = dyes.get(link.to.actor);
    const colors = link.kind === "handoff" ? [violet, violet.clone().lerp(cream, 0.45), source[TONE.dye]]
      : link.kind === "resume" ? [source[TONE.dye], source[TONE.light], source[TONE.dark]]
      : link.kind === "correlation" ? [new THREE.Color(FIXED.gold), cream, target[TONE.dye]]
      : [source[TONE.dye], target[TONE.dye], cream];
    const seed = hashSeed(link.from.id + ">" + link.to.id);
    const radius = link.kind === "handoff" ? 0.62 : 0.5;
    const yarn = buildYarn(yarnPath(a, b, seed), { radius, colors, seed, shadow: SHADOW });
    const mesh = new THREE.Mesh(yarn.geometry, yarnMaterial);
    const shade = new THREE.Mesh(yarn.shadowGeometry, yarnShadow);
    mesh.frustumCulled = shade.frustumCulled = false;
    const knots = [a, b].map((end) => {
      const knot = new THREE.Mesh(KNOT, new THREE.MeshPhysicalMaterial({ color: colors[0], map: maps.thread.map, bumpMap: maps.thread.bumpMap, bumpScale: 1.2, roughness: 0.8, sheen: 1, sheenColor: new THREE.Color("#5a5148") }));
      knot.position.set(end.x, end.y, 0.35);
      knot.scale.setScalar(radius * 1.9);
      knot.rotation.z = (seed % 628) / 100;
      knot.userData.ownMaterial = true;
      group.add(knot);
      return knot;
    });
    group.add(shade, mesh);
    const born = Math.max(link.from.sewn, link.to.birth);
    state.yarns.push({ ...yarn, mesh, shade, knots, born, link, span: Math.max(0.5, Math.min(1.6, yarn.length / 60)) });
  }

  scene.add(group);
  state.world = group;
  state.weave = weave;
  state.size = { w: W, h: H, ox, oy };
  state.sewnUntil = STILL ? 0 : begin + duration + 2.2;
  state.sewing = STILL || !fresh.length ? null : { actions: fresh, i: 0, begin, end: begin + duration };
  if (!known) {
    clock.value = STILL ? 1e6 : 0;
    if (FREEZE !== null) clock.value = begin + duration * FREEZE;
  }
  updateYarns();
  moveNeedle();
  state.dirty = true;
}

function updateYarns() {
  for (const item of state.timed) for (const node of item.nodes) node.visible = clock.value >= item.born;
  for (const yarn of state.yarns) {
    const k = Math.max(0, Math.min(1, (clock.value - yarn.born) / yarn.span));
    const reach = Math.floor(yarn.samples * k);
    yarn.mesh.geometry.setDrawRange(0, reach * yarn.perSample);
    yarn.shade.geometry.setDrawRange(0, reach * 6);
    yarn.knots[0].visible = k > 0;
    yarn.knots[1].visible = k >= 1;
  }
}

// The hoop marks whatever is under inspection.
const hoop = new THREE.Group();
{
  const outer = new THREE.Mesh(new THREE.TorusGeometry(8.4, 0.5, 14, 96), woodMaterial);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(7.75, 0.36, 12, 96), new THREE.MeshStandardMaterial({ map: maps.wood, color: "#e2c49a", roughness: 0.55 }));
  outer.position.z = 0.55;
  inner.position.z = 0.4;
  const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 2, 12), new THREE.MeshStandardMaterial({ color: "#b99a54", metalness: 0.8, roughness: 0.35 }));
  screw.rotation.z = Math.PI / 2;
  screw.position.set(0, 9.2, 0.6);
  const shade = new THREE.Mesh(new THREE.RingGeometry(7.3, 9.6, 96), new THREE.MeshBasicMaterial({ color: "#1e1006", transparent: true, opacity: 0.3, depthWrite: false }));
  shade.position.set(SHADOW.x * 0.9, SHADOW.y * 0.9, 0.018);
  hoop.add(shade, inner, outer, screw);
  hoop.visible = false;
  scene.add(hoop);
}

// The needle rides the newest stitch while the cloth is being worked.
const needle = new THREE.Group();
const needleThread = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1, 6).rotateX(Math.PI / 2).translate(0, 0, 0.5), new THREE.MeshStandardMaterial({ roughness: 0.8 }));
{
  const steel = new THREE.MeshStandardMaterial({ color: "#e9e6de", metalness: 0.55, roughness: 0.28, emissive: "#3a3833" });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.03, 9, 10).translate(0, 4.5, 0), steel);
  const eye = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.1, 8, 16).translate(0, 9.2, 0), steel);
  needle.add(shaft, eye);
  needle.rotation.set(0.95, 0, -0.5); // leaning out of the cloth, toward the light
  needle.visible = needleThread.visible = false;
  scene.add(needle, needleThread);
}
const needleAt = new THREE.Vector3();
const needleEye = new THREE.Vector3();

function moveNeedle() {
  const sewing = state.sewing;
  if (!sewing || clock.value > sewing.end + 0.25 || clock.value < sewing.begin) {
    needle.visible = needleThread.visible = false;
    return;
  }
  while (sewing.i + 1 < sewing.actions.length && sewing.actions[sewing.i + 1].birth <= clock.value) sewing.i++;
  const action = sewing.actions[sewing.i];
  const reach = Math.min(4, action.width / 2 - 1);
  const dip = Math.abs(Math.sin(clock.value * 21));
  needleAt.set(action.wx + Math.sin(clock.value * 13) * reach, action.wy + Math.cos(clock.value * 17) * 3, 0.2 + dip * 2.4);
  if (!needle.visible) needle.position.copy(needleAt);
  needle.position.lerp(needleAt, 0.3);
  needle.visible = needleThread.visible = true;
  // The working thread runs from the eye back to where it last went in.
  needleEye.set(0, 9.2, 0).applyEuler(needle.rotation).add(needle.position);
  needleThread.position.set(action.wx, action.wy, 0.15);
  needleThread.lookAt(needleEye);
  needleThread.scale.set(1, 1, needleEye.distanceTo(needleThread.position));
  needleThread.material.color.copy(action.dye);
}

// ---------------------------------------------------------------- the view

function viewport() {
  // The header covers the top of the page; keep the cloth clear of it.
  return { top: 92, bottom: 26, side: 40 };
}

function fitDistance() {
  const { w, h } = state.size;
  const v = viewport();
  const availH = Math.max(120, innerHeight - v.top - v.bottom);
  const availW = Math.max(120, innerWidth - v.side * 2);
  const tall = h + 30; // rod above, fringe below
  const wide = w + 34;
  const pxPerUnit = Math.min(availH / tall, availW / wide);
  return { all: innerHeight / (2 * TAN * pxPerUnit), width: innerHeight / (2 * TAN * (availW / wide)) };
}

function frame(follow) {
  const { w, h } = state.size;
  const fit = fitDistance();
  state.fit = fit.all;
  const v = viewport();
  const legible = innerHeight / (2 * TAN * 2.3); // 2.3 px per cell: motifs still read
  // Show the whole cloth unless that would shrink the designs to smudges.
  const whole = params.get("fit") === "all" || innerHeight / (2 * TAN * fit.all) >= 1.5;
  const d = whole ? fit.all : Math.min(fit.all, Math.max(fit.width, legible));
  const shift = ((v.top - v.bottom) / 2) * ((2 * TAN * d) / innerHeight);
  state.cam.d = d;
  state.cam.x = w / 2;
  state.cam.y = h / 2 - 1 + shift;
  state.follow = d < fit.all - 1 && follow ? { shift } : null;
  if (d < fit.all - 1) state.cam.y = follow ? viewHeight() / 2 - 14 + shift : h + 14 - viewHeight() / 2 + shift;
  if (params.has("zoom")) {
    // ?zoom=x,y,d frames a detail, in cloth units.
    const [x, y, dist] = params.get("zoom").split(",").map(Number);
    Object.assign(state.cam, { x, y, d: dist });
    state.follow = null;
  }
  state.dirty = true;
}

const viewHeight = () => 2 * TAN * state.cam.d;

function clampCamera() {
  const { w, h } = state.size;
  state.cam.d = Math.max(16, Math.min(state.fit * 1.5, state.cam.d));
  state.cam.x = Math.max(-20, Math.min(w + 20, state.cam.x));
  state.cam.y = Math.max(-20, Math.min(h + 30, state.cam.y));
}

function placeCamera() {
  const { x, y, d } = state.cam;
  // A little parallax: the yarn stands off the cloth, so let it show.
  camera.position.set(x + state.tilt.x * d * 0.055, y + state.tilt.y * d * 0.04, d);
  camera.up.set(0, 1, 0);
  camera.lookAt(x, y, 0);
  camera.near = Math.max(0.5, d * 0.05);
  camera.far = d * 4 + 200;
  camera.updateProjectionMatrix();
}

function resize() {
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  state.dirty = true;
}

const ray = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
function clothPoint(clientX, clientY) {
  placeCamera();
  camera.updateMatrixWorld();
  ray.setFromCamera(new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1), camera);
  return ray.ray.intersectPlane(ground, new THREE.Vector3());
}

function pick(clientX, clientY) {
  const p = clothPoint(clientX, clientY);
  if (!p || !state.weave) return null;
  for (const action of state.weave.actions) {
    if (action.birth > clock.value) continue;
    if (Math.abs(p.x - action.wx) <= action.width / 2 && Math.abs(p.y - action.wy) <= action.height / 2) return { action };
  }
  for (const band of state.weave.bands) {
    const t = band.tag;
    if (t && Math.abs(p.x - t.x) <= t.w / 2 + 0.5 && Math.abs(p.y - t.y) <= t.h / 2 + 0.5) return { band };
    const bx = state.size.ox + band.x;
    if (Math.abs(p.x - bx) <= band.width / 2 + 1 && p.y >= state.size.oy + band.y0 && p.y <= state.size.oy + band.y1) return { band };
  }
  return null;
}

// ---------------------------------------------------------------- inspector

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

const STITCH_NAMES = {
  tool: "counted cross stitch", approval: "Algerian eye", model: "French knots", file: "satin stitch",
  git: "feather stitch", handoff: "buttonholed eyelet", resume: "darning", note: "counted cross stitch",
  other: "counted cross stitch", started: "cast-on hem", completed: "bound-off seam", failed: "frayed edge",
};

function span(ms) {
  if (!(ms > 0)) return null;
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60_000) return (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) + " s";
  if (ms < 3600_000) return Math.round(ms / 60_000) + " min";
  return (ms / 3600_000).toFixed(1) + " h";
}

function describeAction(action) {
  const kind = action.border ?? (action.type === "agent.session.resumed" ? "resume" : action.family);
  const title = action.tool ?? action.type.replace(/^agent\./, "");
  const state_ = action.pending ? "half stitched: started, not yet finished" : !action.ok ? "frayed: it failed" : "stitched";
  const links = state.weave.links.filter((link) => link.from === action || link.to === action);
  const rows = [
    `<p><b>${esc(action.actor)}</b> · ${esc(action.band.sessionId)}</p>`,
    `<p>${esc(action.type)} · ${esc(STITCH_NAMES[kind] ?? STITCH_NAMES.other)}</p>`,
    `<p>${esc(state_)}${span(action.duration) ? " · " + span(action.duration) : ""}</p>`,
    `<p><code>${esc(new Date(action.t).toLocaleString())}</code></p>`,
  ];
  for (const link of links) {
    const other = link.from === action ? link.to : link.from;
    rows.push(`<p>${link.from === action ? "yarn out" : "yarn in"} · ${esc(link.kind)} · ${esc(other.band.sessionId)}</p>`);
  }
  const detail = action.events.at(-1).detail ?? {};
  for (const [key, value] of Object.entries(detail)) rows.push(`<p>${esc(key)}: ${esc(value)}</p>`);
  rows.push(`<p><code>${action.events.map((event) => esc(event.id) + (event.hash ? " · " + esc(String(event.hash).replace(/^sha256:/, "").slice(0, 12)) : "")).join("<br>")}</code></p>`);
  return `<h2>${esc(title)}</h2>` + rows.join("");
}

function describeBand(band) {
  const title = band.failure && band.completion ? "Completed, with a frayed pass"
    : band.completion ? "Bound and finished"
    : band.status === "failed" ? "Frayed, unfinished" : "Still on the loom";
  return `<h2>${esc(title)}</h2><p><b>${esc(band.actor)}</b> · ${esc(band.sessionId)}</p>`
    + `<p>${band.eventCount} sealed events · ${band.actions.length} motifs · ${band.toolCount} tools · ${band.approvalCount} approvals</p>`
    + `<p><code>${esc(new Date(band.t0).toLocaleString())} → ${esc(new Date(band.t1).toLocaleString())}</code></p>`;
}

// The inspector opens where the cloth was clicked and stays pinned to that
// spot on the cloth while the view moves.
function select(hit, at) {
  state.selected = hit;
  if (!hit) {
    panel.classList.remove("show");
    hoop.visible = false;
    state.pin = null;
  } else {
    panel.innerHTML = hit.action ? describeAction(hit.action) : describeBand(hit.band);
    panel.scrollTop = 0;
    panel.classList.add("show");
    hoop.visible = !!hit.action && !hit.action.border;
    if (hoop.visible) hoop.position.set(hit.action.wx, hit.action.wy - 0.5, 0);
    if (at) state.pin = at;
    placePanel();
  }
  state.dirty = true;
}

const pinned = new THREE.Vector3();
function placePanel() {
  if (!state.pin || !state.selected) return;
  pinned.copy(state.pin).project(camera);
  const x = (pinned.x * 0.5 + 0.5) * innerWidth;
  const y = (-pinned.y * 0.5 + 0.5) * innerHeight;
  const w = panel.offsetWidth;
  const h = panel.offsetHeight;
  // Open down and to the right of the pointer; flip at the window's edge.
  const left = x + 14 + w > innerWidth - 12 ? x - 14 - w : x + 14;
  const top = y + 14 + h > innerHeight - 12 ? y - 14 - h : y + 14;
  panel.style.left = Math.max(12, Math.min(innerWidth - w - 12, left)) + "px";
  panel.style.top = Math.max(12, Math.min(innerHeight - h - 12, top)) + "px";
  panel.style.transformOrigin = `${left < x ? "100%" : "0"} ${top < y ? "100%" : "0"}`;
}

// ---------------------------------------------------------------- input

canvas.addEventListener("pointerdown", (event) => {
  state.drag = { x: event.clientX, y: event.clientY, cx: state.cam.x, cy: state.cam.y, moved: false };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  state.tilt.tx = STILL ? 0 : -((event.clientX / innerWidth) * 2 - 1);
  state.tilt.ty = STILL ? 0 : (event.clientY / innerHeight) * 2 - 1;
  if (state.drag) {
    const scale = viewHeight() / innerHeight;
    const dx = event.clientX - state.drag.x;
    const dy = event.clientY - state.drag.y;
    if (Math.hypot(dx, dy) > 4 && !state.drag.moved) {
      state.drag.moved = true;
      state.follow = null;
      state.touched = true;
    }
    if (!state.drag.moved) return;
    state.cam.x = state.drag.cx - dx * scale;
    state.cam.y = state.drag.cy + dy * scale;
    clampCamera();
    tip.hidden = true;
  } else {
    const hit = pick(event.clientX, event.clientY);
    canvas.style.cursor = hit ? "pointer" : "grab";
    if (hit?.action) {
      const a = hit.action;
      tip.textContent = (a.tool ?? a.type.replace(/^agent\./, "")) + " · " + a.actor + " · " + new Date(a.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      tip.style.left = Math.min(innerWidth - 260, event.clientX + 14) + "px";
      tip.style.top = event.clientY + 16 + "px";
      tip.hidden = false;
    } else tip.hidden = true;
  }
  state.dirty = true;
});
canvas.addEventListener("pointerleave", () => {
  tip.hidden = true;
  state.tilt.tx = state.tilt.ty = 0;
  state.dirty = true;
});
canvas.addEventListener("pointerup", (event) => {
  const drag = state.drag;
  state.drag = null;
  if (!drag || drag.moved) return;
  const hit = pick(event.clientX, event.clientY);
  tip.hidden = true;
  select(hit, hit ? clothPoint(event.clientX, event.clientY) : null);
});
// A click anywhere off the cloth's stitches, or outside the canvas, dismisses.
addEventListener("pointerdown", (event) => {
  if (state.selected && event.target !== canvas && !panel.contains(event.target)) select(null);
});
canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  state.follow = null;
  state.touched = true;
  const before = clothPoint(event.clientX, event.clientY);
  state.cam.d *= Math.exp(Math.max(-1, Math.min(1, event.deltaY / 240)) * 0.35);
  clampCamera();
  const after = clothPoint(event.clientX, event.clientY);
  if (before && after) {
    state.cam.x += before.x - after.x;
    state.cam.y += before.y - after.y;
    clampCamera();
  }
  state.dirty = true;
}, { passive: false });
addEventListener("keydown", (event) => {
  if (event.key === "Escape") select(null);
  if (event.key === "0" || event.key === "f") {
    state.cam.d = state.fit;
    state.cam.x = state.size.w / 2;
    state.touched = false;
    frame(false);
  }
});
addEventListener("resize", () => {
  resize();
  if (!state.weave) return;
  // Until someone takes hold of the cloth, keep it framed.
  if (state.touched) state.fit = fitDistance().all;
  else frame(!!state.follow);
});

// ---------------------------------------------------------------- the loop

function tick(now) {
  requestAnimationFrame(tick);
  const previous = state.last;
  state.last = now;
  if (!state.weave) return;
  const sewing = FREEZE === null && clock.value < state.sewnUntil;
  if (sewing) {
    // Sewing time only runs while there is sewing to do, so stitches appended
    // later are drawn through rather than appearing whole.
    clock.value += Math.min(0.25, Math.max(0, (now - (previous ?? now)) / 1000));
    updateYarns();
    moveNeedle();
    if (state.follow) {
      // Keep the needle in view: ride up the cloth with the newest stitch.
      let front = 0;
      for (const action of state.weave.actions) if (action.birth <= clock.value && action.wy > front) front = action.wy;
      const target = Math.max(viewHeight() / 2 - 14, Math.min(state.size.h + 14 - viewHeight() / 2, front - viewHeight() * 0.18)) + state.follow.shift;
      state.cam.y += (target - state.cam.y) * 0.06;
    }
    state.dirty = true;
  }
  const dx = state.tilt.tx - state.tilt.x;
  const dy = state.tilt.ty - state.tilt.y;
  if (Math.abs(dx) + Math.abs(dy) > 0.002) {
    state.tilt.x += dx * 0.08;
    state.tilt.y += dy * 0.08;
    state.dirty = true;
  }
  if (!state.dirty) return;
  state.dirty = false;
  placeCamera();
  camera.updateMatrixWorld();
  placePanel();
  renderer.render(scene, camera);
}

function signature(spec) {
  const stitches = spec.stitches ?? [];
  return stitches.length + ":" + (stitches.at(-1)?.id ?? "") + ":" + (spec.links?.length ?? 0);
}

// The server answers for the log only to the key it made at start-up. The
// launch page passes that key in the address's fragment; it is kept for this
// tab alone and taken out of the address bar at once.
const KEY_STORE = "eventloom-tapestry-key";

function accessKey() {
  const offered = new URLSearchParams(location.hash.slice(1)).get("key");
  if (offered) {
    sessionStorage.setItem(KEY_STORE, offered);
    history.replaceState(null, "", location.pathname + location.search);
  }
  return sessionStorage.getItem(KEY_STORE) ?? "";
}

async function load() {
  const res = await fetch("/weave.json" + location.search, {
    cache: "no-store",
    headers: { authorization: "Bearer " + accessKey() },
  });
  // the server says what is wrong with the address, e.g. ?days=abc
  if (!res.ok) throw new Error((await res.text()) || "weave.json answered " + res.status);
  return res.json();
}

async function boot() {
  resize();
  requestAnimationFrame(tick);
  let spec;
  try {
    spec = await load();
  } catch (error) {
    empty.hidden = false;
    empty.innerHTML = "The loom could not read the log.<small>" + esc(error.message) + "</small>";
    return;
  }
  // What is on the cloth: how many days of the log, and which goal if any.
  const corr = spec.filter?.correlation;
  const days = spec.filter?.days;
  const range = days ? "LAST " + days + (days === 1 ? " DAY" : " DAYS") : "WHOLE LOG";
  const note = document.querySelector("header p");
  note.textContent = corr ? range + " · GOAL CORRELATION · " + corr : range;
  note.hidden = false;
  state.spec = spec;
  state.signature = signature(spec);
  build(spec, null);
  empty.hidden = state.weave.actions.length > 0;
  frame(!STILL && FREEZE === null);
  document.documentElement.dataset.woven = "1";
  if (STILL || FREEZE !== null) return;
  // The log is append-only, so new lines only ever add stitches.
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const next = await load();
      const sig = signature(next);
      if (sig === state.signature) return;
      const known = new Set(state.weave.actions.filter((action) => action.birth <= clock.value).map((action) => action.id));
      const pending = new Set(state.weave.actions.filter((action) => action.pending).map((action) => action.id));
      for (const id of pending) known.delete(id); // a finished action is restitched whole
      const before = { ...state.size };
      state.spec = next;
      state.signature = sig;
      const chosen = state.selected;
      build(next, known);
      empty.hidden = state.weave.actions.length > 0;
      // Left alone, the view keeps the whole cloth in frame as it grows.
      if (state.touched) {
        state.fit = fitDistance().all;
        state.cam.x += state.size.ox - before.ox;
      } else frame(false);
      const again = chosen?.action && state.weave.actions.find((action) => action.id === chosen.action.id);
      if (again) {
        // The cloth may have grown around the pin; move it with its design.
        const pin = state.pin?.clone().add(new THREE.Vector3(again.wx - chosen.action.wx, again.wy - chosen.action.wy, 0));
        select({ action: again }, pin);
      } else select(null);
    } catch (error) {
      console.warn("tapestry: could not refresh the weave;", error); // the next poll tries again
    }
  }, 4000);
}

boot();
