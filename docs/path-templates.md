# Path templates

Path templates are the key to how Gitsheets works. They define how each sheet maps records into a tree of files.

In addition to teaching Gitsheets how to store records, path templates also inform how they are queried. Gitsheets attempts to load as little of the tree as possible while executing a query by rendering the path from left to right against the query. This means that essentially, your path template is also your indexing and sharding strategy. This has little practical performance implication for sets of records in the 10s and 100s, but can become significant beyond that.

## Single-field unique key

The simplest case is one where each record already has a single unique text field.

=== ".gitsheets/users.toml"

    ```toml
    [gitsheet]
    root = "users"
    path = "${{ username }}"
    ```

=== "users/GrandmaCOBOL.toml"

    ```toml
    first_name = "Grace"
    last_name = "Hopper"
    username = "GrandmaCOBOL"
    ```

=== "Try it"

    Declare the `users` sheet:

    ```bash
    mkdir -p .gitsheets/
    echo '[gitsheet]
    root = "users"
    path = "${{ username }}"' > .gitsheets/users.toml
    ```

    Upsert a user:

    ```bash
    git sheet upsert users '{
        "username": "GrandmaCOBOL",
        "first_name": "Grace",
        "last_name": "Hopper"
    }'
    ```

    Query a user:

    ```bash
    git sheet query users --filter.username=GrandmaCOBOL
    ```

## Multi-field unique key

If one field is not enough to create a unique path, a composite key can be configured by combining multiple path components:

=== ".gitsheets/domain-users.toml"

    ```toml
    [gitsheet]
    root = "domain-users"
    path = "${{ domain }}/${{ username }}"
    ```

=== "domain-users/af.mil/GrandmaCOBOL.toml"

    ```toml
    domain = "af.mil"
    first_name = "Grace"
    last_name = "Hopper"
    username = "GrandmaCOBOL"
    ```

=== "domain-users/yale.edu/GrandmaCOBOL.toml"

    ```toml
    domain = "yale.edu"
    first_name = "Grace"
    last_name = "Hopper"
    username = "GrandmaCOBOL"
    ```

=== "Try it"

    Declare the `domain-users` sheet:

    ```bash
    mkdir -p .gitsheets/
    echo '[gitsheet]
    root = "domain-users"
    path = "${{ domain }}/${{ username }}"' > .gitsheets/domain-users.toml
    ```

    Upsert multiple users:

    ```bash
    git sheet upsert domain-users '[
        {
            "username": "GrandmaCOBOL",
            "domain": "yale.edu",
            "first_name": "Grace",
            "last_name": "Hopper"
        },
        {
            "username": "GrandmaCOBOL",
            "domain": "af.mil",
            "first_name": "Grace",
            "last_name": "Hopper"
        }
    ]'
    ```

    Query multiple users:

    ```bash
    git sheet query users --filter.username=GrandmaCOBOL
    ```

    Query unique user by domain:

    ```bash
    git sheet query users --filter.username=GrandmaCOBOL --filter.domain=af.mil
    ```

## Sharding paths

Path components need not contribute to the path's uniqueness, the can also be used just to organize records either for easier human browsing or to spread the records over multiple subtrees for improved query performance. Smaller trees can be loaded and searched faster, and any fields you're likely to often filter queries with can be acted on without loading and parsing the record if they're part of the path:

=== ".gitsheets/students.toml"

    ```toml
    [gitsheet]
    root = "students"
    path = "${{ graduation_year }}/${{ status }}/${{ student_id }}"
    ```

## Dynamically sharding paths

Because TOML has an explicit date type, and arbitrary JavaScript expressions can be used in path templates, you can do something like this to organize records by date:

=== ".gitsheets/blog-posts.toml"

    ```toml
    [gitsheet]
    root = "blog-posts"
    path = "${{ published_at.getYear() }}/${{ published_at.getMonth() }}/${{ published_at.getDate() }}/${{ slug }}"
    ```

## Annotated paths

Prefixes, suffixes, and static path components can be used to add clarity for human readers:

=== ".gitsheets/todos.toml"

    ```toml
    [gitsheet]
    root = "todos"
    path = "by-user/user-${{ userId }}/${{ id }}"
    ```

## Nested path fields

If a field may contain `/` characters internally, they can be used to build paths:

=== ".gitsheets/content.toml"

    ```toml
    [gitsheet]
    root = "content"
    path = "${{ path/** }}"
    ```
