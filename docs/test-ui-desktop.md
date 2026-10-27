# Packaged Desktop isolated UI discovery

This runner is separate from the Web runner and does not change packaged runtime files. Its scope is one fresh native Desktop window: dual isolation, owned CDP discovery, credential-free onboarding if offered by visible UI, Settings/Plugins navigation, and verified owned-process shutdown. Without `--package` it is discovery only; with an explicit artifact and digest it additionally tests real UI installation/enabling. It is not the remote-room business journey.

## Run

Use ordinary Node >=24.9 and the repository's `playwright` dev dependency. `connectOverCDP` attaches to the application's renderer and does not require a downloaded Chromium binary.

```powershell
$node = 'C:\Users\J\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node scripts/e2e-ui-desktop.mjs --help
& $node scripts/e2e-ui-desktop.mjs --dry-run
& $node scripts/e2e-ui-desktop.mjs
# Optional executable override:
& $node scripts/e2e-ui-desktop.mjs --exe 'D:\J\dsh\DeepSeek Harness.exe'
```

`--help` and `--dry-run` never launch Desktop. There is no option to attach to an existing CDP endpoint, select an existing profile, or disable authentication. Only one Desktop fixture runs at a time. Do not run a second fixture until the first reports completed cleanup.

## Isolation and evidence

- A unique `dsh-room-desktop-report-*` temp directory owns a fresh `fixture` directory. Its home, agents, Electron userData, OS home/AppData, npm config/cache, temp and cwd are all distinct owned locations. No user profile is copied or read.
- The launcher passes native `--user-data-dir=<owned>` and `--remote-debugging-port=0` directly to the `.exe`. Its environment is an explicit OS allowlist plus owned paths. It never inherits `ELECTRON_RUN_AS_NODE`, Node hooks, DSH profile variables, model keys or proxy credentials. The product may itself launch its Host in Electron Node mode.
- The only CDP discovery sources are stderr from that spawned child and `DevToolsActivePort` inside its fresh userData. Endpoint validation requires `ws://127.0.0.1:<ephemeral>/devtools/browser/...`; the live GUI port 53420 is rejected. There is no fallback to 9222, another app or live GUI.
- The runner verifies `/json/version`, waits for `dsh-app://app/`, and attaches with Playwright `chromium.connectOverCDP`. It selects only the main application page, never the first arbitrary target. Exiting as a second instance fails with no retry.
- Onboarding and navigation use real locator clicks. No `dshOnboarding`, `remote`, `ctx`, pre-written profile or private API injects configuration. No model key is supplied. A required login/key without a visible skip is an explicit failure/gap, not a skip counted green.
- Screenshots fail closed if rendered text contains invitation/credential indicators or any editable field has a nonempty value. This discovery never fills forms. Native `Page.captureScreenshot` captures the owned renderer without Playwright's screenshot masking pipeline; two sequential experiments observed that pipeline time out specifically after entering Plugins. No trace, HAR, raw stderr, complete authentication URLs, endpoint IDs, cookies, invitation or credential contents are written. Reports include only safe UI labels and selected process facts.
- Windows CIM snapshots read PID, parent PID, creation time and executable path, not process command lines or environments. The process tree is rooted in the exact spawned PID and executable/createTime identity. Only already-owned descendants receive a boolean Host-entry check; their arguments are not printed or persisted.

## Teardown semantics

The runner sends browser-level `Browser.close`. This is teardown, **not a tested Quit-menu click**. It gives the native shell and tracked descendants 30 seconds to stop, verifies PID/createTime identities, then confirms its CDP endpoint is no longer available. Window X or `page.close()` is not used as evidence of exit.

If graceful quit fails, a fresh identity check precedes `Stop-Process -Id <ownedPID> -Force` for each recorded surviving descendant. There is no process-name kill and no killing unrelated Web fixtures. Forced cleanup makes the lifecycle result fail. An unconfirmed cleanup retains fixture data and fails. Data deletion requires an exact realpath match to the owned fixture, all tracked processes stopped, and CDP unavailable. Safe reports/screenshots remain outside the deleted fixture.

## Measured execution

Source-design references are in [testing-ui-design.md](testing-ui-design.md). That design reads reference commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`; installed manifest is Desktop `0.2.1-rc.3`, build commit `be72761ee1a6736ebcdf4f3739363b083ae53c98`, clean. These differ; reference-source support is not an installed-runtime test result.

First actual run, 2026-10-26 23:10:38–23:11:03 Asia/Shanghai, used Node `v24.21.0` and executable SHA-256 `fd7d298f4ba03ee9bab1719a892afeaef5c09bf50c574a592a64c85f64574c0c`. Native switches were accepted, stderr supplied owned ephemeral CDP, `/json/version` reported `Chrome/152.0.7977.130`, and `dsh-app://app/` was interactive with a fresh `profiles/desktop`. No onboarding/key wall appeared: the fresh main page displayed `Select model` and the Plugins entry; Plugins was actually clicked. Overall run **failed** because the post-click screenshot exceeded 7 seconds; that run does not claim a verified Plugins page or Host identification. Browser.close teardown was graceful, native PID 25788 exited 0, all tracked descendants stopped, CDP was unavailable, and the owned fixture was removed. Report: `C:\Users\J\AppData\Local\Temp\dsh-room-desktop-report-xYhwPt\report.json`; safe initial screenshot: `01-initial.png` in that directory. Second sequential run (`dsh-room-desktop-report-SHQL4H`, native PID 49944) increased the screenshot budget to 30 seconds and disabled animations. It verified the Plugins page's Add plugin button, but Playwright screenshot capture still timed out after fonts loaded. Third run (`dsh-room-desktop-report-xhQg8F`, native PID 644) used direct renderer `Page.captureScreenshot`; initial capture succeeded, but capture after entering Plugins also timed out at 15 seconds. Both experiments exited overall 1 and completed graceful Browser.close cleanup with root exit 0, no tracked descendants, unavailable owned CDP, and removed fixture. No fixtures overlapped.

