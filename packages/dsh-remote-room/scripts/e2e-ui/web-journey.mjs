/** Real DOM interactions shared by the owned Web fixtures. No service/store/ctx mutation. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { until } from './web-fixture.mjs';

const names = {
  plugins: /^(Plugins|插件)$/u,
  add: /^(Add plugin|添加插件)$/u,
  spec: /^(Package name or address|Package or address|包名或地址)$/u,
  install: /^(Install|安装)$/u,
  enable: /^(Enable now|立即启用)$/u,
  settings: /^(Settings|设置)$/u,
  remote: /^(Remote room|远程房间)$/u,
};

export async function maskedScreenshot(page, file) {
  // Never persist invitations, including the read-only host invitation and the guest draft.
  await page.screenshot({ path: file, fullPage: true, mask: [page.locator('textarea'), page.locator('.rr-invite')], maskColor: '#555555' });
}

export async function dismissFreshWebWelcome(page) {
  // Fresh Web homes show the preview notice. Native Desktop may not; its driver must omit this helper.
  await page.getByRole('heading', { name: /^(Preview Notice|预览版说明|预览提示)$/u }).waitFor();
  await page.getByRole('button', { name: /^(Continue|继续)$/u, exact: true }).click();
  const welcome = page.getByRole('dialog', { name: /^(Get started|开始使用)$/u });
  await welcome.getByRole('button', { name: /^(Close|关闭)$/u, exact: true }).click();
  await welcome.waitFor({ state: 'hidden' });
}

export async function installAndEnable(endpoint, packagePath, { report, evidence, results }) {
  const { page, label } = endpoint;
  await page.getByRole('button', { name: names.plugins, exact: true }).click();
  await page.getByRole('button', { name: names.add, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: names.spec }).fill(packagePath);
  await maskedScreenshot(page, path.join(evidence, `${label}-install-input.png`));
  report(`${label}: submitted local Host tarball through Plugins Add textbox + Install`);
  await dialog.getByRole('button', { name: names.install, exact: true }).click();
  await dialog.getByRole('button', { name: names.enable, exact: true }).waitFor({ timeout: 150_000 });
  await maskedScreenshot(page, path.join(evidence, `${label}-installed-disabled.png`));
  results.stages.push(`${label}: UI install completed and Enable now visible`);
  await dialog.getByRole('button', { name: names.enable, exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  report(`${label}: clicked Enable now`);
}

/** The Settings surface is the modal currently on screen; newer builds drop its accessible name. */
function settingsDialog(page) {
  return page.getByRole('dialog').last();
}

export async function openRemoteSettings(page) {
  const dialog = settingsDialog(page);
  const panel = dialog.locator('.rr');
  // The runner already opens this surface once per endpoint; reuse it instead of clicking through a modal mask.
  const open = panel.locator('.rr-stage').first();
  if (await open.count() && await open.isVisible().catch(() => false)) return panel;
  await page.getByRole('button', { name: /^(Account menu|账号菜单)$/u, exact: true }).click();
  await page.getByRole('menuitem', { name: names.settings, exact: true }).click();
  await settingsDialog(page).getByRole('button', { name: names.remote, exact: true }).click();
  await settingsDialog(page).locator('.rr-stage').waitFor({ timeout: 30_000 });
  return settingsDialog(page).locator('.rr');
}

async function openWorkbench(endpoint) {
  const { page } = endpoint;
  const settings = settingsDialog(page);
  await settings.getByRole('button', { name: /^(Close|关闭)$/u, exact: true }).click();
  await settings.waitFor({ state: 'hidden' });
  // Use the application's New Session gesture, never create a session through a service call.
  await page.getByRole('button', { name: /^(New session|新建会话)$/u, exact: true }).first().click();
  // New Session starts collapsed; wait for its real toggle rather than a racy isVisible probe.
  await page.getByRole('button', { name: /^(Open right sidebar|展开右侧栏)$/u }).click();
  await page.locator('[data-sidebar-right-guide-entry="remote-room"]').click();
  const pane = page.locator('[data-rightbar-col]');
  await pane.locator('.rr-stage').waitFor({ timeout: 30_000 });
  return pane;
}

