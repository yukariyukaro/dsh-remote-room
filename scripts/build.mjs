import { build as tsdown } from 'tsdown'
import { build as esbuild } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

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

// The local relay ships beside the Host entry so a share needs no second process or install step.
// Its own sources keep NodeNext `.js` specifiers, so TypeScript files are resolved explicitly here.
const relay = await esbuild({
  entryPoints: ['relay/src/server.ts'], bundle: true, write: false,
  format: 'esm', platform: 'node', target: 'node24',
  external: ['ws'],
  plugins: [{
    name: 'relay-typescript-specifiers',
    setup(build) {
      build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, args => {
        const candidate = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'))
        return existsSync(candidate) ? { path: candidate } : undefined
      })
    },
  }],
})
const relaySource = relay.outputFiles[0]?.text
if (!relaySource) throw new Error('Relay build produced no JavaScript')
await writeFile('lib/local-relay.mjs', relaySource)
