import { describe, expect, it } from 'vitest';
import { DropRegistry } from '../../../../src/main/ipc/drops';

describe('DropRegistry (06 §11)', () => {
  it('allows only registered absolute paths, normalized', () => {
    const r = new DropRegistry();
    r.register(['/a/b/../deck.pptx']);
    expect(r.has('/a/deck.pptx')).toBe(true);
    expect(r.has('/a/other.pptx')).toBe(false);
    r.register(['relative.txt']);
    expect(r.has('relative.txt')).toBe(false);
  });

  it('consumes registrations', () => {
    const r = new DropRegistry();
    r.register(['/x/1', '/x/2']);
    r.consume(['/x/1']);
    expect(r.has('/x/1')).toBe(false);
    expect(r.has('/x/2')).toBe(true);
  });

  it('keeps at most `max` entries, evicting the oldest', () => {
    const r = new DropRegistry(2);
    r.register(['/1', '/2']);
    r.register(['/1']); // refresh
    r.register(['/3']);
    expect(r.has('/2')).toBe(false);
    expect(r.has('/1')).toBe(true);
    expect(r.has('/3')).toBe(true);
  });
});
