'use strict';
// Direct PNG pixel access — no canvas, no browser anti-fingerprinting noise.
// Supports 8-bit RGB (colorType 2) and RGBA (colorType 6) only.

const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function _crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ _crcTable[(c ^ data[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

function _r32(b, o) { return ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0; }
function _w32(b, o, v) { b[o]=(v>>>24)&255; b[o+1]=(v>>>16)&255; b[o+2]=(v>>>8)&255; b[o+3]=v&255; }

function _concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((s,a) => s+a.length, 0));
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

async function _pipe(stream, data) {
  const w = stream.writable.getWriter();
  w.write(data); w.close();
  const chunks = [];
  const r = stream.readable.getReader();
  for (;;) { const {done, value} = await r.read(); if (done) break; chunks.push(value); }
  return _concat(...chunks);
}

// PNG IDAT is zlib (RFC 1950) — DecompressionStream('deflate') handles it
const _inflate  = d => _pipe(new DecompressionStream('deflate'), d);
const _deflate  = d => _pipe(new CompressionStream('deflate'), d);

function _chunk(type, data) {
  const t = new Uint8Array([...type].map(c => c.charCodeAt(0)));
  const out = new Uint8Array(12 + data.length);
  _w32(out, 0, data.length);
  out.set(t, 4); out.set(data, 8);
  _w32(out, 8 + data.length, _crc32(_concat(t, data)));
  return out;
}

/**
 * Parse a PNG File/Blob/ArrayBuffer into raw pixel data.
 * @returns {{ width, height, channels, colorType, pixels: Uint8Array }}
 * pixels layout: R,G,B or R,G,B,A per pixel, row-major.
 */
async function parsePNG(src) {
  const buf = src instanceof ArrayBuffer ? src : await src.arrayBuffer();
  const b = new Uint8Array(buf);
  const SIG = [137,80,78,71,13,10,26,10];
  for (let i=0; i<8; i++) if (b[i] !== SIG[i]) throw new Error('Not a PNG');

  let pos=8, W, H, bitDepth, colorType;
  const idatParts = [];

  while (pos < b.length) {
    const len = _r32(b, pos); pos += 4;
    const type = String.fromCharCode(b[pos],b[pos+1],b[pos+2],b[pos+3]); pos += 4;
    const data = b.slice(pos, pos+len); pos += len+4; // +4 skips CRC

    if (type === 'IHDR') {
      W = _r32(data,0); H = _r32(data,4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNG not supported');
      if (bitDepth !== 8) throw new Error('Only 8-bit PNG supported');
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const chanMap = {2:3, 6:4}; // colorType → channels
  const channels = chanMap[colorType];
  if (!channels) throw new Error(`Unsupported PNG color type ${colorType} (need RGB or RGBA)`);

  const filtered = await _inflate(_concat(...idatParts));
  const stride = W * channels;
  const pixels = new Uint8Array(W * H * channels);

  const paeth = (a,b,c) => {
    const p=a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c);
    return pa<=pb && pa<=pc ? a : pb<=pc ? b : c;
  };

  for (let y=0; y<H; y++) {
    const f   = filtered[y*(stride+1)];
    const src = y*(stride+1)+1;
    const dst = y*stride;
    for (let x=0; x<stride; x++) {
      const raw = filtered[src+x];
      const a = x>=channels        ? pixels[dst+x-channels]        : 0;
      const bv= y>0                ? pixels[dst-stride+x]          : 0;
      const c = y>0 && x>=channels ? pixels[dst-stride+x-channels] : 0;
      pixels[dst+x] = (f===0 ? raw : f===1 ? raw+a : f===2 ? raw+bv :
                       f===3 ? raw+((a+bv)>>1) : raw+paeth(a,bv,c)) & 0xff;
    }
  }

  return { width:W, height:H, channels, colorType, pixels };
}

/**
 * Encode raw pixel data into a valid PNG Uint8Array (filter type None).
 */
async function encodePNG(width, height, channels, colorType, pixels) {
  const stride = width * channels;
  const filtered = new Uint8Array(height * (stride+1));
  for (let y=0; y<height; y++) {
    filtered[y*(stride+1)] = 0; // filter: None — simplest lossless
    filtered.set(pixels.subarray(y*stride, (y+1)*stride), y*(stride+1)+1);
  }
  const compressed = await _deflate(filtered);

  const ihdr = new Uint8Array(13);
  _w32(ihdr, 0, width); _w32(ihdr, 4, height);
  ihdr[8]=8; ihdr[9]=colorType; // bitDepth=8, interlace=0 (implicit)

  return _concat(
    new Uint8Array([137,80,78,71,13,10,26,10]),
    _chunk('IHDR', ihdr),
    _chunk('IDAT', compressed),
    _chunk('IEND', new Uint8Array(0))
  );
}
