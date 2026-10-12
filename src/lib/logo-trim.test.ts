import { describe, it, expect } from 'vitest';
import { opaqueBounds, padBounds, worthTrimming } from './logo-trim';

/** Lienzo RGBA transparente con un rectángulo opaco. */
function canvas(w: number, h: number, rect?: { x: number; y: number; w: number; h: number }) {
  const data = new Uint8ClampedArray(w * h * 4);
  if (rect) {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) data[(y * w + x) * 4 + 3] = 255;
    }
  }
  return data;
}

describe('opaqueBounds', () => {
  it('encuentra la caja del dibujo (el caso Exura: palabra ancha en lienzo cuadrado)', () => {
    const d = canvas(100, 100, { x: 15, y: 42, w: 70, h: 15 });
    expect(opaqueBounds(d, 100, 100)).toEqual({ x: 15, y: 42, w: 70, h: 15 });
  });
  it('todo transparente → null (no se recorta nada)', () => {
    expect(opaqueBounds(canvas(10, 10), 10, 10)).toBeNull();
  });
  it('ignora el alfa casi nulo (antialias/ruido)', () => {
    const d = canvas(10, 10, { x: 2, y: 2, w: 3, h: 3 });
    d[(9 * 10 + 9) * 4 + 3] = 5;
    expect(opaqueBounds(d, 10, 10)).toEqual({ x: 2, y: 2, w: 3, h: 3 });
  });
});

describe('worthTrimming / padBounds', () => {
  it('un logo que ya llena el lienzo no se toca', () => {
    expect(worthTrimming({ x: 0, y: 0, w: 98, h: 98 }, 100, 100)).toBe(false);
    expect(worthTrimming({ x: 15, y: 42, w: 70, h: 15 }, 100, 100)).toBe(true);
  });
  it('el margen no se sale del lienzo', () => {
    const b = padBounds({ x: 0, y: 1, w: 50, h: 20 }, 50, 22);
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.x + b.w).toBeLessThanOrEqual(50);
    expect(b.y + b.h).toBeLessThanOrEqual(22);
  });
});
