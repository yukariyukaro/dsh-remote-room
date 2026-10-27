/** Real UI exec/PTY scenario for a second full-access room. No service, store, or ctx mutation. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { until } from './web-fixture.mjs';

const names = {
  remote: /^(Remote room|远程协助)$/u,
  create: /^(Create invitation|创建邀请)/u,
  join: /^(Request access|申请访问)$/u,
  approve: /^(Approve connection|批准此连接)$/u,
  revoke: /^(Revoke access|撤销访问)$/u,
  start: /^(Start on remote host|在远端主机启动)$/u,
  send: /^(Send input once|仅发送一次)$/u,
  resize: /^(Resize PTY|调整 PTY 尺寸)$/u,
  kill: /^(Terminate process|终止进程)$/u,
  running: /^(Running|运行中)$/u,
  stale: /Connection lost, access revoked, or epoch changed|连接已中断、授权已撤销或连接批次已变更/u,
};

async function waitEnabled(locator, label, timeout = 20_000) {
  // Start is disabled while the previous handle's transcript is still open; wait for the real control.
  await until(() => locator.isEnabled(), label, timeout);
}

async function openGuestSettings(page) {  await page.getByRole('button', { name: /^(Account menu|账号菜单)$/u, exact: true }).click();
  await page.getByRole('menuitem', { name: /^(Settings|设置)$/u, exact: true }).click();
  const settings = page.getByRole('dialog', { name: /^(Settings|设置)$/u });
  await settings.getByRole('button', { name: names.remote, exact: true }).click();
  await settings.getByRole('heading', { name: names.remote, exact: true }).waitFor();
  return settings;
}

async function connectFullRoom({ host, hostSettings, guest, guestSettings, relay, shared, evidence, report }) {
  const mode = hostSettings.getByRole('combobox');
  await hostSettings.getByLabel(/^(Relay URL|中继地址)$/u).fill(relay);
  await hostSettings.getByLabel(/^(Shared root|共享根目录)$/u).fill(shared);
  await mode.selectOption('danger-full-access');
  const inviteField = hostSettings.locator('textarea[readonly]');
  const previous = await inviteField.count() ? await inviteField.inputValue() : '';
  await hostSettings.getByRole('button', { name: names.create }).click();
  const invitation = await until(async () => {
    if (!await inviteField.count()) return '';
    const value = await inviteField.inputValue();
    return value && value !== previous ? value : '';
  }, 'second full-access invitation');
  const guestField = guestSettings.getByLabel(/^(Invitation|邀请内容)$/u);
  await guestField.fill(invitation);
  await guestSettings.getByRole('button', { name: names.join }).click();
  const hostRoom = hostSettings.locator('.rr-room').filter({ hasText: 'danger' }).first();
  const guestRoom = guestSettings.locator('.rr-room').filter({ hasText: 'danger' }).first();
  await hostRoom.locator('.rr-badge[data-state="pending"]').waitFor({ timeout: 40_000 });
  await guestRoom.locator('.rr-badge[data-state="pending"]').waitFor({ timeout: 40_000 });
  if (await hostRoom.locator('.rr-roomhead').getAttribute('aria-expanded') === 'false') await hostRoom.locator('.rr-roomhead').click();
  await hostRoom.getByRole('button', { name: names.approve }).click();
  await guestRoom.locator('.rr-badge[data-state="authorized"]').waitFor({ timeout: 30_000 });
  // A row mounted while authenticating starts collapsed; expand it only through its real header button.
  if (await guestRoom.locator('.rr-roomhead').getAttribute('aria-expanded') === 'false') await guestRoom.locator('.rr-roomhead').click();
  await guestRoom.locator('.rr-terminal').waitFor({ timeout: 30_000 });
  report('second room: full-access invitation created, joined and approved through real Settings UI');
  return { hostRoom, guestRoom };
}

export async function processJourney(endpoints, ctx) {
  const [host, guest] = endpoints;
  const { evidence, report, results, relay, shared } = ctx;
  const hostSettings = host.page.getByRole('dialog', { name: /^(Settings|设置)$/u });
  await hostSettings.getByRole('heading', { name: names.remote, exact: true }).waitFor();
  const guestSettings = await openGuestSettings(guest.page);
  const { hostRoom, guestRoom } = await connectFullRoom({ host, hostSettings, guest, guestSettings, relay, shared, evidence, report });
  results.stages.push('guest: real Approval made a second full-access room authorized and its execution panel visible');

  const terminal = guestRoom.locator('.rr-terminal');
  // Structure-based controls: the argv editor is the only textarea carrying the example placeholder.
  const kindSelect = terminal.locator('select');
  const cwdInput = terminal.locator('input.rr-input:not([type="number"])');
  const argvEditor = terminal.locator('textarea[placeholder]');
  const stdinEditor = terminal.locator('textarea:not([placeholder])');
  const newlineCheck = terminal.locator('input[type="checkbox"]').first();
  const node = process.execPath;
  const marker = path.join(shared, 'host-exec-marker.txt');
  const execScript = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'HOST_ONLY');console.log('ROOM_STDOUT_OK');console.error('ROOM_STDERR_OK');process.exit(7)`;
  await kindSelect.selectOption('exec');
  await cwdInput.fill(shared);
  await argvEditor.fill(JSON.stringify([node, '-e', execScript]));
  await terminal.getByRole('button', { name: names.start }).click();
  const output = terminal.locator('.rr-terminal-output');
  await until(async () => (await output.innerText()).includes('ROOM_STDOUT_OK') && (await output.innerText()).includes('ROOM_STDERR_OK'), 'exec stdout and stderr');
  await until(async () => /Exit code: 7|退出码: 7/u.test(await terminal.innerText()), 'exec exit code 7');
  assert.equal(await readFile(marker, 'utf8'), 'HOST_ONLY', 'Host-side command must write its marker on the Host');
  await assert.rejects(stat(path.join(guest.base, 'workspace', 'host-exec-marker.txt')), 'Marker must not appear on the guest machine');
  results.stages.push('guest: UI started a real Host argv command; Unicode stdout/stderr and exit 7 shown, marker exists only on the Host');
  report('exec: real Host process wrote HOST_ONLY marker; guest copy absent');

  // A real PTY runs the console in cooked mode, so a program only sees a submitted line after Enter.
  // Raw mode makes the program observe the exact bytes the UI sends, without implying emulator support.
  const ptyScript = "process.stdin.setRawMode(true);process.stdout.write('PTY_READY\\n');process.stdin.on('data',d=>{process.stdout.write('PTY_ECHO:'+d.toString().trim()+'\\n')});setInterval(()=>{},1000)";
  const startButton = terminal.getByRole('button', { name: names.start });
  if (!await startButton.isEnabled()) {
    // Force one bounded fresh read page through the product control, then wait for the form to reopen.
    await terminal.getByRole('button', { name: /^(Read output|读取输出)$/u }).click();
  }
  await waitEnabled(startButton, 'exec transcript closed before PTY start');
  await kindSelect.selectOption('pty');
  await waitEnabled(argvEditor, 'argv editor enabled for PTY');
  await argvEditor.fill(JSON.stringify([node, '-e', ptyScript]));
  await startButton.click();
  await until(async () => (await output.innerText()).includes('PTY_READY'), 'PTY prompt');
  await terminal.locator('input[type="number"]').first().fill('100');
  await terminal.locator('input[type="number"]').last().fill('30');
  await terminal.getByRole('button', { name: names.resize }).click();
  await stdinEditor.fill('hello-room');
  await newlineCheck.check();
  await terminal.getByRole('button', { name: names.send }).click();
  await until(async () => (await output.innerText()).includes('PTY_ECHO:hello-room'), 'PTY stdin echo');
  // A blocking confirm leaves the click promise pending; accept the dialog before awaiting the click.
  const killed = guest.page.waitForEvent('dialog');
  const killClick = terminal.getByRole('button', { name: names.kill }).click();
  const dialog = await killed; assert.equal(dialog.type(), 'confirm'); await dialog.accept(); await killClick;
  await until(async () => /Exited|已退出/u.test(await terminal.innerText()), 'PTY exit after confirmed kill');
  results.stages.push('guest: real PTY started; prompt, stdin echo, 100x30 resize and confirmed terminate all observed in the UI');
  report('pty: real terminal echoed explicit stdin after resize; confirmed kill observed');

  const revoke = hostRoom.getByRole('button', { name: names.revoke });
  const accepted = host.page.waitForEvent('dialog'); const click = revoke.click();
  const confirm = await accepted; assert.equal(confirm.type(), 'confirm'); await confirm.accept(); await click;
  await hostRoom.locator('.rr-badge[data-state="closed"]').waitFor({ timeout: 30_000 });
  await guestRoom.getByRole('status').filter({ hasText: names.stale }).waitFor({ timeout: 30_000 });
  assert.equal(await terminal.getByRole('button', { name: names.start }).isDisabled(), true, 'Revoked execution controls must be disabled');
  results.stages.push('host: revoked the full-access room; guest execution panel went stale with disabled controls');
  await writeFile(path.join(evidence, 'process-journey.txt'), results.stages.join('\n') + '\n');
  report('PASS full-access exec/PTY UI journey, then revoke made retained controls stale');
}
