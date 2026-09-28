import type { IdSource } from '../../src/main/document';

/** Deterministic hex stream so golden files contain stable SectionIds (13 §3.2). */
export class SeededIdSource implements IdSource {
  private state: number;
  constructor(seed = 1) {
    this.state = seed >>> 0 || 1;
  }
  private next(): number {
    // xorshift32
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state;
  }
  hex(chars: number): string {
    let out = '';
    while (out.length < chars) out += this.next().toString(16).padStart(8, '0');
    return out.slice(0, chars);
  }
}
