const Koa = require('koa')
const Router = require('koa-router')
const assert = require('http-assert')
const git = require('git-client')
const { explode, listRows } = require('./lib')

const validRefPattern = /^[\w-]+$/
const validFilenameTemplatePattern = /^[{}\w-\/]+$/

module.exports = createServer

if (!module.parent) {
  createServer().then((app) => {
    app.listen(3000)
  })
}

async function createServer () {
  const app = new Koa()
  const router = new Router()

  router.get('/:ref', async (ctx) => {
    const ref = ctx.params.ref
    assert(validRefPattern.test(ref), 400, 'invalid ref')
    const rows = await listRows(ref)
    ctx.body = rows
  })

  router.post('/:ref/import', async (ctx) => {
    const ref = ctx.params.ref
    const fileStream = ctx.req
    const filenameTemplate = ctx.request.query.filenameTemplate

    assert(filenameTemplate, 400, 'missing filenameTemplate query param')
    assert(ctx.request.type == 'text/csv', 400, 'content-type must be text/csv')
    assert(validRefPattern.test(ref), 400, 'invalid ref')
    assert(validFilenameTemplatePattern.test(filenameTemplate), 400, 'invalid filenameTemplate')

    try {
      const treeHash = await explode({ fileStream, filenameTemplate })
      const commitHash = await git.commitTree(treeHash, { p: ref, m: 'import' })
      const branchName = `pr-${Date.now()}`
      await git.branch(branchName, commitHash)
      ctx.body = { branch: branchName }
    } catch (err) {
      ctx.status = 500
    }
  })

  return app
    .use(router.routes())
    .use(router.allowedMethods())
}
