const toReadableStream = require('to-readable-stream')
const { stripIndent } = require('common-tags')
const { explode } = require('../commands/explode')

const csv = stripIndent`
  id,first_name,last_name
  1,Ada,Lovelace
  2,Grace,Hopper
  3,Radia,Perlman
`
const expectedHash = 'fb070046498551bb49ce253ef13daddcb56949c1'

describe('explode', () => {
  test('shit happens', async () => {
    const fileStream = toReadableStream(csv)
    const filenameTemplate = '{{id}}'
    const hash = await explode({ fileStream, filenameTemplate })
    expect(hash).toBe(expectedHash)
  })
})

