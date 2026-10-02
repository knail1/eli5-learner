import { describe, expect, it } from 'vitest';
import { DROP_REGISTRY_MAX, DropRegistry } from '../../../../src/main/ipc/drops';

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

  it('releases registrations by id (chip removed or draft cleared)', () => {
    const r = new DropRegistry({ newId: counter() });
    r.register(['/x/1', '/x/2']);
    r.release(['drop-1', 'drop-unknown']);
    expect(r.resolve('drop-1')).toBeUndefined();
    expect(r.resolve('drop-2')).toBe('/x/2');
  });

  it('resolving does not use an id up, so the same draft can start again', () => {
    const r = new DropRegistry({ newId: counter() });
    r.register(['/x/1']);
    expect(r.resolve('drop-1')).toBe('/x/1');
    expect(r.resolve('drop-1')).toBe('/x/1');
  });

  it('keeps at most `max` entries, evicting the least recently used', () => {
    const r = new DropRegistry({ max: 2, newId: counter() });
    r.register(['/1', '/2', '/3']);
    expect(r.resolve('drop-1')).toBeUndefined();
    expect(r.resolve('drop-2')).toBe('/2');
    expect(r.resolve('drop-3')).toBe('/3');
    // drop-2 was used more recently than drop-3 after this resolve, so drop-3 goes first.
    expect(r.resolve('drop-2')).toBe('/2');
    r.register(['/4']);
    expect(r.resolve('drop-3')).toBeUndefined();
    expect(r.resolve('drop-2')).toBe('/2');
    expect(r.resolve('drop-4')).toBe('/4');
  });

  it('defaults to a bounded registry', () => {
    const r = new DropRegistry({ newId: counter() });
    const paths = Array.from({ length: DROP_REGISTRY_MAX + 5 }, (_, i) => `/f/${String(i)}`);
    for (const p of paths) r.register([p]);
    expect(r.size).toBe(DROP_REGISTRY_MAX);
    expect(r.resolve('drop-1')).toBeUndefined();
  });
});
