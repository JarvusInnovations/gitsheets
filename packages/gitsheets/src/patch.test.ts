import { describe, expect, it } from 'vitest';

import { mergePatch } from './patch.js';

describe('RFC 7396 mergePatch', () => {
  // The RFC's appendix gives these example cases. Source:
  // https://www.rfc-editor.org/rfc/rfc7396#appendix-A

  it.each([
    ['scalar replace', { a: 'b' }, { a: 'c' }, { a: 'c' }],
    ['add new key', { a: 'b' }, { b: 'c' }, { a: 'b', b: 'c' }],
    ['null deletes', { a: 'b' }, { a: null }, {}],
    ['deep merge', { a: { b: 'c' } }, { a: { b: 'd', c: null } }, { a: { b: 'd' } }],
    ['array replace (no concat)', { a: [{ b: 'c' }] }, { a: [1] }, { a: [1] }],
    ['null deletes nested', { a: { b: 'c' } }, { a: null }, {}],
    ['scalar -> object (in patch)', { a: 'foo' }, { a: { b: 'c' } }, { a: { b: 'c' } }],
    ['empty patch is identity', { e: 'foo' }, {}, { e: 'foo' }],
    ['nested add', { a: 'foo' }, { a: { bar: { baz: 'qux' } } }, { a: { bar: { baz: 'qux' } } }],
  ])('%s', (_label, target, patch, expected) => {
    expect(mergePatch(target, patch)).toEqual(expected);
  });

  it('preserves Date instances in the patch', () => {
    const d = new Date('2026-05-16T00:00:00Z');
    const result = mergePatch({ when: 'before' }, { when: d });
    expect(result).toEqual({ when: d });
    expect((result as { when: Date }).when).toBeInstanceOf(Date);
  });

  it('returns the patch when patch is non-object (replace wholesale)', () => {
    expect(mergePatch({ a: 1 }, 'replaced')).toBe('replaced');
    expect(mergePatch({ a: 1 }, null)).toBe(null);
    expect(mergePatch({ a: 1 }, 42)).toBe(42);
  });

  it('treats non-object targets as empty when patching with an object', () => {
    expect(mergePatch('was-a-string', { x: 1 })).toEqual({ x: 1 });
    expect(mergePatch(null, { x: 1 })).toEqual({ x: 1 });
  });
});
