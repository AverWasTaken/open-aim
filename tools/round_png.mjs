// Tiny RGB PNG canvas for the round tools' plots (pure node: zlib only).
import fs from 'node:fs';
import zlib from 'node:zlib';

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc = (b) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([l, td, c]);
};
// 3x5 pixel font.
const F = 'A:7,5,7,5,5 B:6,5,6,5,6 C:7,4,4,4,7 D:6,5,5,5,6 E:7,4,6,4,7 F:7,4,6,4,4 G:7,4,5,5,7 H:5,5,7,5,5 I:7,2,2,2,7 J:1,1,1,5,7 K:5,5,6,5,5 L:4,4,4,4,7 M:5,7,7,5,5 N:6,5,5,5,5 O:7,5,5,5,7 P:7,5,7,4,4 Q:7,5,5,7,1 R:7,5,6,5,5 S:7,4,7,1,7 T:7,2,2,2,2 U:5,5,5,5,7 V:5,5,5,5,2 W:5,5,7,7,5 X:5,5,2,5,5 Y:5,5,2,2,2 Z:7,1,2,4,7 0:7,5,5,5,7 1:2,6,2,2,7 2:7,1,7,4,7 3:7,1,7,1,7 4:5,5,7,1,1 5:7,4,7,1,7 6:7,4,7,5,7 7:7,1,1,1,1 8:7,5,7,5,7 9:7,5,7,1,7 -:0,0,7,0,0 .:0,0,0,0,2 ?:7,1,2,0,2 /:1,1,2,4,4 =:0,7,0,7,0 +:0,2,7,2,0 (:1,2,2,2,1 ):4,2,2,2,4 ,:0,0,0,2,4 %:5,1,2,4,5 >:4,2,1,2,4';
const FONT = { ' ': [0, 0, 0, 0, 0] };
for (const e of F.split(' ')) { const i = e.indexOf(':'); FONT[e.slice(0, i)] = e.slice(i + 1).split(',').map(Number); }

export class Img {
  constructor(w, h, bg = [20, 20, 24]) { this.w = w; this.h = h; this.p = Buffer.alloc(w * h * 3); for (let i = 0; i < w * h; i++) this.p.set(bg, i * 3); }
  set(x, y, c) { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; this.p.set(c, (y * this.w + x) * 3); }
  rect(x, y, s, c) { for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) this.set(x + i - (s >> 1), y + j - (s >> 1), c); }
  line(x0, y0, x1, y1, c, t = 1) { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1; for (let i = 0; i <= n; i++) this.rect(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, t, c); }
  arrow(x0, y0, x1, y1, c, t = 2) {
    this.line(x0, y0, x1, y1, c, t);
    const a = Math.atan2(y1 - y0, x1 - x0), L = Math.max(5, t * 4);
    for (const s of [-0.5, 0.5]) this.line(x1, y1, x1 - L * Math.cos(a + s), y1 - L * Math.sin(a + s), c, t);
  }
  circle(x, y, r, c, t = 2) { const n = Math.max(32, Math.ceil(r * 6)); for (let a = 0; a < n; a++) { const q = a / n * 2 * Math.PI; this.rect(x + r * Math.cos(q), y + r * Math.sin(q), t, c); } }
  text(x, y, s, c, sc = 2) {
    for (const ch of String(s).toUpperCase()) {
      const g = FONT[ch] || FONT['?'];
      for (let r = 0; r < 5; r++) for (let k = 0; k < 3; k++) if (g[r] >> (2 - k) & 1) for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) this.set(x + k * sc + a, y + r * sc + b, c);
      x += 4 * sc;
    }
  }
  // Text with a dark outline so it reads on any background.
  label(x, y, s, c, sc = 2) { for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) this.text(x + dx, y + dy, s, [0, 0, 0], sc); this.text(x, y, s, c, sc); }
  save(f) {
    const raw = Buffer.alloc((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) { raw[y * (this.w * 3 + 1)] = 0; this.p.copy(raw, y * (this.w * 3 + 1) + 1, y * this.w * 3, (y + 1) * this.w * 3); }
    const ih = Buffer.alloc(13); ih.writeUInt32BE(this.w, 0); ih.writeUInt32BE(this.h, 4); ih[8] = 8; ih[9] = 2;
    fs.writeFileSync(f, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  }
}
