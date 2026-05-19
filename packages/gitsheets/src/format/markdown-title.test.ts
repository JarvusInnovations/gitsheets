// Title-from-H1 extraction (#169). The end-to-end sheet patch reconciliation
// lives in src/sheet-title-from-h1.test.ts.

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../errors.js';
import {
  extractFirstH1,
  markdownFormat,
  rewriteLeadingH1,
} from './markdown.js';
import type { FormatConfig } from './index.js';

const CONFIG: FormatConfig = {
  type: 'markdown',
  body: 'body',
  title: 'title',
  markdownlint: false,
};

describe('extractFirstH1', () => {
  it('returns the trimmed text after the first `# `', () => {
    expect(extractFirstH1('# Hello, world\n\nBody')).toBe('Hello, world');
  });

  it('returns undefined when there is no H1', () => {
    expect(extractFirstH1('Body without a heading')).toBeUndefined();
    expect(extractFirstH1('## Subheading\n\nBody')).toBeUndefined();
    expect(extractFirstH1('')).toBeUndefined();
  });

  it('only matches ATX-style H1 (one space after `#`)', () => {
    expect(extractFirstH1('#NoSpace')).toBeUndefined();
    expect(extractFirstH1('## Two hashes')).toBeUndefined();
  });

  it('finds the H1 even if preceded by content', () => {
    expect(extractFirstH1('Some prose first.\n\n# Title\n\nMore body.')).toBe('Title');
  });

  it('trims trailing whitespace', () => {
    expect(extractFirstH1('# Hello   ')).toBe('Hello');
  });
});

describe('rewriteLeadingH1', () => {
  it('rewrites the first H1 line', () => {
    expect(rewriteLeadingH1('# Old\n\nBody', 'New')).toBe('# New\n\nBody');
  });

  it('only rewrites the first H1 (later H1s preserved)', () => {
    expect(rewriteLeadingH1('# First\n\n# Second', 'X')).toBe('# X\n\n# Second');
  });

  it('prepends a heading when the body has none', () => {
    expect(rewriteLeadingH1('Just prose, no heading.', 'X')).toBe(
      '# X\n\nJust prose, no heading.',
    );
  });

  it('handles empty body', () => {
    expect(rewriteLeadingH1('', 'X')).toBe('# X\n');
  });
});

describe('markdownFormat.serialize (with title extraction)', () => {
  it('extracts title from body and writes it to frontmatter', async () => {
    const text = await markdownFormat.serialize(
      { slug: 'hello', body: '# Hello, world\n\nA short post.' },
      CONFIG,
    );
    expect(text).toContain('title = "Hello, world"');
    expect(text).toContain('slug = "hello"');
  });

  it('agreement: supplied title that matches the H1 passes through', async () => {
    const text = await markdownFormat.serialize(
      {
        slug: 'hello',
        title: 'Hello, world',
        body: '# Hello, world\n\nA short post.',
      },
      CONFIG,
    );
    expect(text).toContain('title = "Hello, world"');
  });

  it('disagreement: supplied title that differs from the H1 throws ValidationError', async () => {
    await expect(
      markdownFormat.serialize(
        { slug: 'hello', title: 'X', body: '# Y\n\nbody' },
        CONFIG,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws when supplied title but body has no H1 (extracted=undefined)', async () => {
    await expect(
      markdownFormat.serialize(
        { slug: 'hello', title: 'Stale', body: 'No H1 here.' },
        CONFIG,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('emits no title when body has no H1 and consumer supplied no title', async () => {
    const text = await markdownFormat.serialize(
      { slug: 'hello', body: 'No H1 here.' },
      CONFIG,
    );
    expect(text).not.toMatch(/^title\s*=/m);
  });

  it('round-trips: serialized → parsed gives the same title field back', async () => {
    const text = await markdownFormat.serialize(
      { slug: 'hello', body: '# Hello, world\n\nA short post.' },
      CONFIG,
    );
    const parsed = markdownFormat.parse(text, CONFIG);
    expect(parsed['title']).toBe('Hello, world');
    expect(parsed['body']).toBe('# Hello, world\n\nA short post.');
  });
});
