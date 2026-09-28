/** Injectable clock for pipeline/, document/ and library/ (13 §3.2). */
export interface Clock {
  now(): Date;
}

export class FakeClock implements Clock {
  private t: number;
  constructor(start = '2026-01-01T00:00:00.000Z') {
    this.t = Date.parse(start);
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
