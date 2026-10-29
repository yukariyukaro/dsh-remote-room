import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The published entry is lib/index.js, so the package root is one level up. Both the
// guide and the original sources ship in the tarball: an installed agent can read the
// narrative guide and then follow it into src/ without this plugin injecting anything
// into the system prompt.
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const guidePath = join(packageRoot, 'GUIDE.md')
const sourceRoot = join(packageRoot, 'src')

function manifest(): { name: string; version: string } {
  try {
    const value = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    return { name: typeof value.name === 'string' ? value.name : '@yukariyukaro/dsh-remote-room', version: typeof value.version === 'string' ? value.version : 'unknown' }
  } catch {
    return { name: '@yukariyukaro/dsh-remote-room', version: 'unknown' }
  }
}

/** Level-1 and level-2 headings make the guide indexable without reading the whole file. */
function outline(): string[] {
  try {
    return readFileSync(guidePath, 'utf8')
      .split('\n')
      .filter(line => /^#{1,2} /u.test(line))
      .map(line => line.replace(/^#+ /u, '').trim())
  } catch {
    return []
  }
}

const output = {
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      source: { type: 'string', const: 'remote-room', required: true },
      package: { type: 'string', required: true },
      version: { type: 'string', required: true },
      guide: { type: 'string', required: true },
      sourceRoot: { type: 'string', required: true },
      headings: { type: 'array', items: { type: 'string' }, required: true },
    },
  },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

/**
 * Register the documentation locator. It returns paths only: reading the guide stays an
 * explicit local-tool call, so the plugin adds no tokens to every prompt.
 * @param ctx - host context carrying the tool registry.
 */
export function registerGuideTool(ctx: Context): () => void {
  return ctx.tools.register(defineTool({
    name: 'remote_room_guide',
    description: 'Locate the shipped dsh-remote-room guide and sources. Returns the absolute path of GUIDE.md (install prompts for non-technical users, owner/guest flow, permission tiers, relay, troubleshooting, upgrade/uninstall) plus the source tree with a per-file index. Read those paths with the local read/glob tools when a question touches this plugin; nothing is injected into the prompt.',
    parameters: {},
    output,
    isConcurrencySafe: () => true,
    async execute() {
      const { name, version } = manifest()
      return { source: 'remote-room' as const, package: name, version, guide: guidePath, sourceRoot, headings: outline() }
    },
  }))
}