The final runner requires the initial safe native screenshot and Add plugin visible DOM assertion. A subsequent screenshot timeout is explicitly reported as a capture evidence gap, not hidden or retried; other screenshot safety/errors still fail. Owned Host identification is performed before that optional capture, so screenshot mechanics do not prevent validating its later exit.

### Final measured run: passed

Final command was the actual-run command above, preceded by `node --check scripts/e2e-ui-desktop.mjs`. It exited **0** at 2026-10-26 23:18:17–23:18:55 Asia/Shanghai. `--help` and `--dry-run` also executed successfully; neither substituted for this native run.

| Stage | Actual result |
| --- | --- |
| Native launch / attach | Passed. Top-level native PID **55668**, fresh dual-isolated data roots, no `ELECTRON_RUN_AS_NODE`, owned stderr endpoint, ephemeral port 49721, `Chrome/152.0.7977.130`, main target `dsh-app://app/`. |
| Fresh profile / no-key access | Passed. Owned `home/profiles/desktop` created. This installed version went straight to main UI with Select model; no onboarding dialog, login or key was required to reach Plugins. No skip was injected or needed. |
| Visible UI navigation | Passed. Real Plugins button click; Add plugin button visible. Both initial native main screen and Plugins screen were captured and visually inspected. Plugins screenshot shows native Application/Edit menus, Plugins title, Add plugin, built-in plugin settings and experimental plugin list. |
| Host / descendant identity | Passed. CIM identified owned Host **28632**, parent **55668**, creation `2026-10-26T15:18:20.5325550Z`; only a boolean entry-name match was retained. |
| Install / enable | `not-run`. Merely seeing Add plugin is not an installation result. |
| Remote-room UI journey | `not-run`. |
| Teardown | **Graceful** browser-level CDP Browser.close, root exit **0**; Host and all tracked descendant PID/createTime identities absent; owned CDP unavailable; no force used; fixture removed. This is not UI Quit coverage. |

Final report directory: `C:\Users\J\AppData\Local\Temp\dsh-room-desktop-report-fakftN`.

- `report.json`: launch, UI, owned process identities and teardown facts.
- `01-initial.png`: safe 1920×1233 native initial UI, SHA-256 `93deb1dde95b712b4d67ce145dcd73c2a1b524fe7b27d5cb16b2ca129a13b9a8`.
- `02-plugins.png`: safe 1920×1233 real Plugins UI, SHA-256 `3ee15c241d6c3c94c72d438fbaf1a8361e6261178b7f9d2cb12b4b9b1ccda76c`.

No screenshot gap occurred in the final run. Moving owned-Host checks before the initial screenshot also allowed more startup time, so the data does not establish which timing/rendering detail caused earlier capture hangs. Earlier failures remain recorded above rather than being relabeled successful. All four background native runs were collected, and each reported graceful cleanup before the next launched. No live GUI/profile interaction occurred.

## Native installation extension (0.1.3)

The runner now accepts `--package <absolute-or-relative.tgz> --sha256 <exact-lowercase-digest>`. It checks the hash, copies the artifact to its owned fixture, fills the actual Plugins / Add plugin textbox, clicks Install then Enable now, opens Account menu / Settings / Remote room, and asserts the live-update label plus empty-room state. No CLI/API installation substitutes for those clicks.

Actual run `2026-10-26T15:26:57Z`–`15:28:23Z` passed, exit **0**: `C:\Users\J\AppData\Local\Temp\dsh-room-desktop-report-RiaRBW\report.json`. Artifact 0.1.3 SHA-256 `076745b703c3949880ef4c767cf0b2e8e161dc8297a31416d81840907b44be04`. Native PID 55592, Host PID 7684; root exit 0, all tracked descendants gone, CDP unavailable, fixture deleted without force. The initial screenshot succeeded; Plugins and installed-state screenshots timed out. These are explicit screenshot evidence gaps, not skipped DOM assertions. An earlier extension run reached the same successful UI assertions but exited 1 because the final capture was then mandatory; its report remains `dsh-room-desktop-report-b35oqd`.

The label by itself does **not** establish working event streaming: the later dual-Web journey found the 0.1.3 GET event route returned 400 despite a successful initial state read. Version 0.1.4 fixes the request-body registration. This native result is installation/settings evidence only, not a remote-room connection pass.

