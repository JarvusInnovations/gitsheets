const Koa = require('koa')
const { Repo, TreeObject } = require('hologit/lib')
const TOML = require('@iarna/toml')
const Router = require('koa-router')

module.exports = createServer

if (!module.parent) {
  createServer().then((app) => {
    app.listen(3000)
  })
}

async function createServer (gitRef) {
  const app = new Koa()
  const router = new Router()

  const repo = await Repo.getFromEnvironment()
  const treeObject = await TreeObject.createFromRef(repo, gitRef)

  router.get('/', async (ctx) => {
    const rows = []
    const keyedChildren = await treeObject.getChildren()
    for (let key in keyedChildren) {
      const child = keyedChildren[key]
      const contents = await child.read()
      const data = TOML.parse(contents)
      rows.push(data) // We could alternatively stream JSON LD here
    }
    ctx.body = rows
  })

  return app
    .use(router.routes())
    .use(router.allowedMethods())
}
