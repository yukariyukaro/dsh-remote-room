import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import vm from 'node:vm'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
for (const [key, target] of Object.entries(manifest.exports)) {
  if (key.includes('*')) continue
  if (typeof target !== 'string') throw new Error(`Unexpected export: ${key}`)
  if (!(await stat(resolve(target))).isFile()) throw new Error(`Missing export: ${key}`)
}
for (const path of ['cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'LICENSE', 'GUIDE.md', 'src/index.ts', 'src/guide.ts']) await stat(path)
// The guide is the only in-package documentation an installed agent can reach; an empty or
// heading-less file would make remote_room_guide useless.
const guide = await readFile('GUIDE.md', 'utf8')
if (!/^# /mu.test(guide) || !guide.includes('@yukariyukaro/dsh-remote-room')) throw new Error('GUIDE.md is missing its title or package name')
for (const lang of ['en', 'zh']) {
  const value = JSON.parse(await readFile(`locale/${lang}.json`, 'utf8'))
  if (!value.meta?.title || !value.meta?.description) throw new Error(`Missing display metadata: ${lang}`)
}
const client = await readFile('lib/client.js', 'utf8')
new vm.Script(client, { filename: 'lib/client.js' })
if (!client.includes('window.__ModuleLoader__.load')) throw new Error('Not a Harness dynamic Client bundle')
console.log('Distribution exports, localized metadata and Client syntax verified')
