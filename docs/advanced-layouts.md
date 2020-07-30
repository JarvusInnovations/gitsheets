# Advanced repository layouts

The standard layout for Gitsheets in a repository is to place a `.gitsheets/` tree at the root of the repository, and reference data trees from there.

More advanced layouts may be desired though, either to accommodate multiple independent data sets within the same repository, or to logically position a subcomponent within a monorepo.

## Nested roots

A nested **root** can be configured to use a `.gitsheets/` tree positioned within some sub-path of a repository. All roots and paths configured for the sheets declared within will be relative to the parent of the `.gitsheets/` tree.

For example, you might be using Gitsheets to store static fixture data for a software project's testing process. You could declare sheets at `fixtures/.gitsheets/*.toml` and keep everything contained within `fixtures/` by configuring a root of `fixtures`:

```console
fixtures/
├── .gitsheets/
│   └── users.toml
└── users/**/*.toml
```

An alternative root may be configured via environment variable:

```bash
export GITSHEETS_ROOT=fixtures
git sheet query users
```

Or overridden via the `--root` argument to most commands:

```bash
git sheet query users --root=fixtures
```

If both are provided, the command line argument overrides the environment variable.

## Data prefixes

It is also possible to store multiple independent data sets that share the same `.gitsheets/` declarations by configuring a **prefix**.

Continuing the example from the previous section, you might want to also have several different versions of your data set to use in testing different scenarios, all sharing the same schema:

```console
fixtures/
├── .gitsheets/
│   ├── projects.toml
│   └── users.toml
├── base/
│   ├── projects/**/*.toml
│   └── users/**/*.toml
└── scenarios/
    ├── double-growth/
    │   └── projects/**/*.toml
    └── half-growth/
        └── projects/**/*.toml
```

As with nested roots, prefixes can be configured either environmentally:

```bash
export GITSHEETS_ROOT=fixtures
export GITSHEETS_PREFIX=scenarios/double-growth
git sheet query projects
```

Or overridden via the `--prefix` argument to most commands:

```bash
git sheet query users --root=fixtures --prefix=scenarios/double-growth
```
