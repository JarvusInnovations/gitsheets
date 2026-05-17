# Markdown CMS pattern

A typical use case for content-typed sheets is a small CMS: blog posts,
docs, knowledge-base entries — records whose primary content is markdown
prose, with structured metadata (title, slug, tags, publish date) in
TOML frontmatter.

## Sheet config

```toml
# .gitsheets/posts.toml
[gitsheet]
root = 'posts'
path = '${{ slug }}'

[gitsheet.format]
type = 'markdown'
body = 'body'

# Optional: tighten markdownlint for prose vs the library defaults
[gitsheet.format.markdownlint]
default = true
MD013 = false        # line-length 80 off (default for content sheets)
MD041 = false        # first-line H1 not required
MD024 = false        # allow duplicate headings (common in long posts)

[gitsheet.schema]
type = 'object'
required = ['slug', 'title', 'body', 'publishedAt']

[gitsheet.schema.properties.slug]
type = 'string'
pattern = '^[a-z0-9-]+$'

[gitsheet.schema.properties.title]
type = 'string'
minLength = 1

[gitsheet.schema.properties.body]
type = 'string'

[gitsheet.schema.properties.publishedAt]
type = 'string'
format = 'date-time'

[gitsheet.schema.properties.tags]
type = 'array'
items.type = 'string'
```

## On disk

```text
posts/
  hello-world.md
  why-gitsheets.md
  product-launch.md
```

Each file is a markdown document with frontmatter:

```markdown
+++
publishedAt = 2026-05-16T10:00:00Z
slug = "hello-world"
tags = [ "intro", "meta" ]
title = "Hello, world"
+++

# Hello, world

This is the first post. Body content here.
```

## Authoring

Three workflows pair well with the format:

**1. Editor on disk + commit.** Authors edit `posts/*.md` directly in
their editor of choice (VS Code with markdownlint extension, Obsidian,
neovim). On commit, normal git workflow. `gitsheets normalize posts`
re-runs the canonical write pipeline to catch any drift.

**2. `gitsheets edit`.** Open one record in `$EDITOR`, save, gitsheets
validates + commits:

```bash
gitsheets edit posts hello-world
```

**3. Programmatic (Node).** Driving from code — useful for batch
imports, scheduled publishes, headless CMS flows:

```typescript
import { openRepo } from 'gitsheets';

const repo = await openRepo();
await repo.transact(
  { message: 'publish: hello-world', author: { name: 'Jane', email: 'jane@x.org' } },
  async (tx) => {
    await tx.sheet('posts').upsert({
      slug: 'hello-world',
      title: 'Hello, world',
      publishedAt: new Date(),
      tags: ['intro', 'meta'],
      body: '# Hello, world\n\nFirst post body.',
    });
  }
);
```

## Reading

Default reads load the body — this is what you want for rendering a
single post:

```typescript
const posts = await repo.openSheet('posts');
const post = await posts.queryFirst({ slug: 'hello-world' });
renderHtml(post.body);
```

For listing pages (index, archives, tag pages) you only need
frontmatter. Skip the body bytes entirely:

```typescript
const recent = await posts.queryAll(
  { publishedAt: (d) => d > sevenDaysAgo() },
  { withBody: false },
);
// recent[i].body is undefined — that's the point
```

Hydrate the body on demand when a reader clicks through:

```typescript
const full = await posts.loadBody(recent[0]);
renderHtml(full.body);
```

## Indexing

Indexes always build with body-less reads. For an index keyed on tags,
slug, or a publishedAt year — anything in the frontmatter — the build
is cheap regardless of how many large bodies the sheet holds:

```typescript
posts.defineIndex('byTag', (post) =>
  Array.isArray(post.tags) && post.tags.length > 0 ? post.tags[0] : undefined,
);

const intros = await posts.findByIndex('byTag', 'intro');
// intros[i].body is undefined; loadBody when you need it
```

Don't index on body content. The keyFn will see `undefined` and the
record gets excluded.

## CLI workflows

The shipped CLI supports the full content-typed surface:

```bash
# List all posts, frontmatter only — fast even with many large bodies
gitsheets query posts --filter status=published --no-body

# Export the whole site as CSV (frontmatter columns only)
gitsheets query posts --no-body --format=csv --fields slug title publishedAt tags > index.csv

# Patch only the title — body is preserved automatically
gitsheets upsert posts '{"slug":"hello-world","title":"Hi"}' --patch

# Bulk import from a directory of .md files (one record per file)
# (requires custom glue — gitsheets doesn't yet ingest a directory tree)
```

## Pairing with a static site generator

The on-disk layout matches what Hugo, Astro, Eleventy, and Jekyll
expect. You can point an SSG at the gitsheets data repo's `posts/`
directory and treat it as the content source — no build step to merge
TOML records with attached body files.

The frontmatter sort + body normalization means git diffs are clean:
field reorders never show up as noise, and a body edit shows the
content change line-by-line.

## Pairing with attachments

A post can still carry attachments (images, code samples) under its
attachment directory at `posts/<slug>/`. Attachments aren't part of
the markdown body — they're sibling blobs under the record:

```text
posts/
  hello-world.md
  hello-world/
    hero.jpg
    diagram.svg
```

The body can reference them with relative markdown links:

```markdown
+++
slug = "hello-world"
+++

# Hello, world

![Hero](./hello-world/hero.jpg)
```

(How those relative paths resolve at render time depends on your SSG
or HTML pipeline — gitsheets just stores the bytes.)

## Coordinates

- [content-typed records (spec)](https://github.com/JarvusInnovations/gitsheets/blob/develop/specs/behaviors/content-types.md)
- [API reference](../api.md#sheet)
- [Sheet.attachments iterator](../api.md#attachments)
