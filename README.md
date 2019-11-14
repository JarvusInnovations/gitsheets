# Gitsheets

A toolkit for using a git repository to store low-volume, high-touch, human-scale data

## Project setup

```
npm install
cd backend && npm install
```

### Compiles and hot-reloads for development

```
npm run serve
cd backend && npm start
```

### Compiles and minifies for production

```
npm run build
```

### Run your tests

```
git init tests
cd tests && git commit -m 'init' --allow-empty
cd ../backend && GIT_DIR=../tests/.git npm start
npm run test
```

### Lints and fixes files

```
npm run lint
```

### Customize configuration

See [Configuration Reference](https://cli.vuejs.org/config/).

## Using a disposable project environment

With [Chef Habitat](https://habitat.sh) installed, you don't need
anything else installed on your workstation to get a complete
development environment:

```bash
# instruct Docker to open port 8080
export HAB_DOCKER_OPTS='-p 8080:8080'

# launch into a disposable studio shell
hab studio enter
```

The [`.studiorc`](./.studiorc) script will run automatically to set up your
studio and print a list of available commands right ahead of your prompt.
