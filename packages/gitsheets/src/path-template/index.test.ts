import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError, PathTemplateError } from '../errors.js';
import {
  Template,
  type PathTemplateBlob,
  type PathTemplateTree,
} from './index.js';

afterEach(() => {
  Template.clearCache();
});

// --- Fake tree fixture ---

class FakeBlob implements PathTemplateBlob {
  readonly isBlob = true;
  constructor(public readonly id: string) {}
}

class FakeTree implements PathTemplateTree {
  readonly isTree = true;
  readonly children: Record<string, FakeTree | FakeBlob>;

  constructor(children: Record<string, FakeTree | FakeBlob>) {
    this.children = children;
  }

  async getChild(name: string): Promise<FakeTree | FakeBlob | undefined> {
    return this.children[name];
  }

  async getChildren(): Promise<Record<string, FakeTree | FakeBlob>> {
    return this.children;
  }

  async getBlobMap(): Promise<Record<string, FakeBlob>> {
    const out: Record<string, FakeBlob> = {};
    collect('', this, out);
    return out;
  }
}

function collect(prefix: string, tree: FakeTree, into: Record<string, FakeBlob>): void {
  for (const [name, child] of Object.entries(tree.children)) {
    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (child instanceof FakeBlob) {
      into[fullPath] = child;
    } else {
      collect(fullPath, child, into);
    }
  }
}

// --- Parsing & rendering ---

describe('Template.render', () => {
  it('renders a single field reference', () => {
    const t = Template.fromString('${{ slug }}');
    expect(t.render({ slug: 'janedoe' })).toBe('janedoe');
  });

  it('renders a literal-only template', () => {
    const t = Template.fromString('users/all');
    expect(t.render({})).toBe('users/all');
  });

  it('renders a composite two-level template', () => {
    const t = Template.fromString('${{ domain }}/${{ username }}');
    expect(t.render({ domain: 'af.mil', username: 'grandma' })).toBe('af.mil/grandma');
  });

  it('renders an expression component (#{{ slug.toLowerCase() }})', () => {
    const t = Template.fromString('${{ slug.toLowerCase() }}');
    expect(t.render({ slug: 'JANE' })).toBe('jane');
  });

  it('renders date-sharding expressions per the spec example', () => {
    const t = Template.fromString(
      '${{ publishedAt.getFullYear() }}/${{ publishedAt.getMonth() }}/${{ slug }}',
    );
    const publishedAt = new Date(Date.UTC(2026, 4, 16));
    expect(t.render({ publishedAt, slug: 'hello' })).toBe('2026/4/hello');
  });

  it('renders prefix + expression + suffix in a single segment', () => {
    const t = Template.fromString('user-${{ id }}.draft');
    expect(t.render({ id: 42 })).toBe('user-42.draft');
  });

  // #105 regression — multi-variable per segment
  it('renders multiple expressions in a single segment (#105)', () => {
    const t = Template.fromString('${{ year }}/${{ status }}--${{ id }}');
    expect(t.render({ year: 2026, status: 'active', id: 12345 })).toBe(
      '2026/active--12345',
    );
  });

  it('renders three expressions interleaved with literals in one segment', () => {
    const t = Template.fromString('[${{ ns }}]-${{ key }}-v${{ ver }}');
    expect(t.render({ ns: 'foo', key: 'bar', ver: 3 })).toBe('[foo]-bar-v3');
  });

  it('renders a recursive component whose value contains slashes', () => {
    const t = Template.fromString('${{ contentPath/** }}');
    expect(t.render({ contentPath: 'docs/guides/intro' })).toBe('docs/guides/intro');
  });

  it('coerces number, boolean, and bigint field values', () => {
    const t = Template.fromString('${{ n }}/${{ b }}/${{ big }}');
    expect(t.render({ n: 7, b: true, big: 10n })).toBe('7/true/10');
  });
});

// --- Failure paths ---

