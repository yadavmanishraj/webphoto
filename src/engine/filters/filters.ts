import type { PixelBuffer } from '../../core/contracts';

const clamp = (v: number) => Math.max(0, Math.min(255, v));
function makeBuf(w: number, h: number): PixelBuffer { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; }
function cloneBuf(b: PixelBuffer): PixelBuffer { return { width: b.width, height: b.height, data: new Uint8ClampedArray(b.data) }; }
function mapPixels(buf: PixelBuffer, fn: (r: number, g: number, b: number, i: number) => [number, number, number]): PixelBuffer {
  const out = cloneBuf(buf);
  for (let i = 0; i < out.data.length; i += 4) {
    const [r, g, b] = fn(out.data[i]!, out.data[i + 1]!, out.data[i + 2]!, i);
    out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b;
  }
  return out;
}
// Integer coefficients keep luminance exact for grays (gray v -> exactly v),
// so threshold boundaries (luminance >= t) behave predictably.
export const luminance = (r: number, g: number, b: number) => (299 * r + 587 * g + 114 * b) / 1000;

export function gaussianBlur(buf: PixelBuffer, radius: number): PixelBuffer {
  if (radius <= 0) return cloneBuf(buf);
  const sigma = radius, half = Math.max(1, Math.ceil(radius * 3));
  const kernel: number[] = []; let ksum = 0;
  for (let i = -half; i <= half; i++) { const wgt = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel.push(wgt); ksum += wgt; }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= ksum;
  const { width: w, height: h } = buf;
  const tmp = new Float32Array(w * h * 4); const outData = new Float32Array(w * h * 4);
  const pass = (src: Float32Array | Uint8ClampedArray, dst: Float32Array, horiz: boolean) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = -half; k <= half; k++) {
          const nx = horiz ? Math.max(0, Math.min(w - 1, x + k)) : x;
          const ny = horiz ? y : Math.max(0, Math.min(h - 1, y + k));
          acc += src[(ny * w + nx) * 4 + c]! * kernel[k + half]!;
        }
        dst[(y * w + x) * 4 + c] = acc;
      }
    }
  };
  pass(buf.data, tmp, true); pass(tmp, outData, false);
  const out = makeBuf(w, h); for (let i = 0; i < out.data.length; i++) out.data[i] = outData[i]!;
  return out;
}

export function sharpen(buf: PixelBuffer, amount: number): PixelBuffer {
  const { width: w, height: h } = buf, out = cloneBuf(buf);
  const at = (x: number, y: number, c: number) => buf.data[(Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4 + c]!;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    const v = at(x, y, c) * (1 + 4 * amount) - amount * (at(x - 1, y, c) + at(x + 1, y, c) + at(x, y - 1, c) + at(x, y + 1, c));
    out.data[(y * w + x) * 4 + c] = clamp(v);
  }
  return out;
}

export function brightnessContrast(buf: PixelBuffer, brightness: number, contrast: number): PixelBuffer {
  const c = Math.max(-100, Math.min(99.9, contrast));
  const factor = (100 + c) / (100 - c);
  return mapPixels(buf, (r, g, b) => [
    clamp(((r / 255 - 0.5) * factor + 0.5) * 255 + brightness),
    clamp(((g / 255 - 0.5) * factor + 0.5) * 255 + brightness),
    clamp(((b / 255 - 0.5) * factor + 0.5) * 255 + brightness),
  ]);
}

