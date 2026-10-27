import { build as tsdown } from 'tsdown'
import { build as esbuild } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

await tsdown({
  entry: { index: 'src/index.ts' },
  format: 'esm', target: 'node24', platform: 'node', outDir: 'lib',
  clean: true, dts: false, sourcemap: true,
  external: [/^@deepseek-ai\//, 'ws'],
})
const browser = await esbuild({
  entryPoints: ['src/client/index.ts'], bundle: true, write: false,
  format: 'cjs', platform: 'browser', target: 'es2022',
  jsx: 'automatic',
  // Platform modules the Web shell seeds into its frozen module table. Loading them
  // instead of bundling keeps one React, one Markdown renderer, and one shiki instance.
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives'],
  legalComments: 'inline', minify: false,
})
const source = browser.outputFiles[0]?.text
if (!source) throw new Error('Client build produced no JavaScript')
await mkdir('lib', { recursive: true })
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:'@local/dsh-remote-room',factory(require){const module={exports:{}};const exports=module.exports;\n${source}\nreturn module.exports;}});\n`)
