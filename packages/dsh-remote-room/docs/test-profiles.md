# Real temporary-profile integration test

`scripts/e2e-profiles.mjs` starts two independent **web** profiles through the supported DSH CLI. It never creates a manual Cordis context, boots Desktop, or changes the profile serving the current GUI. The script is separate from the Vitest controller/unit tests.

## Run

Build and pack the plugin first using the project's existing release/build procedure. The default package is `artifacts/local-dsh-remote-room-0.1.2.tgz`; it must contain the current `lib/` output, including the `remote_room_audit` storage unit name.

```powershell
# Discoverable supported carrier shipped with this Windows installation:
& 'D:\J\dsh\resources\runtime\cli\bin\dsh.cmd' --help

# Fast first milestone: real installs, two real web processes, authentication, HTTP state.
node scripts/e2e-profiles.mjs --smoke

# Full authenticated TLS relay + remote tool read/write, epoch and revoke scenario.
node scripts/e2e-profiles.mjs

# Also verify actual installed exec and PTY providers through Agent tools.
node scripts/e2e-profiles.mjs --processes

# Another supported CLI installation / explicitly chosen built artifact:
node scripts/e2e-profiles.mjs --cli 'C:\path\to\dsh.cmd' --package 'C:\path\to\plugin.tgz'
```

The script discovers `--help`, `plugin --help`, and `--profile web --help` before installing or booting. Installation uses the public command `dsh plugin --profile web add <temporary-copy.tgz> --ignore-scripts`. It does not import the private plugin-manager operations API, hand-write a profile package manifest, or run pnpm directly inside a profile. If supported CLI installation fails, the default run fails rather than silently falling back to an overlay.

The native `dsh.cmd` carrier sets `ELECTRON_RUN_AS_NODE=1` and invokes the packaged ASAR CLI through the installation's Electron executable. Ordinary Node cannot load that ASAR CLI. Node runs only this workspace test driver. No alternative server or replacement runtime is started.

## Exact npm CLI under standalone Node

To distinguish the Desktop Electron/BoringSSL carrier from a supported standalone Node/OpenSSL CLI, the same driver can prepare an exact released CLI in its own temporary root:

```powershell
& 'C:\Users\J\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' scripts/e2e-profiles.mjs `
  --npm-script 'D:\J\nodejs\node_modules\npm\bin\npm-cli.js' `
  --pnpm-script 'C:\Users\J\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs' `
  --package artifacts/local-dsh-remote-room-0.1.1.tgz