A second native run of 0.1.4 also passed, exit **0**: `2026-10-26T15:41:27Z`–`15:42:43Z`, report `C:\Users\J\AppData\Local\Temp\dsh-room-desktop-report-PVKjo0\report.json`. It adds an explicit custom-scheme `GET /api/remote-room/events` assertion: status **200**, content-type **text/event-stream**, not just the live-label check. Native PID 8316 / Host PID 51528 stopped gracefully; tracked descendants absent, CDP unavailable, fixture deleted. Initial and Plugins images succeeded; installed-state capture still timed out. Artifact SHA-256 `c80f9e18c18e9d3a6260ea4d5f224d5a005e33d13b3d2b8c3465ea2c9ca84d0e`.

## Final artifact (0.1.7)

The shipped tarball `artifacts/local-dsh-remote-room-0.1.7.tgz` (SHA-256 `24dbd611dffde1532ebf1b23089e19fb3119e970c5ef7fc46dea9114652cdc77`) was verified on the native window in `--mode mixed`, which also performs the real UI tarball Install → Enable now → Settings / Remote room (empty) before pairing. Native exit **0**, report `C:\Users\J\AppData\Local\Temp\dsh-room-desktop-report-K4UWCU\report.json`, custom-scheme events **200 `text/event-stream`**, tracked descendants gone after browser-level `Browser.close`, CDP unavailable, fixture deleted without force.

An earlier standalone install run of `0.1.6` (`dsh-room-desktop-report-yq3djy`) passed the same native assertions; `0.1.6`'s tarball was later rebuilt and deleted, so only `0.1.7` is shipped.

- Real UI tarball Install → Enable now → Settings / Remote room (empty).
- Custom-scheme `GET /api/remote-room/events` observed as **200 `text/event-stream`**.
- Native PID 13324 / Host PID 4552 stopped by browser-level `Browser.close`; tracked descendants gone, CDP unavailable, fixture deleted, no force.
- `01-initial.png` and `02-plugins.png` captured; the installed-state capture again timed out and is recorded as an explicit screenshot gap, not a skipped assertion.

## Cross-carrier pairing (`--mode mixed` / `--mode mixed-guest`)

`--mode mixed` keeps the packaged Desktop window as **Host** with an isolated owned `dsh --profile web` **Guest**; `--mode mixed-guest` reverses it — a Web profile is Host and the packaged Desktop window is the **Guest**. Both run the shared real-UI journey across the two carriers.

Shipped artifact `0.1.7` (SHA-256 `24dbd611dffde1532ebf1b23089e19fb3119e970c5ef7fc46dea9114652cdc77`), both directions **exit 0**:

| Direction | Report | Result |
| --- | --- | --- |
| Desktop Host / Web Guest | `C:\Users\J\AppData\Local\Temp\dsh-room-desktop-report-K4UWCU\report.json` | `mixedJourney: passed native-host / web-guest install/join/approve/preview/revoke` |
| Web Host / Desktop Guest | `C:\Users\J\AppData\Local\Temp\dsh-room-desktop-report-kCRLyL\report.json` | `mixedJourney: passed web-host / native-guest install/join/approve/preview/revoke` |

What the clicks prove in both directions:

- The native window really installs the shipped tarball through Plugins → Add plugin → Install → Enable now (artifact hash checked), then opens Settings → Remote room.
- In `mixed` the native side creates the invitation, approves the connection and revokes it; the Web guest joins, previews the remote source and shows the stale snapshot.
- In `mixed-guest` the Web host creates/approves/revokes, and the **native guest** performs New Session → Open right sidebar → Remote room → `shared.txt`, rendering the exact Host seed in the native preview panel, then shows the stale label with Reload disabled after revoke.
- Both carriers use the loopback relay fixture; the desktop run's dual-root isolation, owned CDP discovery, PID/createTime checks and browser-level teardown still apply, and the Web peer's processes are stopped and verified before the native window closes.
- Native pages are never screenshotted in these modes (that renderer capture path times out); Web screenshots stay masked.

- `mixedJourney: passed native-host / web-guest install/join/approve/preview/revoke`.
- The native window performed Plugins → Install → Enable now (artifact hash checked), then **Create invitation**, **Approve connection**, **Revoke access** (cancel then confirm) with real clicks in its own Settings panel.
- The Web guest installed/enabled, pasted the invitation, requested access, saw pending without a pre-approval tree, opened the remote `shared.txt` preview with the exact Host seed, and after revoke showed the stale label with Reload disabled.
- Both carriers used the loopback relay fixture; the desktop run's own isolation, CDP discovery and PID/createTime checks still applied, and the guest Web processes were stopped and verified before the desktop window was closed.
- Native pages are never screenshotted in this mode (the renderer capture path times out); Web screenshots are masked.

Not covered by these directions: Desktop ↔ Desktop, native-side execution/PTY panel, OS native picker, cross-OS pairing.

Not covered: Desktop ↔ Desktop, native-side execution/PTY panel, OS native picker, UI Quit/tray interactions, persistence/restart or model inference. These remain `not-run` regardless of installation result.
