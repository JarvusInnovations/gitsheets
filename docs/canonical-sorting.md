# Canonical sorting

Gitsheets tries to get the most out of its git foundations by rendering records to file in as much a "normal" form as possible. This means that we try to make the "same" data produce the same file byte-for-byte, even when the input is formatted differently.

One thing Gitsheets does automatically to help normalize records is sorting keys alphabetically, so that both `{ first_name: "Grade", last_name: "Hopper" }` and `{ last_name: "Hopper", first_name "Grace" }` render as identical records. Gitsheets can do this because it does not guarantee the order of keyed values be preserved.

However, Gitsheets does not take the same liberty with arrays, because not being able to store ordered lists would be a significant loss of functionality. In some applications, the order of elements in a list may be significant so order needs to be preserved by default. For applications where the order of a given array field is *not* significant though, the lack of sorting means you could have two version of a record that *mean* the same thing but look changed because an array ended up in a different order.

For these cases, you may define a sort for a field in the `.gitsheets/*.toml` sheet declaration. This sort will be applied every time a version of the record is being normalized for writing to file to help reduce how often records that mean the same thing look changed to the versioning system.

## Sorting by expression

You can define an arbitrary JavaScript expression for sorting a given field:

```toml
[gitsheet.fields.relationships]
sort = '''
    if (a.kind < b.kind) return -1;
    if (a.kind > b.kind) return 1;
    if (a.label < b.label) return -1;
    if (a.label > b.label) return 1;
    return 0;
'''
```

## Sorting by configuration

In this simple case, the same sort can be achieved via a table-based configuration:

```toml
[gitsheet.fields.relationships]
sort = { kind = 'ASC', label = 'ASC' }
```

Or via an array-based configuration:

```toml
[gitsheet.fields.relationships]
sort = [ 'kind', 'label' ]
```
