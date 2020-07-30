# Quick demo

## Install the `git sheet` command

```bash
npm install -g gitsheets
```

## Initialize a temporary git repository

```bash
git init /tmp/gitsheets-demo
cd /tmp/gitsheets-demo
```

## Declare a `todos` gitsheet

```bash
mkdir -p .gitsheets
echo -e '[gitsheet]
root = "todos"
path = "user-${{ userId }}/${{ id }}"
' > .gitsheets/todos.toml

git add .gitsheets
git commit -m "feat: declare todos gitsheet"
```

## Upsert records from an API

```bash
curl https://jsonplaceholder.typicode.com/todos | git sheet upsert todos

git commit -m "data: import todos from API"
```

## Query records via CLI

```json
git sheet query todos --filter.completed --format=csv > todos.completed.csv
```
