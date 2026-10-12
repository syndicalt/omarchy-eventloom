// Procedural materials for the tapestry: evenweave linen, plied thread, wood,
// and the soft shadows that seat thread on cloth. Everything is generated at
// load, so the view needs no image assets.
import * as THREE from "/vendor/three.module.min.js";

function noise(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(width, height) {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  return el;
}

function texture(el, { color = false, repeat = true } = {}) {
  const map = new THREE.CanvasTexture(el);
  if (repeat) map.wrapS = map.wrapT = THREE.RepeatWrapping;
  if (color) map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

function normalFromHeight(height, size, strength) {
  const el = canvas(size, size);
  const ctx = el.getContext("2d");
  const image = ctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      image.data[i] = (-dx * inv * 0.5 + 0.5) * 255;
      image.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255; // canvas y runs down
      image.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return texture(el);
}

// Plain-weave linen. One tile is THREADS x THREADS threads; a cross stitch
// covers two of them each way, so stitches land on the holes of the weave.
export const LINEN_THREADS = 8;
export function linenMaps() {
  const size = 512;
  const pitch = size / LINEN_THREADS;
  const rand = noise(7741);
  const warpTint = Array.from({ length: LINEN_THREADS }, () => 0.94 + rand() * 0.12);
  const weftTint = Array.from({ length: LINEN_THREADS }, () => 0.94 + rand() * 0.12);
  const warpSlub = Array.from({ length: LINEN_THREADS }, () => 0.74 + rand() * 0.16);
  const weftSlub = Array.from({ length: LINEN_THREADS }, () => 0.74 + rand() * 0.16);
  const fibre = Array.from({ length: size * 4 }, () => rand());
  const height = new Float32Array(size * size);
  const el = canvas(size, size);
  const ctx = el.getContext("2d");
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / pitch;
      const v = y / pitch;
      const i = Math.floor(u);
      const j = Math.floor(v);
      const fu = (u - i - 0.5) / (warpSlub[i] / 2);
      const fv = (v - j - 0.5) / (weftSlub[j] / 2);
      const roundWarp = Math.abs(fu) < 1 ? Math.sqrt(1 - fu * fu) : 0;
      const roundWeft = Math.abs(fv) < 1 ? Math.sqrt(1 - fv * fv) : 0;
      const overWarp = Math.cos(Math.PI * (v - 0.5)) * (i % 2 ? -1 : 1);
      const overWeft = -Math.cos(Math.PI * (u - 0.5)) * (j % 2 ? -1 : 1);
      const hWarp = roundWarp * (0.56 + 0.44 * overWarp);
      const hWeft = roundWeft * (0.56 + 0.44 * overWeft);
      const warpOnTop = hWarp >= hWeft;
      const h = Math.max(hWarp, hWeft);
      height[y * size + x] = h;
      const grain = warpOnTop
        ? fibre[(x * 3 + i * 97) % fibre.length] * 0.6 + fibre[(x * 3 + ((y >> 3) * 31)) % fibre.length] * 0.4
        : fibre[(y * 3 + j * 61 + size) % fibre.length] * 0.6 + fibre[(y * 3 + ((x >> 3) * 17) + size) % fibre.length] * 0.4;
      const tint = warpOnTop ? warpTint[i] : weftTint[j];
      const shade = (0.5 + 0.5 * Math.min(1, h * 1.25)) * tint * (0.9 + grain * 0.2);
      const k = (y * size + x) * 4;
      image.data[k] = Math.min(255, 232 * shade);
      image.data[k + 1] = Math.min(255, 213 * shade);
      image.data[k + 2] = Math.min(255, 176 * shade);
      image.data[k + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { map: texture(el, { color: true }), normalMap: normalFromHeight(height, size, 2.6) };
}

// Stranded floss: plies twisting along the stitch.
export function threadMaps() {
  const size = 64;
  const rand = noise(9001);
  const fibre = Array.from({ length: size }, () => rand());
  const el = canvas(size, size);
  const bump = canvas(size, size);
  const a = el.getContext("2d").createImageData(size, size);
  const b = bump.getContext("2d").createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = (x + y * 2) % size;
      const ply = 0.5 + 0.5 * Math.cos((d / size) * Math.PI * 2 * 3);
      const hair = fibre[(x * 2 + y * 4) % size];
      const h = Math.pow(ply, 0.7) * 0.85 + hair * 0.15;
      const c = 205 + 50 * h;
      const k = (y * size + x) * 4;
      a.data[k] = a.data[k + 1] = a.data[k + 2] = c;
      b.data[k] = b.data[k + 1] = b.data[k + 2] = h * 255;
      a.data[k + 3] = b.data[k + 3] = 255;
    }
  }
  el.getContext("2d").putImageData(a, 0, 0);
  bump.getContext("2d").putImageData(b, 0, 0);
  return { map: texture(el, { color: true }), bumpMap: texture(bump) };
}

export function woodMap() {
  const el = canvas(512, 64);
  const ctx = el.getContext("2d");
  const rand = noise(4242);
  ctx.fillStyle = "#8a5f38";
  ctx.fillRect(0, 0, 512, 64);
  for (let i = 0; i < 260; i++) {
    const y = rand() * 64;
    ctx.strokeStyle = rand() < 0.5 ? `rgba(58,34,14,${0.08 + rand() * 0.22})` : `rgba(214,170,116,${0.05 + rand() * 0.16})`;
    ctx.lineWidth = 0.4 + rand() * 1.6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 512; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.02 + i) * 1.5);
    ctx.stroke();
  }
  return texture(el, { color: true });
}

