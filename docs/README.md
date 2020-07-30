# Getting Started

Gitsheets is the toolkit for distributed recordkeeping that lives inside Git.

## Overview

To prepare a repository for use with Gitsheets, all you need is a way to map a named sheet to a tree of normalized [`TOML`](https://toml.io/) files (containing one record per file).

## Natural keys

Gitsheets works best with records that have [natural keys](https://en.wikipedia.org/wiki/Natural_key), and doesn't provide any mechanism out-of-the-box for assigning keys randomly/sequentially. If your records don't yet contain any unique identifier, assign your own somehow before loading them into a git sheet.

## Declare a sheet

To declare a sheet named `todos` for example, create a file in your git repository at `.gitsheets/todos.toml`:

```toml
[gitsheet]
root = "data/todos"
path = "user-${{ userId }}/${{ id }}"
```

This configuration declares two essential things about the `todos` sheet:

- **`gitsheet.root`** declares the root path within the repository containing all records for this sheet
    - all `.toml` files under this path are considered to declare records
    - the path may contain any number of `/`s to nest the sheet's root
- **`gitsheet.path`** declares a template for finding the path to a given record
    - `${{ expression }}` path components can use arbitrary javascript

The `todos` sheet can now be upserted and queried by any Gitsheets interface.

## Upsert records

- [Using the `git sheet` command line interface](./cli/)
- [Using the `gitsheets` NodeJS module](./nodejs/)
- *Coming soon: Using the Gitsheets UI*

## Record format

Records are stored one-per file in TOML format with keys sorted alphabetically:

```toml
completed = false
id = 181
title = "ut cupiditate sequi aliquam fuga maiores"
userId = 10
```

The goals of this serialization are to:

- Consistently render records to a normal form, such that identical record content will produce the same content hash
- Be decently readable in text and diff form
- Be easy to hand-edit
- Store basic data types consistently
- Generate minimal diff noise

## Querying records

- Path templates are indexes
