import { describe, expect, it } from 'vitest';
import { DropRegistry } from '../../../../src/main/ipc/drops';

function counter(): () => string {
  let n = 0;
  return () => `drop-${String(++n)}`;
}

describe('DropRegistry (06 §11)', () => {
  it('mints an opaque input id per registered absolute path, normalized', () => {
    const r = new DropRegistry({ newId: counter() });
    expect(r.register(['/a/b/../deck.pptx', 'relative.txt', '/c/notes.md'])).toEqual([
      { inputId: 'drop-1', path: '/a/deck.pptx' },
      { inputId: 'drop-2', path: '/c/notes.md' },
    ]);
    expect(r.resolve('drop-1')).toBe('/a/deck.pptx');
    expect(r.resolve('drop-2')).toBe('/c/notes.md');
    expect(r.resolve('drop-3')).toBeUndefined();
  });

  it('never resolves a path, only an id main minted', () => {
    const r = new DropRegistry({ newId: counter() });
    r.register(['/a/deck.pptx']);
    expect(r.resolve('/a/deck.pptx')).toBeUndefined();
  });

  it('default ids are unguessable and fit the 03 §13 input id pattern', () => {
    const r = new DropRegistry();
    const [a, b] = r.register(['/a', '/b']);
    expect(a?.inputId).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(a?.inputId).not.toBe(b?.inputId);
  });

  it('consumes registrations by id', () => {
    const r = new DropRegistry({ newId: counter() });
    r.register(['/x/1', '/x/2']);
    r.consume(['drop-1']);
    expect(r.resolve('drop-1')).toBeUndefined();
    expect(r.resolve('drop-2')).toBe('/x/2');
  });

  it('keeps at most `max` entries, evicting the oldest', () => {
    const r = new DropRegistry({ max: 2, newId: counter() });
    r.register(['/1', '/2', '/3']);
    expect(r.resolve('drop-1')).toBeUndefined();
    expect(r.resolve('drop-2')).toBe('/2');
    expect(r.resolve('drop-3')).toBe('/3');
  });
});
