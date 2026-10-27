import { build as tsdown } from 'tsdown'
import { build as esbuild } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

await tsdown({
  entry: { index: 'src/index.ts' },
  format: 'esm', target: 'node24', platform: 'node', outDir: 'lib',
  clean: true, dts: false, sourcemap: true,
  external: [/^@deepseek-ai\//, 'ws', 'node:*'],
})
const browser = await esbuild({
  entryPoints: ['src/client/index.tsx'], bundle: true, write: false,
  format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic',
  // The Web shell seeds these into its frozen module table; loading them keeps one React.
  external: ['react', 'react/jsx-runtime'],
  legalComments: 'inline', minify: false,
})
const source = browser.outputFiles[0]?.text
if (!source) throw new Error('Client build produced no JavaScript')
await mkdir('lib', { recursive: true })
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:'dsh-room',factory(require){const module={exports:{}};const exports=module.exports;\n${source}\nreturn module.exports;}});\n`)
console.log('built lib/index.js and lib/client.js')