async function capturePalettes(endpoint, preview, { evidence, results }) {
  const { page } = endpoint;
  const visuals = [];
  for (const [palette, label] of [['dark', /^(Dark|深色)$/u], ['light', /^(Light|浅色)$/u]]) {
    await page.getByRole('button', { name: /^(Account menu|账号菜单)$/u }).click();
    await page.getByRole('menuitem', { name: names.settings, exact: true }).click();
    const settings = settingsDialog(page);
    await settings.getByRole('button', { name: /^(General|通用设置)$/u, exact: true }).click();
    await settings.getByRole('button', { name: label, exact: true }).click();
    await until(() => page.locator('body').evaluate((element, dark) => element.hasAttribute('data-ds-dark-theme') === dark, palette === 'dark'), `actual ${palette} theme DOM`);
    await settings.getByRole('button', { name: /^(Close|关闭)$/u, exact: true }).click();
    await settings.waitFor({ state: 'hidden' });
    await maskedScreenshot(page, path.join(evidence, `guest-preview-${palette}-1440.png`));
    visuals.push({ palette, viewport: 1440, themeObserved: true });
  }
  await page.setViewportSize({ width: 1100, height: 1000 });
  // The remote tab must be the visible one: the local file tab may own the pane.
  await page.locator('[data-dockkit-tab]').filter({ hasText: 'shared.txt' }).first().click();
  await preview.locator('[data-rr-renderer="code"]').waitFor();
  await maskedScreenshot(page, path.join(evidence, 'guest-preview-light-1100.png'));
  visuals.push({ palette: 'light', viewport: 1100, themeObserved: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  results.visuals = visuals;
}

/**
 * Open the guest's OWN copy of the same basename through the built-in Files tab,
 * so a local preview and the remote preview coexist with distinct content.
 */
async function openLocalCopy(guest) {
  const { page } = guest;
  // The '+' control opens the guide; the shipped `files` entry is the local workspace door.
  await page.getByRole('button', { name: /^(New tab|新标签页)$/u, exact: true }).first().click();
  await page.locator('[data-sidebar-right-guide-entry="files"]').first().click();
  await page.locator('[data-files-body]').first().waitFor();
  const root = await page.locator('[data-files-root]').first().getAttribute('data-files-root');
  // The local door must expose only the guest's own fixture home, never the Host tree.
  assert(root && path.resolve(root).toLowerCase().startsWith(path.resolve(guest.base).toLowerCase()), 'Local Files tab must stay inside the guest fixture home');
  const local = path.join(root, 'shared.txt');
  await writeFile(local, 'guest-local-seed-2026\n');
  await page.locator('[data-files-reload]').first().click();
  const item = page.locator('[data-files-entry="file"]').filter({ hasText: 'shared.txt' }).first();
  await item.waitFor();
  await item.click();
  const localBody = page.locator('[data-textpreview-url^="dsh-resource://file/"]').first();
  await localBody.filter({ hasText: 'guest-local-seed-2026' }).waitFor();
  return { localBody, root, local };
}

export async function businessJourney(endpoints, { root, evidence, report, results, secrets, resources, visual, processes, coexist = true, shot = maskedScreenshot }) {
  const [host, guest] = endpoints;
  // The suite talks to the deployed public relay: sharing targets separate networks.
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const relayUrl = process.env.RR_PUBLIC_RELAY ?? '';
  const relayToken = process.env.RR_RELAY_TOKEN ?? '';
  if (!relayUrl.startsWith('wss://')) throw new Error('Set RR_PUBLIC_RELAY to the deployed wss relay before running the journey');
  if (relayToken === '') throw new Error('Set RR_RELAY_TOKEN to the relay creation token before running the journey');
  report(`relay: ${relayUrl}`);
  const seed = 'remote-ui-golden-seed-2026\n';
  const shared = path.join(host.base, 'workspace');
  await writeFile(path.join(shared, 'shared.txt'), seed);
  // A Markdown document with a table, a fenced block, and a relative image: the
  // renderer must be DSH's own, and the image must come from the Host, not this disk.
  await writeFile(path.join(shared, 'guide.md'), [
    '# Remote guide',
    '',
    'Marker: remote-markdown-seed-2026',
    '',
    '| Column | Value |',
    '| --- | --- |',
    '| Origin | host |',
    '',
    '```ts',
    'export const answer = 42',
    '```',
    '',
    '![pixel](media/pixel.png)',
    '',
  ].join('\n'));
  await mkdir(path.join(shared, 'media'), { recursive: true });
  await writeFile(path.join(shared, 'media', 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));

  // Zero input: the deployment relay must already be prefilled, so sharing needs no URL typing.
  const hostPanel = await openRemoteSettings(host.page);
  const relayField = hostPanel.getByPlaceholder(/wss:\/\//u);
  assert.equal(await relayField.inputValue(), relayUrl, 'The public relay must be prefilled from the deployment config');
  const pathInput = hostPanel.getByPlaceholder(/例如/u);
  if (!await pathInput.isVisible().catch(() => false)) await hostPanel.getByRole('button', { name: /^(直接输入路径)$/u }).click();
  await pathInput.fill(shared);
  await hostPanel.getByRole('radio', { name: /^(只读)$/u }).click();
  await shot(host.page, path.join(evidence, 'host-share-home.png'));
  await hostPanel.getByRole('button', { name: /^(生成邀请)$/u }).click();
  const inviteField = hostPanel.locator('textarea[readonly]');
  await until(async () => await inviteField.count() && await inviteField.inputValue(), 'host invitation UI');
  const invitation = await inviteField.inputValue(); secrets.add(invitation);
  assert.match(invitation, /^dsh-room:\/\/join\/v2#/u, 'One-click share must produce a v2 invitation');
  assert.ok(invitation.includes(`relay=${encodeURIComponent(relayUrl)}`), 'The invitation must carry the deployment relay');
  const roomTitle = await hostPanel.locator('.rr-herotext h1').innerText();
  assert.equal(roomTitle, path.basename(shared), 'Room name must be the shared directory name');
  results.stages.push(`host: shared ${path.basename(shared)} with the prefilled public relay (invitation retained in memory only)`);
  report('host: created an invitation through the public relay; room name equals the directory name');

  // Guest: paste the invitation, request access.
  const guestPanel = await openRemoteSettings(guest.page);
  await guestPanel.getByRole('button', { name: /^(加入)$/u }).click();
  await guestPanel.locator('textarea').first().fill(invitation);
  await guestPanel.getByRole('button', { name: /^(申请加入)$/u }).click();

  // Host: the guest arrives as a decision card, not a silent connection.
  await hostPanel.getByText(/^(有人请求进入)$/u).waitFor({ timeout: 40_000 });
  assert.equal(await guestPanel.locator('.rr-tree').count(), 0, 'Pending guest must not render the host file tree');
  await shot(host.page, path.join(evidence, 'host-approval-request.png'));
  await shot(guest.page, path.join(evidence, 'guest-pending.png'));
  results.stages.push('host: guest arrival rendered as an approval card; guest pending shows no file tree');
  await hostPanel.getByRole('button', { name: /^(允许进入)$/u }).click();

  // Guest: authorized, files listed.
  const guestWorkbench = await openWorkbench(guest);
  const tree = guestWorkbench.locator('.rr-tree');
  await tree.getByRole('button', { name: /shared\.txt/u }).waitFor({ timeout: 30_000 });
  results.stages.push('host: UI 允许进入; guest authorized and sees shared.txt');
  const alerts = await guestWorkbench.getByRole('alert').allTextContents();
  if (alerts.length) results.businessAlerts = alerts;
  assert.deepEqual(alerts, [], 'Authorized guest must not retain operation errors');
  await tree.getByRole('button', { name: /shared\.txt/u }).click();
  const preview = guest.page.locator('.rr-preview').filter({ hasText: 'shared.txt' });
  // The body is DSH's own code renderer; assert its text, not a private `<pre>` of ours.
  const remoteBody = preview.locator('[data-rr-renderer="code"]');
  await remoteBody.waitFor();
  await until(async () => (await remoteBody.innerText()).includes('remote-ui-golden-seed-2026'), 'remote seed in the shared code renderer');
  await shot(guest.page, path.join(evidence, 'guest-file-preview.png'));
  results.stages.push('guest: workbench file click; remote source seed visibly previewed');
  report('guest: shared.txt opened and exact seed visible in remote preview');

  // Markdown goes through the same shared renderer: real typography, a GFM table,
  // a highlighted fence, and a relative image fetched from the Host.
  await tree.getByRole('button', { name: /guide\.md/u }).click();
  const markdownPreview = guest.page.locator('.rr-preview').filter({ hasText: 'guide.md' });
  await markdownPreview.locator('[data-rr-renderer="markdown"]').waitFor();
  const document = markdownPreview.locator('.rr-document');
  await document.getByRole('heading', { name: 'Remote guide' }).waitFor();
  assert.equal(await document.locator('table').count(), 1, 'GFM table must render as a table, not source text');
  await until(async () => (await document.innerText()).includes('answer = 42'), 'fenced code inside the shared Markdown renderer');
  await until(async () => await document.locator('img[src^="blob:"]').count() === 1, 'relative Markdown image hydrated from the Host');
  assert.equal(await document.getByText('```').count(), 0, 'Markdown fences must not be shown as raw source');
  await shot(guest.page, path.join(evidence, 'guest-markdown-preview.png'));
  results.stages.push('guest: Markdown rendered by the shared DSH renderer (heading, GFM table, highlighted fence, Host-relative image)');
  report('guest: guide.md rendered as Markdown with table, code and remote image');

  // Reactivate the source tab through its real chip: a backgrounded tab stays mounted but hidden.
  await guest.page.locator('[data-dockkit-tab]').filter({ hasText: 'shared.txt' }).first().click();
  await remoteBody.waitFor();
  // Local/remote coexistence: same basename, different origins and distinct seeds.
  let localFile;
  if (coexist) {
    localFile = await openLocalCopy(guest);
    assert.equal(await guest.page.getByText('remote-ui-golden-seed-2026').count(), 1, 'Remote seed must appear only in the remote preview');
    assert.equal(await guest.page.getByText('guest-local-seed-2026').count(), 1, 'Local seed must appear only in the local preview');
    assert.equal(await localFile.localBody.getByText('remote-ui-golden-seed-2026').count(), 0, 'Local preview must not show remote bytes');
    assert.equal(await preview.locator('.rr-previewbody').getByText('guest-local-seed-2026').count(), 0, 'Remote preview must not show local bytes');
    await shot(guest.page, path.join(evidence, 'guest-local-and-remote-coexist.png'));
    results.stages.push('guest: built-in local Files tab opened the guest workspace copy; local and remote previews coexist with distinct seeds');
    report('guest: local shared.txt preview coexists with the remote preview; no seed cross-contamination');
  }
  if (visual) await capturePalettes(guest, preview, { evidence, results });

  // The copy journey also proves the share panel is Chinese-only: no English UI vocabulary.
  // Previews render owner data (paths, room ids, language chips) and are excluded here.
  const panelText = await guestWorkbench.locator('.rr').first().innerText();
  for (const word of ['Share', 'Join', 'Invitation', 'Permission', 'Relay', 'Approve', 'Revoke', 'Copy', 'Settings', 'Room ', 'Workspace', 'Read only']) {
    assert.equal(panelText.includes(word), false, `The share panel must not show English copy: ${word}`);
  }

  // End the share from the host; the guest keeps a labeled stale snapshot.
  await hostPanel.getByRole('button', { name: /^(结束共享)$/u }).click();
  await guest.page.locator('[data-dockkit-tab]').filter({ hasText: 'shared.txt' }).first().click();
  await preview.getByRole('status').filter({ hasText: /远端身份已变更或访问已结束/u }).waitFor({ timeout: 30_000 });
  assert.equal(await preview.getByRole('button', { name: /^(重新读取|Reload file)$/u }).isDisabled(), true, 'Revoked preview must disable reload');
  if (localFile) {
    await guest.page.locator('[data-dockkit-tab]').filter({ hasText: 'shared.txt' }).last().click();
    assert.equal(await localFile.localBody.getAttribute('data-textpreview-state'), 'text', 'Local preview must stay readable after revoke');
    assert.equal(await localFile.localBody.getByText('guest-local-seed-2026').count(), 1, 'Local preview keeps its own bytes after revoke');
  }
  await shot(guest.page, path.join(evidence, 'guest-revoked-preview.png'));
  results.stages.push('host: 结束共享; guest retained snapshot labeled stale and reload disabled');
  report('PASS UI 一键共享/加入/允许/远端预览/结束共享 (read-only, no model call or UI editing)');
  if (processes) {
    // The exec/PTY journey still drives the pre-0.3 form; port it before claiming that coverage.
    throw new Error('--processes has not been ported to the one-click share UI yet');
  }
}