export function plasterMap() {
  const size = 256;
  const el = canvas(size, size);
  const ctx = el.getContext("2d");
  const rand = noise(1312);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const c = 205 + rand() * 50;
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = c;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return texture(el, { color: true });
}

// The shadow a single stitch presses into the cloth.
export function stitchShadowMap() {
  const w = 64;
  const h = 32;
  const el = canvas(w, h);
  const ctx = el.getContext("2d");
  const image = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = (x + 0.5) / w;
      const py = (y + 0.5) / h;
      const cx = Math.max(0.2, Math.min(0.8, px));
      const d = Math.hypot((px - cx) / 0.2, (py - 0.5) / 0.5);
      const alpha = Math.max(0, 1 - d);
      const k = (y * w + x) * 4;
      image.data[k] = image.data[k + 1] = image.data[k + 2] = 255;
      image.data[k + 3] = alpha * alpha * (3 - 2 * alpha) * 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return texture(el, { repeat: false });
}

// A blurred rectangle: the cloth's shadow on the wall, a tag's on the cloth.
export function softRectMap(blur = 0.18) {
  const size = 128;
  const el = canvas(size, size);
  const ctx = el.getContext("2d");
  const image = ctx.createImageData(size, size);
  const edge = (t) => {
    const k = Math.max(0, Math.min(1, t / blur));
    return k * k * (3 - 2 * k);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size;
      const py = (y + 0.5) / size;
      const k = (y * size + x) * 4;
      image.data[k] = image.data[k + 1] = image.data[k + 2] = 255;
      image.data[k + 3] = edge(px) * edge(1 - px) * edge(py) * edge(1 - py) * 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return texture(el, { repeat: false });
}

// Lettering. `tag` draws a woven label; otherwise the text is inked straight
// onto the linen.
export function textMap(text, { tag = false, weight = 600, ink = "#2f2116" } = {}) {
  const px = 64;
  const font = `${weight} ${px}px "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`;
  const probe = canvas(8, 8).getContext("2d");
  probe.font = font;
  const padX = tag ? 34 : 6;
  const padY = tag ? 22 : 8;
  const width = Math.ceil(probe.measureText(text).width) + padX * 2;
  const height = px + padY * 2;
  const el = canvas(width, height);
  const ctx = el.getContext("2d");
  if (tag) {
    ctx.fillStyle = "#f1e6cd";
    ctx.fillRect(0, 0, width, height);
    const rand = noise(text.length * 977 + 5);
    for (let y = 0; y < height; y += 3) {
      ctx.fillStyle = `rgba(120,92,54,${0.05 + rand() * 0.07})`;
      ctx.fillRect(0, y, width, 1);
    }
    for (let x = 0; x < width; x += 3) {
      ctx.fillStyle = `rgba(255,250,236,${0.08 + rand() * 0.1})`;
      ctx.fillRect(x, 0, 1, height);
    }
    ctx.strokeStyle = "rgba(92,62,32,0.55)";
    ctx.lineWidth = 3;
    ctx.setLineDash([9, 6]);
    ctx.strokeRect(9, 9, width - 18, height - 18);
    ctx.setLineDash([]);
  }
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = ink;
  ctx.fillText(text, width / 2, height / 2 + 3);
  const map = texture(el, { color: true, repeat: false });
  return { map, aspect: width / height };
}
