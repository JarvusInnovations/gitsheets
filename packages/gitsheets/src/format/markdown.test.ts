// Direct tests for the markdown format (#158). End-to-end Sheet integration
// lives in src/sheet-markdown.test.ts.

import { describe, expect, it } from 'vitest';

import { markdownFormat } from './markdown.js';
import type { FormatConfig } from './index.js';

const CONFIG: FormatConfig = { type: 'markdown', body: 'body' };
const CONFIG_NO_LINT: FormatConfig = { type: 'markdown', body: 'body', markdownlint: false };

describe('markdownFormat.serialize', () => {
  it('writes frontmatter delimited by +++ followed by the body', async () => {
    const text = await markdownFormat.serialize(
      { slug: 'hello', title: 'Hello, world', body: '# Hello\n\nBody text\n' },
      CONFIG_NO_LINT,
    );
    expect(text.startsWith('+++\n')).toBe(true);
    expect(text).toContain(`slug = "hello"`);
    expect(text).toContain(`title = "Hello, world"`);
    expect(text).toContain('+++\n\n# Hello\n\nBody text\n');
  });

  it('writes an empty body as just the delimiters + a trailing newline', async () => {
    const text = await markdownFormat.serialize(
      { slug: 'empty', body: '' },
      CONFIG_NO_LINT,
    );
    expect(text).toBe(`+++\nslug = "empty"\n+++\n\n\n`);
  });

  it('treats undefined body as empty string', async () => {
    const text = await markdownFormat.serialize({ slug: 'no-body' }, CONFIG_NO_LINT);
    expect(text).toContain(`slug = "no-body"`);
    expect(text.endsWith('+++\n\n\n')).toBe(true);
  });

  it('normalizes the body through the native dprint formatter by default', async () => {
    const text = await markdownFormat.serialize(
      // dprint rewrites list markers to `-` and single-spaces them
      { slug: 'lint', body: '* item1\n*  item2\n' },
      CONFIG,
    );
    // Frontmatter unaffected
    expect(text).toContain(`slug = "lint"`);
    // Body normalized by the native dprint formatter
    expect(text).toContain('- item1\n- item2');
    expect(text).not.toContain('*  item2');
  });

  it('skips normalization when [gitsheet.format.markdownlint] = false', async () => {
    const text = await markdownFormat.serialize(
      { slug: 'raw', body: '* item1\n*  item2\n' },
      CONFIG_NO_LINT,
    );
    expect(text).toContain('*  item2'); // preserved verbatim
  });

  it('throws TypeError when the body field is not a string', async () => {
    await expect(
      markdownFormat.serialize({ slug: 'bad', body: 42 } as never, CONFIG_NO_LINT),
    ).rejects.toThrow(/must be a string/);
  });

  it('serializes deep-sorted frontmatter keys', async () => {
    const text = await markdownFormat.serialize(
      { zeta: 1, alpha: 2, slug: 'sorted', body: '' },
      CONFIG_NO_LINT,
    );
    const fm = text.split('+++\n')[1] ?? '';
    const alphaIdx = fm.indexOf('alpha');
    const slugIdx = fm.indexOf('slug');
    const zetaIdx = fm.indexOf('zeta');
    expect(alphaIdx).toBeLessThan(slugIdx);
    expect(slugIdx).toBeLessThan(zetaIdx);
  });
});

describe('markdownFormat.parse', () => {
  it('round-trips a record through serialize → parse', async () => {
    const original = {
      slug: 'roundtrip',
      title: 'Round-trip',
      tags: ['a', 'b'],
      body: '# Heading\n\nSome content.',
    };
    const text = await markdownFormat.serialize(original, CONFIG_NO_LINT);
    const parsed = markdownFormat.parse(text, CONFIG_NO_LINT);
    expect(parsed['slug']).toBe('roundtrip');
    expect(parsed['title']).toBe('Round-trip');
    expect(parsed['tags']).toEqual(['a', 'b']);
    expect(parsed['body']).toBe('# Heading\n\nSome content.');
  });

  it('preserves a body that contains a +++ line', async () => {
    const body = 'before\n\n+++\n\nafter';
    const text = await markdownFormat.serialize({ slug: 'plus', body }, CONFIG_NO_LINT);
    const parsed = markdownFormat.parse(text, CONFIG_NO_LINT);
    expect(parsed['body']).toBe(body);
  });

  it('reads back an empty body as ""', async () => {
    const text = await markdownFormat.serialize({ slug: 'empty', body: '' }, CONFIG_NO_LINT);
    const parsed = markdownFormat.parse(text, CONFIG_NO_LINT);
    expect(parsed['body']).toBe('');
  });

  it('preserves TOML datetime types through the frontmatter', async () => {
    const original = {
      slug: 'dated',
      publishedAt: new Date('2024-05-16T10:00:00Z'),
      body: 'hi',
    };
    const text = await markdownFormat.serialize(original, CONFIG_NO_LINT);
    const parsed = markdownFormat.parse(text, CONFIG_NO_LINT);
    expect(parsed['publishedAt']).toBeInstanceOf(Date);
    expect((parsed['publishedAt'] as Date).toISOString()).toBe('2024-05-16T10:00:00.000Z');
  });

  it('handles a UTF-8 BOM at the start of the file', async () => {
    const text = '﻿+++\nslug = "bom"\n+++\n\nhello\n';
    const parsed = markdownFormat.parse(text, CONFIG_NO_LINT);
    expect(parsed['slug']).toBe('bom');
    expect(parsed['body']).toBe('hello');
  });

  it('treats a body-only file (no frontmatter) as a record with just the body field', async () => {
    const parsed = markdownFormat.parse('just some body text', CONFIG_NO_LINT);
    expect(parsed['body']).toBe('just some body text');
    // Frontmatter was empty → no other fields
    expect(Object.keys(parsed).filter((k) => k !== 'body')).toEqual([]);
  });
});

describe('markdownFormat.parseHeaderOnly', () => {
  it('skips the body entirely', async () => {
    const text = await markdownFormat.serialize(
      { slug: 'header', title: 'Header only', body: 'this body is big\n'.repeat(1000) },
      CONFIG_NO_LINT,
    );
    const headerOnly = markdownFormat.parseHeaderOnly(text, CONFIG_NO_LINT);
    expect(headerOnly['slug']).toBe('header');
    expect(headerOnly['title']).toBe('Header only');
    expect(headerOnly['body']).toBeUndefined();
  });
});

describe('markdownFormat config validation', () => {
  it('throws when [gitsheet.format].body is missing', () => {
    expect(() => markdownFormat.parse('+++\nx=1\n+++\n\n', { type: 'markdown' })).toThrow(
      /requires.*body/,
    );
  });
});
