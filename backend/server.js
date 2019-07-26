const Koa = require('koa')
const { Repo, TreeObject } = require('hologit/lib')
const TOML = require('@iarna/toml')

module.exports = createServer

if (!module.parent) {
  createServer().then((app) => {
    app.listen(3000)
  })
}

async function createServer (gitRef) {
  const app = new Koa()

  const repo = await Repo.getFromEnvironment()
  const treeObject = await TreeObject.createFromRef(repo, gitRef)

  app.use(async (ctx) => {
    const rows = []
    // TODO: TreeObject.prototype.getChildren doesn't work as expected
    await treeObject._loadBaseChildren()
    const keyedChildren = treeObject._baseChildren
    for (let [key, child] of Object.entries(keyedChildren)) {
      const contents = await child.read()
      const data = TOML.parse(contents)
      rows.push(data) // We could alternatively stream JSON LD here
    }
    ctx.body = rows
  })

  return app
}