describe('Template.render error cases', () => {
  it('throws path_render_failed when a field is undefined', () => {
    const t = Template.fromString('${{ slug }}');
    expect(() => t.render({})).toThrowError(PathTemplateError);
    try {
      t.render({});
    } catch (err) {
      expect(err).toBeInstanceOf(PathTemplateError);
      expect((err as PathTemplateError).code).toBe('path_render_failed');
    }
  });

  it('throws path_render_failed when an expression evaluates to undefined', () => {
    const t = Template.fromString('${{ obj.missing }}');
    try {
      t.render({ obj: {} });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PathTemplateError);
      expect((err as PathTemplateError).code).toBe('path_render_failed');
    }
  });

  // #14 — invalid character handling
  it('throws path_invalid_chars on Windows-disallowed chars in a rendered segment (#14)', () => {
    const t = Template.fromString('${{ name }}');
    try {
      t.render({ name: 'foo:bar' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PathTemplateError);
      expect((err as PathTemplateError).code).toBe('path_invalid_chars');
    }
  });

  it('throws path_invalid_chars for each Windows-disallowed character', () => {
    const t = Template.fromString('${{ name }}');
    for (const bad of ['<', '>', ':', '"', '|', '?', '*']) {
      try {
        t.render({ name: `x${bad}y` });
        throw new Error(`should have thrown for ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(PathTemplateError);
        expect((err as PathTemplateError).code).toBe('path_invalid_chars');
      }
    }
  });

  it('throws path_invalid_chars on a slash inside a non-recursive segment', () => {
    const t = Template.fromString('${{ name }}');
    expect(() => t.render({ name: 'a/b' })).toThrowError(PathTemplateError);
  });

  it('allows slashes inside a recursive segment', () => {
    const t = Template.fromString('${{ p/** }}');
    expect(t.render({ p: 'a/b/c' })).toBe('a/b/c');
  });

  it('throws on an empty template', () => {
    expect(() => Template.fromString('')).toThrowError(PathTemplateError);
  });

  it('throws on consecutive slashes (empty component)', () => {
    expect(() => Template.fromString('a//b')).toThrowError(PathTemplateError);
  });

  it('throws on an unclosed expression', () => {
    expect(() => Template.fromString('${{ unclosed')).toThrowError(PathTemplateError);
  });

  it('throws when a recursive component is not the final one', () => {
    expect(() => Template.fromString('${{ a/** }}/${{ b }}')).toThrowError(PathTemplateError);
  });

  it('throws when a recursive field is mixed with literal text in the same segment', () => {
    expect(() => Template.fromString('pre-${{ a/** }}')).toThrowError(PathTemplateError);
  });

  it('rethrows non-ReferenceError errors from expressions', () => {
    const t = Template.fromString('${{ name.length.foo.bar }}');
    expect(() => t.render({ name: 5 })).toThrow();
  });
});

// --- Caching ---

describe('Template caching', () => {
  it('returns the same instance for the same template string', () => {
    const a = Template.fromString('${{ slug }}');
    const b = Template.fromString('${{ slug }}');
    expect(a).toBe(b);
  });

  it('returns different instances for different template strings', () => {
    const a = Template.fromString('${{ slug }}');
    const b = Template.fromString('${{ id }}');
    expect(a).not.toBe(b);
  });
});

// --- queryTree ---

describe('Template.queryTree', () => {
  it('opens exactly one file when all fields supplied (composite key, leaf hit)', async () => {
    const tree = new FakeTree({
      'af.mil': new FakeTree({
        'grandma.toml': new FakeBlob('grandma'),
        'other.toml': new FakeBlob('other'),
      }),
    });
    const t = Template.fromString('${{ domain }}/${{ username }}');
    const results = [];
    for await (const r of t.queryTree(tree, { domain: 'af.mil', username: 'grandma' })) {
      results.push(r);
    }
    expect(results.length).toBe(1);
    expect(results[0]?.path).toBe('af.mil/grandma');
    expect((results[0]?.blob as FakeBlob).id).toBe('grandma');
  });

  it('returns no results when the leaf does not exist', async () => {
    const tree = new FakeTree({
      'af.mil': new FakeTree({ 'grandma.toml': new FakeBlob('grandma') }),
    });
    const t = Template.fromString('${{ domain }}/${{ username }}');
    const results = [];
    for await (const r of t.queryTree(tree, { domain: 'af.mil', username: 'missing' })) {
      results.push(r);
    }
    expect(results).toEqual([]);
  });

  it('returns no results when an intermediate subtree does not exist', async () => {
    const tree = new FakeTree({
      'af.mil': new FakeTree({ 'grandma.toml': new FakeBlob('grandma') }),
    });
    const t = Template.fromString('${{ domain }}/${{ username }}');
    const results = [];
    for await (const r of t.queryTree(tree, { domain: 'navy.mil', username: 'x' })) {
      results.push(r);
    }
    expect(results).toEqual([]);
  });

  it('prunes to a single subtree when only the leading field is supplied', async () => {
    const tree = new FakeTree({
      'af.mil': new FakeTree({
        'grandma.toml': new FakeBlob('grandma'),
        'cobol.toml': new FakeBlob('cobol'),
      }),
      'navy.mil': new FakeTree({ 'sailor.toml': new FakeBlob('sailor') }),
    });
    const t = Template.fromString('${{ domain }}/${{ username }}');
    const found = [];
    for await (const r of t.queryTree(tree, { domain: 'af.mil' })) {
      found.push(r.path);
    }
    expect(found.sort()).toEqual(['af.mil/cobol', 'af.mil/grandma']);
  });

  it('expands across all subtrees when no path-template fields are supplied', async () => {
    const tree = new FakeTree({
      'af.mil': new FakeTree({ 'grandma.toml': new FakeBlob('grandma') }),
      'navy.mil': new FakeTree({ 'sailor.toml': new FakeBlob('sailor') }),
    });
    const t = Template.fromString('${{ domain }}/${{ username }}');
    const found = [];
    for await (const r of t.queryTree(tree, {})) {
      found.push(r.path);
    }
    expect(found.sort()).toEqual(['af.mil/grandma', 'navy.mil/sailor']);
  });

  it('skips attachment files under a yielded record (alice.toml then alice/avatar.png)', async () => {
    const tree = new FakeTree({
      'alice.toml': new FakeBlob('alice'),
      alice: new FakeTree({ 'avatar.png': new FakeBlob('avatar') }),
      'bob.toml': new FakeBlob('bob'),
    });
    const t = Template.fromString('${{ slug }}');
    const found = [];
    for await (const r of t.queryTree(tree, {})) {
      found.push(r.path);
    }
    expect(found.sort()).toEqual(['alice', 'bob']);
  });

  it('reads the full blob map for a recursive component and skips attachments', async () => {
    const tree = new FakeTree({
      'docs': new FakeTree({
        'guides': new FakeTree({
          'intro.toml': new FakeBlob('intro'),
          'intro': new FakeTree({ 'image.png': new FakeBlob('image') }),
        }),
      }),
    });
    const t = Template.fromString('${{ contentPath/** }}');
    const found = [];
    for await (const r of t.queryTree(tree, {})) {
      found.push(r.path);
    }
    expect(found).toEqual(['docs/guides/intro']);
  });

  it('does not prune by function-valued query entries — they are opaque', async () => {
    const tree = new FakeTree({
      'af.mil': new FakeTree({ 'a.toml': new FakeBlob('a'), 'b.toml': new FakeBlob('b') }),
    });
    const t = Template.fromString('${{ domain }}/${{ username }}');
    const found = [];
    // Passing a function value for `domain` should be opaque — walk all subtrees.
    for await (const r of t.queryTree(tree, { domain: () => true })) {
      found.push(r.path);
    }
    expect(found.sort()).toEqual(['af.mil/a', 'af.mil/b']);
  });

  it('handles a multi-variable segment when partially supplied — opaque, expand', async () => {
    const tree = new FakeTree({
      '2026': new FakeTree({
        'active--1.toml': new FakeBlob('a1'),
        'closed--2.toml': new FakeBlob('c2'),
      }),
    });
    const t = Template.fromString('${{ year }}/${{ status }}--${{ id }}');
    const found = [];
    // year supplied but only status (no id) — segment unrenderable, list all .toml children
    for await (const r of t.queryTree(tree, { year: 2026, status: 'active' })) {
      found.push(r.path);
    }
    expect(found.sort()).toEqual(['2026/active--1', '2026/closed--2']);
  });
});

// --- Date-bucket references (specs/behaviors/path-templates.md § "Date-bucket references") ---

describe('Template date buckets — rendering', () => {
  const at = new Date('2026-03-09T12:00:00Z');

  it('renders each format of the closed enum', () => {
    expect(Template.fromString('${{ publishedAt: YYYY }}/${{ slug }}').render({ publishedAt: at, slug: 'hi' }))
      .toBe('2026/hi');
    expect(Template.fromString('${{ publishedAt: YYYY/MM }}/${{ slug }}').render({ publishedAt: at, slug: 'hi' }))
      .toBe('2026/03/hi');
    expect(Template.fromString('${{ publishedAt: YYYY/MM/DD }}/${{ slug }}').render({ publishedAt: at, slug: 'hi' }))
      .toBe('2026/03/09/hi');
    // 2026-03-09 is a Monday in ISO week 11 of week-year 2026.
    expect(Template.fromString('${{ publishedAt: YYYY/WW }}/${{ slug }}').render({ publishedAt: at, slug: 'hi' }))
      .toBe('2026/11/hi');
  });

  it('zero-pads MM, DD, and WW to two digits', () => {
    const jan2 = new Date('2026-01-02T00:00:00Z');
    expect(Template.fromString('${{ d: YYYY/MM/DD }}').render({ d: jan2 })).toBe('2026/01/02');
    expect(Template.fromString('${{ d: YYYY/WW }}').render({ d: jan2 })).toBe('2026/01');
  });

  it('YYYY/WW uses the ISO week-based year, not the calendar year', () => {
    // January 1 belonging to week 53 of the PRIOR ISO year.
    expect(Template.fromString('${{ d: YYYY/WW }}').render({ d: new Date('2027-01-01T00:00:00Z') }))
      .toBe('2026/53');
    expect(Template.fromString('${{ d: YYYY }}').render({ d: new Date('2027-01-01T00:00:00Z') }))
      .toBe('2027');
    // Late December belonging to week 1 of the NEXT ISO year.
    expect(Template.fromString('${{ d: YYYY/WW }}').render({ d: new Date('2024-12-30T00:00:00Z') }))
      .toBe('2025/01');
  });

  it('renders in UTC regardless of host timezone (Date instants)', () => {
    // 23:30-05:00 is 04:30 the NEXT day in UTC; a Date is an instant, so
    // the bucket must land on the UTC date on every host.
    expect(Template.fromString('${{ d: YYYY/MM/DD }}').render({ d: new Date('2025-12-31T23:30:00-05:00') }))
      .toBe('2026/01/01');
  });

  it('accepts ISO 8601 strings', () => {
    expect(Template.fromString('${{ d: YYYY/MM }}').render({ d: '2026-03-09' })).toBe('2026/03');
    // Explicit offset normalizes to UTC.
    expect(Template.fromString('${{ d: YYYY/MM/DD }}').render({ d: '2025-12-31T23:30:00-05:00' }))
      .toBe('2026/01/01');
    // Offset-less datetime string reads at face value — never host-TZ parsed.
    expect(Template.fromString('${{ d: YYYY/MM/DD }}').render({ d: '2026-03-09T23:59:59' }))
      .toBe('2026/03/09');
  });

  it('may be the entire path (daily-rollup identity)', () => {
    expect(Template.fromString('${{ day: YYYY/MM/DD }}').render({ day: '2026-03-09' }))
      .toBe('2026/03/09');
  });

  it('composes anywhere in the template', () => {
    const t = Template.fromString('posts/${{ region }}/${{ d: YYYY/MM }}/${{ slug }}');
    expect(t.render({ region: 'us', d: '2026-03-09', slug: 'x' })).toBe('posts/us/2026/03/x');
  });

  it('reads dotted fields from nested objects', () => {
    const t = Template.fromString('${{ meta.publishedAt: YYYY/MM }}/${{ slug }}');
    expect(t.render({ meta: { publishedAt: '2026-03-09' }, slug: 'x' })).toBe('2026/03/x');
  });

  it('getFieldNames includes the bucket base field once', () => {
    expect(Template.fromString('${{ publishedAt: YYYY/MM/DD }}/${{ slug }}').getFieldNames())
      .toEqual(['publishedAt', 'slug']);
    expect(Template.fromString('${{ meta.publishedAt: YYYY/MM }}/${{ slug }}').getFieldNames())
      .toEqual(['meta', 'slug']);
  });
});

describe('Template date buckets — rejections', () => {
  it('missing field follows the missing-field rule (path_render_failed)', () => {
    const t = Template.fromString('${{ d: YYYY/MM }}/${{ slug }}');
    expect(() => t.render({ slug: 'x' })).toThrowError(PathTemplateError);
    try {
      t.render({ slug: 'x' });
    } catch (err) {
      expect((err as PathTemplateError).code).toBe('path_render_failed');
    }
  });

  it('wrong-typed values fail the render naming the field', () => {
    const t = Template.fromString('${{ d: YYYY/MM }}');
    for (const d of [42, true, { nested: 1 }, ['2026-03-09']]) {
      try {
        t.render({ d });
        expect.unreachable('render should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PathTemplateError);
        expect((err as PathTemplateError).code).toBe('path_render_failed');
        expect((err as PathTemplateError).message).toContain('"d"');
      }
    }
  });

  it('unparseable and unreal date strings fail the render', () => {
    const t = Template.fromString('${{ d: YYYY }}');
    for (const d of ['not-a-date', '2026-02-30', '2026-13-01', '2026-03-09T99:00:00']) {
      expect(() => t.render({ d })).toThrowError(PathTemplateError);
    }
  });

  it('an unknown format is ConfigError(config_invalid) at parse (sheet-open) time', () => {
    for (const bad of ['YYYY-MM', 'MM/DD', 'YYYY/MM/DD/HH', 'yyyy', 'WW', '']) {
      try {
        Template.fromString(`\${{ d: ${bad} }}/\${{ slug }}`);
        expect.unreachable(`format ${JSON.stringify(bad)} should have thrown`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe('config_invalid');
        expect((err as ConfigError).message).toContain('YYYY/MM/DD');
      }
    }
  });

  it('a bucket must stand alone in its path segment', () => {
    for (const bad of [
      'posts-${{ d: YYYY }}',
      '${{ d: YYYY }}.draft',
      '${{ d: YYYY }}${{ slug }}',
      '${{ slug }}-${{ d: YYYY/MM }}',
    ]) {
      try {
        Template.fromString(bad);
        expect.unreachable(`template ${JSON.stringify(bad)} should have thrown`);
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).code).toBe('config_invalid');
      }
    }
  });

  it('does not hijack non-bucket colon expressions (ternaries still work)', () => {
    const t = Template.fromString("${{ status === 'live' ? 'published' : 'drafts' }}/${{ slug }}");
    expect(t.render({ status: 'live', slug: 'x' })).toBe('published/x');
    expect(t.render({ status: 'draft', slug: 'x' })).toBe('drafts/x');
  });
});

describe('Template date buckets — queryTree', () => {
  const bucketTree = (): FakeTree =>
    new FakeTree({
      '2026': new FakeTree({
        '03': new FakeTree({ 'a.toml': new FakeBlob('a') }),
        '04': new FakeTree({ 'b.toml': new FakeBlob('b') }),
      }),
      '2025': new FakeTree({
        '12': new FakeTree({ 'c.toml': new FakeBlob('c') }),
      }),
    });

  it('descends the exact rendered bucket path when the field is supplied', async () => {
    const t = Template.fromString('${{ publishedAt: YYYY/MM }}/${{ slug }}');
    const found = [];
    for await (const r of t.queryTree(bucketTree(), { publishedAt: new Date('2026-03-09T12:00:00Z') })) {
      found.push(r.path);
    }
    expect(found).toEqual(['2026/03/a']);
  });

  it('treats bucket segments as wildcards when the field is absent', async () => {
    const t = Template.fromString('${{ publishedAt: YYYY/MM }}/${{ slug }}');
    const found = [];
    for await (const r of t.queryTree(bucketTree(), {})) {
      found.push(r.path);
    }
    expect(found.sort()).toEqual(['2025/12/c', '2026/03/a', '2026/04/b']);
  });

  it('widens (never throws) on a wrong-typed query value', async () => {
    const t = Template.fromString('${{ publishedAt: YYYY/MM }}/${{ slug }}');
    const found = [];
    for await (const r of t.queryTree(bucketTree(), { publishedAt: 42 })) {
      found.push(r.path);
    }
    expect(found.sort()).toEqual(['2025/12/c', '2026/03/a', '2026/04/b']);
  });
});
