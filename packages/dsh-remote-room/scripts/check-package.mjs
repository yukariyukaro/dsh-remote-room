import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import vm from 'node:vm'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
for (const [key, target] of Object.entries(manifest.exports)) {
  if (key.includes('*')) continue
  if (typeof target !== 'string') throw new Error(`Unexpected export: ${key}`)
  if (!(await stat(resolve(target))).isFile()) throw new Error(`Missing export: ${key}`)
}
for (const path of ['cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'LICENSE']) await stat(path)
for (const lang of ['en', 'zh']) {
  const value = JSON.parse(await readFile(`locale/${lang}.json`, 'utf8'))
  if (!value.meta?.title || !value.meta?.description) throw new Error(`Missing display metadata: ${lang}`)
}
const client = await readFile('lib/client.js', 'utf8')
new vm.Script(client, { filename: 'lib/client.js' })
if (!client.includes('window.__ModuleLoader__.load')) throw new Error('Not a Harness dynamic Client bundle')
console.log('Distribution exports, localized metadata and Client syntax verified')