// --- HSL helpers ---
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const hue2rgb = (t: number) => { t = ((t % 1) + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [Math.round(hue2rgb(h + 1 / 3) * 255), Math.round(hue2rgb(h) * 255), Math.round(hue2rgb(h - 1 / 3) * 255)];
}

export function hueSaturation(buf: PixelBuffer, hueDeg: number, satDelta: number, lightDelta: number): PixelBuffer {
  return mapPixels(buf, (r, g, b) => {
    const [h, s, l] = rgbToHsl(r, g, b);
    return hslToRgb(h + hueDeg, Math.max(0, Math.min(1, s + satDelta)), Math.max(0, Math.min(1, l + lightDelta)));
  });
}

export const invertBuffer = (buf: PixelBuffer): PixelBuffer => mapPixels(buf, (r, g, b) => [255 - r, 255 - g, 255 - b]);
export const grayscaleBuffer = (buf: PixelBuffer): PixelBuffer => mapPixels(buf, (r, g, b) => { const v = Math.round(luminance(r, g, b)); return [v, v, v]; });
export function thresholdBuffer(buf: PixelBuffer, t: number): PixelBuffer {
  return mapPixels(buf, (r, g, b) => { const v = luminance(r, g, b) >= t ? 255 : 0; return [v, v, v]; });
}
export function posterizeBuffer(buf: PixelBuffer, levels: number): PixelBuffer {
  const lv = Math.max(2, Math.floor(levels));
  const q = (v: number) => Math.round((Math.floor((v / 256) * lv) * 255) / (lv - 1));
  return mapPixels(buf, (r, g, b) => [q(r), q(g), q(b)]);
}
export function noiseBuffer(buf: PixelBuffer, amount: number, seed: number): PixelBuffer {
  const out = cloneBuf(buf); let state = seed >>> 0 || 1;
  const next = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) {
    out.data[i + c] = clamp(out.data[i + c]! + (next() * 2 - 1) * amount);
  }
  return out;
}
export function pixelateBuffer(buf: PixelBuffer, size: number): PixelBuffer {
  const s = Math.max(1, Math.floor(size)); if (s === 1) return cloneBuf(buf);
  const { width: w, height: h } = buf, out = makeBuf(w, h);
  for (let by = 0; by < h; by += s) for (let bx = 0; bx < w; bx += s) {
    const sums = [0, 0, 0, 0]; let n = 0;
    for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) {
      const i = (y * w + x) * 4; for (let c = 0; c < 4; c++) sums[c]! += buf.data[i + c]!; n++;
    }
    const avg = sums.map((v) => Math.round(v / n));
    for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) {
      const i = (y * w + x) * 4; for (let c = 0; c < 4; c++) out.data[i + c] = avg[c]!;
    }
  }
  return out;
}
function convolveGray(buf: PixelBuffer, kernel: number[], bias: number): PixelBuffer {
  const { width: w, height: h } = buf, out = cloneBuf(buf);
  const lumAt = (x: number, y: number) => { const i = (Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4; return luminance(buf.data[i]!, buf.data[i + 1]!, buf.data[i + 2]!); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = bias;
    for (let ky = -1; ky <= 1; ky++) for (let kx = -1; kx <= 1; kx++) acc += kernel[(ky + 1) * 3 + (kx + 1)]! * lumAt(x + kx, y + ky);
    const i = (y * w + x) * 4; out.data[i] = out.data[i + 1] = out.data[i + 2] = clamp(acc);
  }
  return out;
}
export const embossBuffer = (buf: PixelBuffer): PixelBuffer => convolveGray(buf, [-2, -1, 0, -1, 1, 1, 0, 1, 2], 128);
export function edgeDetectBuffer(buf: PixelBuffer): PixelBuffer {
  const { width: w, height: h } = buf, out = cloneBuf(buf);
  const lumAt = (x: number, y: number) => { const i = (Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4; return luminance(buf.data[i]!, buf.data[i + 1]!, buf.data[i + 2]!); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gx = -lumAt(x - 1, y - 1) - 2 * lumAt(x - 1, y) - lumAt(x - 1, y + 1) + lumAt(x + 1, y - 1) + 2 * lumAt(x + 1, y) + lumAt(x + 1, y + 1);
    const gy = -lumAt(x - 1, y - 1) - 2 * lumAt(x, y - 1) - lumAt(x + 1, y - 1) + lumAt(x - 1, y + 1) + 2 * lumAt(x, y + 1) + lumAt(x + 1, y + 1);
    const mag = clamp(Math.sqrt(gx * gx + gy * gy)); const i = (y * w + x) * 4;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = mag;
  }
  return out;
}
