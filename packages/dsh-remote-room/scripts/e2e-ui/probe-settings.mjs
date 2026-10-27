/** Throwaway probe: dump the rc.4 Settings dialog surface so the journey can target it. */
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { OwnedProcesses, isolatedEnvironment, ownLaunchURL, prepareBase, until } from './web-fixture.mjs'

const cli = process.argv[2]
if (!cli) throw new Error('usage: probe-settings.mjs <cli>')
const root = await mkdtemp(path.join(tmpdir(), 'dsh-probe-'))
const base = path.join(root, 'endpoint')
await prepareBase(base)
const processes = new OwnedProcesses(message => console.log(`[probe] ${message}`), value => value)
const server = await chromium.launchServer({ headless: false, env: isolatedEnvironment(path.join(root, 'browser')), timeout: 30000 })
processes.adopt(server.process(), 'probe Chromium')
try {
  const child = processes.start(cli, ['--profile', 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], isolatedEnvironment(base), path.join(base, 'workspace'), 'probe Web')
  const launch = await ownLaunchURL(child, new Set())
  const browser = await chromium.connect(server.wsEndpoint())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  await page.goto(launch.href)
  await page.waitForURL(url => url.origin === launch.origin && !url.searchParams.has('token'))
  const notice = page.getByRole('button', { name: /^(Continue|继续)$/u, exact: true })
  if (await notice.count()) await notice.click()
  const { dismissFreshWebWelcome } = await import('./web-journey.mjs')
  await dismissFreshWebWelcome(page)
  await page.getByRole('button', { name: /^(Account menu|账号菜单)$/u, exact: true }).click()
  await page.getByRole('menuitem', { name: /^(Settings|设置)$/u, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await until(async () => (await dialog.innerText()).length > 0, 'settings dialog text')
  const buttons = await dialog.locator('button, [role="tab"], a').evaluateAll(nodes => nodes.slice(0, 80).map(node => `${node.getAttribute('role') ?? node.tagName.toLowerCase()}|${(node.getAttribute('aria-label') ?? node.textContent ?? '').trim().slice(0, 40)}`))
  console.log('DIALOG BUTTONS:', JSON.stringify(buttons, null, 1))
  const nav = await dialog.locator('[data-settings-nav], nav, [role="tablist"]').first().evaluateAll(nodes => nodes.map(node => node.outerHTML.slice(0, 400)))
  console.log('NAV HTML:', JSON.stringify(nav, null, 1))
  await page.screenshot({ path: path.join(root, 'settings.png'), fullPage: true })
  console.log('screenshot', path.join(root, 'settings.png'))
  await context.close()
} finally {
  await server.close()
  await processes.stopAll()
}
