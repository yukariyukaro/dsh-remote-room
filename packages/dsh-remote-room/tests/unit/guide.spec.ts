import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerGuideTool } from '../../src/guide.ts'

interface Registered {
  name: string
  description: string
  execute: (args: unknown, exec?: unknown) => Promise<unknown>
}

function capture(): { tool: Registered; disposed: () => boolean } {
  let tool: Registered | undefined
  let disposed = false
  const ctx = {
    tools: {
      register(definition: Registered) {
        tool = definition
        return () => { disposed = true }
      },
    },
  }
  const dispose = registerGuideTool(ctx as never)
  dispose()
  if (!tool) throw new Error('guide tool was not registered')
  return { tool, disposed: () => disposed }
}

describe('remote_room_guide / shipped documentation locator', () => {
  it('registers exactly one tool and disposes it', () => {
    const { tool, disposed } = capture()
    expect(tool.name).toBe('remote_room_guide')
    expect(tool.description).toContain('GUIDE.md')
    expect(disposed()).toBe(true)
  })

  it('points at files that actually ship with the package', async () => {
    const { tool } = capture()
    const value = await tool.execute({}) as {
      source: string; package: string; version: string; guide: string; sourceRoot: string; headings: string[]
    }
    expect(value.source).toBe('remote-room')
    expect(value.package).toBe('@yukariyukaro/dsh-remote-room')
    expect(value.version).toMatch(/^\d+\.\d+\.\d+/u)
    expect(existsSync(value.guide)).toBe(true)
    expect(existsSync(join(value.sourceRoot, 'index.ts'))).toBe(true)
    expect(existsSync(join(value.sourceRoot, 'guide.ts'))).toBe(true)
    expect(value.headings.length).toBeGreaterThan(3)
    expect(value.headings.some(heading => heading.includes('安装'))).toBe(true)
  })

  it('keeps the guide aligned with the published package name and settings label', () => {
    const guide = readFileSync(join(import.meta.dirname, '..', '..', 'GUIDE.md'), 'utf8')
    expect(guide).toContain('@yukariyukaro/dsh-remote-room')
    expect(guide).toContain('远程工作区')
    expect(guide).toContain('docs/relay-deploy.md')
    expect(guide).toContain('src/host')
    expect(guide).toContain('src/guest')
    // The guide is reference material, not a prompt pack: keep the invitation shape and
    // protocol facts, and keep operator scripts out of the published package.
    expect(guide).toContain("dsh-room://join/v2")
    expect(guide).toContain('VERSION_MISMATCH')
    expect(guide).toContain('auditBackend')
    expect(guide).not.toContain('我不懂电脑')
    expect(guide).not.toContain('请在这台电脑上开一个远程房间')
  })
})
