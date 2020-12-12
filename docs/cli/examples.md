# Examples

## Add id based on file name

In this example, shell scripting is used to go through a set of incomplete initial records and populate their ID from their filename:

```bash
find issues skills statuses technologies -name '*.toml' | while read record_path; do
    record_id=$(basename "${record_path}" .toml)
    record_sheet=$(dirname "${record_path}")
    echo "Initializing id=${record_id} for ${record_path} in ${record_sheet}"

    git sheet read "${record_path}" \
        | jq ".id = \"${record_id}\"" \
        | git sheet upsert "${record_sheet}"
done
```