```

Use Node >=24.9; the driver pins subprocesses to its own `process.execPath`. It first asks the public npm registry for the exact `@deepseek-ai/dsh@0.2.1-rc.3` version and `bin` metadata, installs that version under its temporary root with package scripts disabled, reads back its manifest, and invokes the declared public CLI bin. The temporary pnpm shim uses the selected Node executable and explicit pnpm script. npm user/global config and cache locations point only inside the new temporary root. This is still the public CLI profile/installation path, not a custom Loader launcher. A standalone pass would not resolve a Desktop-specific TLS failure.

## Isolation and lifetime

Each run creates one `dsh-room-profiles-*` directory with independent `host` and `guest` homes, agents homes, OS user/config/cache directories and workspaces. Each uses the shipped `web` profile, `--host 127.0.0.1 --port 0 --no-open`. Two distinct printed origins are required.

Child environments are built from a short OS launch-variable allowlist. They do not inherit `DSH_PROFILE`, `DSH_PROFILE_DIR`, `DSH_WEB_URL`, `NODE_OPTIONS`, `NODE_PATH`, `TSX_TSCONFIG_PATH`, provider keys, registry credentials or user home/config paths. The script does not scan environment values for credentials, read user profile/authentication files, load `.env`, use browser login state, or contact the current live GUI. Keyless profile startup and local tools do not make model API calls.

Only the exact child process's own stdout readiness URL supplies its bootstrap token. A direct loopback HTTP exchange obtains an in-memory cookie jar from that URL; redirects are not automatically followed. Tokens, cookies and invitations are never persisted or printed. Child output is bounded and diagnostics redact bootstrap/invitation query or fragment secrets. No request targets a preconfigured GUI port.

A run has an eight-minute overall deadline, per-command install deadlines, a 90-second readiness deadline, bounded HTTP and polling deadlines, and `finally` cleanup. The script tracks every child PID. On Windows, `taskkill /PID <owned PID> /T /F` stops the owned carrier and descendants; other systems use owned detached process groups. It does not discover or kill unrelated DSH processes. Recursive deletion is limited to the exact checked `mkdtemp` root after child cleanup; teardown errors retain that root and fail the run.

## Assertions and fixture scope

The `--smoke` milestone proves public CLI package installation completed, both real Host halves are active, and each authenticated browser-owner `/api/remote-room` `state` request succeeds with an empty room list. It does not prove Client visual rendering or remote writes.

The full scenario additionally uses the project's actual byte-relay implementation on an ephemeral loopback port. The relay carries the installed plugin's authenticated TLS session; authentication is owned by that artifact, not replaced by the driver. It creates and joins a room, observes authenticated `pending`, verifies preapproval read denial, approves on the host, reads and version-guards a write from the guest, verifies the host file changed, rejects a stale epoch, revokes, and rejects access under the old grant.

Writing is not a browser-controller operation. A test-only observer, mounted through supported CLI `--patch`, invokes the real public `ctx.agents` / `ctx.agentPresets` / `ctx.tools.execute` services. It mounts an actual Creator preset and uses the registered `remote_read` and `remote_write` tools in the same real web Host process. It neither constructs a context nor replaces the controller, manager, filesystem or authorization checks. Its HTTP endpoint admits only the local owner browser, allowlists five remote tools, and exists only in the temporary test profiles. The test sets that temporary Agent's permission preset, not the current profile's session. This is a keyless service-driven tool scenario, not a model inference test.

If an installation issue prevents testing the installed package, the explicit diagnostic command below mounts the built Host module through a supported Loader overlay:

```powershell
node scripts/e2e-profiles.mjs --mode overlay --smoke
```

An overlay result is labeled **Loader-overlay (NOT installation)**. It must never be reported as installed-profile coverage, and it is not used as an automatic fallback.

## Recorded native-carrier runs

On 2026-10-26, `node scripts/e2e-profiles.mjs --smoke` passed with the original `0.1.0` artifact: supported CLI installation in both isolated profiles, two authenticated ephemeral web origins, both Host `state` endpoints, and complete child-tree/temp cleanup. The first full run of that artifact exposed its invitation timeout / relay timeout mismatch (`Invalid relay limit`); it did not reach TLS.

With the updated artifact, the actual command was:

```powershell
node scripts/e2e-profiles.mjs --package artifacts/local-dsh-remote-room-0.1.1.tgz
```

Artifact SHA-256 was `265c9798e2b6e89ce78be4d587509dfd168f562a710e4ff0ea420bf3c06a52cd`. Both supported CLI installs, web process starts, own-URL cookie exchanges and authenticated Host state checks passed. Creation and joining reached the TLS handshake, which **failed** in this native Electron carrier with `OPENSSL_internal:NO_CERTIFICATE_SET` at `third_party/boringssl/src/ssl/tls13_server.cc:407`. The script exited 1 and stopped all owned child trees and removed its temporary roots. This is not a full TLS/read/write/epoch/revoke pass. The packaged Electron BoringSSL runtime must not be assumed equivalent to the standalone Node/OpenSSL runtime used by unit tests; the driver does not weaken PSK authentication, supply an unverified certificate or patch the carrier to hide the failure.

The same `0.1.1` artifact subsequently **passed the complete installed-profile scenario** under the exact npm CLI `@deepseek-ai/dsh@0.2.1-rc.3`, standalone bundled Node `v24.21.0` / OpenSSL `3.5.8`, using the npm command above. Both real Agent `remote_rooms` executions passed before pairing. TLS join, preapproval denial, real `remote_read`, observed-version `remote_write`, host file-content verification, stale-epoch denial and revoke denial all passed. The command exited zero after all owned child trees stopped and temporary roots were removed. The native Electron failure above remains a separate unresolved result for that artifact; standalone success is not Desktop compatibility evidence.

The `0.1.2` mTLS artifact then **passed the complete installed-profile scenario on the native Electron/BoringSSL carrier**. Command: bundled Node `scripts/e2e-profiles.mjs --package artifacts/local-dsh-remote-room-0.1.2.tgz`. Artifact SHA-256: `36a24181a7378670a9340794b6ccca88f36858ad0e0eb415a3cf59aaf806d5fe`. Both installations, authenticated Host state, real Agent tools, pairing/approval/read/write/stale-epoch/revoke checks passed. Exit zero followed confirmed child-tree and temporary-root cleanup. This resolves the old PSK carrier failure for the new artifact, but remains a CLI/HTTP test of two web profiles, not a real Desktop-window click test.

## Evidence and limitations

The script prints the selected carrier, selected artifact path and SHA-256, owned PIDs, authenticated origins without tokens, milestones, and cleanup completion. Exit zero is required for a pass; readiness by itself is not success. Record the command and its actual final output when reporting a run. An unsupported launcher, install failure, activation failure, HTTP auth failure or teardown failure remains a concrete failure, not a skipped pass.

With `--processes`, the installed-profile scenario also creates a full-access room and invokes real Agent tools for Host-only exec marker creation, Unicode stdout/stderr, exit code 7, actual PTY `isTTY:true`, stdin Unicode acknowledgement, resize, kill, and live execution stopped by revoke. This optional scenario passed on the native Electron/BoringSSL CLI carrier with artifact `0.1.2` and exit zero, followed by owned-tree/temp cleanup. It does not substitute for terminal UI clicks.

This test does not cover visual Client rendering, production WSS certificates, public internet relay deployment, an actual LLM call, arbitrary user profile migrations, or current-GUI login. Loopback WS is deliberate only for the transport fixture; the end-to-end room session still authenticates and encrypts through the plugin's TLS protocol.
