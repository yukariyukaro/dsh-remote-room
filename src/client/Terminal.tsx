/** Explicit remote exec/PTY controls. This is a bounded transcript, not a terminal emulator. */
import React, { useEffect, useRef, useState } from 'react'
import type { Failure, Json, ProcessChunk, ProcessKind, ProcessMethod, ProcessPage, ProcessStart, RemoteRoomApi, RoomSnapshot } from './contracts.ts'
import type { Translate } from './locale.ts'
import { failureOf } from './bridge.ts'
const RETAIN_BYTES = 64 * 1024
interface Transcript { chunks: ProcessChunk[]; dropped: number }
interface Session { handle: string; epoch: string; roomId: string; kind: ProcessKind; cursor: number }
/** Bound retained UTF-8 bytes, complete emitted chunks, and rendered node count. */
function retain(previous: Transcript, incoming: ProcessChunk[]): Transcript {
  const encoder = new TextEncoder()
  const chunks = [...previous.chunks, ...incoming].map(chunk => ({ ...chunk }))
  let bytes = chunks.reduce((sum, chunk) => sum + encoder.encode(chunk.text).byteLength, 0)
  let dropped = previous.dropped
  while (chunks.length && (bytes > RETAIN_BYTES || chunks.length > 512)) {
    const first = chunks[0]!
    const encoded = encoder.encode(first.text)
    if (chunks.length > 512 || encoded.byteLength <= bytes - RETAIN_BYTES) {
      bytes -= encoded.byteLength; dropped += encoded.byteLength; chunks.shift(); continue
    }
    let cut = bytes - RETAIN_BYTES
    while (cut < encoded.length && (encoded[cut]! & 0xc0) === 0x80) cut++
    first.text = new TextDecoder().decode(encoded.subarray(cut)); first.from += cut
    dropped += cut; bytes -= cut
  }
  return { chunks, dropped }
}
function plain(text: string): string {
  return text.replace(/\x1b/g, '␛').replace(/\r/g, '␍').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '�')
}
/** Wire values are validated before they become React input or cursor state. */
function startOf(value: Json): ProcessStart {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.handle !== 'string' || !value.handle || (value.kind !== 'exec' && value.kind !== 'pty') || value.cursor !== 0) throw new Error('Invalid remote process start response')
  return { handle: value.handle, kind: value.kind, cursor: 0, access: 'full-host-and-network' }
}
function pageOf(value: Json, after: number): ProcessPage {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.chunks) || typeof value.nextCursor !== 'number' || !Number.isSafeInteger(value.nextCursor) || value.nextCursor < after || typeof value.outputClosed !== 'boolean' || typeof value.gap !== 'boolean' || typeof value.gapBytes !== 'number') throw new Error('Invalid remote process output response')
  const status = value.status
  if (!status || typeof status !== 'object' || Array.isArray(status) || !['starting', 'running', 'exited', 'error'].includes(String(status.state))) throw new Error('Invalid remote process status')
  const nextCursor = value.nextCursor
  const chunks: ProcessChunk[] = value.chunks.map(chunk => {
    if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk) || !['stdout', 'stderr', 'terminal'].includes(String(chunk.stream)) || typeof chunk.text !== 'string' || typeof chunk.from !== 'number' || typeof chunk.to !== 'number' || chunk.from < after || chunk.to < chunk.from || chunk.to > nextCursor) throw new Error('Invalid remote output chunk')
    return { stream: chunk.stream as ProcessChunk['stream'], text: chunk.text, from: chunk.from, to: chunk.to }
  })
  return { chunks, nextCursor: value.nextCursor, oldestCursor: typeof value.oldestCursor === 'number' ? value.oldestCursor : after, latestCursor: typeof value.latestCursor === 'number' ? value.latestCursor : value.nextCursor,
    gap: value.gap, gapBytes: value.gapBytes, outputClosed: value.outputClosed, status: { state: status.state as ProcessPage['status']['state'], exitCode: typeof status.exitCode === 'number' ? status.exitCode : null, signal: typeof status.signal === 'string' ? status.signal : null, reason: typeof status.reason === 'string' ? status.reason : null } }
}
function uncertain(error: Failure): boolean {
  return !['INVALID_INPUT', 'PROCESS_DENIED', 'NOT_AUTHORIZED', 'CAPABILITY_UNAVAILABLE', 'LIMIT_EXCEEDED', 'HANDLE_NOT_FOUND', 'PROCESS_CLOSED', 'PROCESS_BUSY'].includes(error.code)
}
export function Terminal({ room, api, connected, t }: { room: RoomSnapshot; api: RemoteRoomApi; connected: boolean; t: Translate }) {
  const [kind, setKind] = useState<ProcessKind>('exec')
  const [argv, setArgv] = useState('')
  const [cwd, setCwd] = useState('')
  const [cols, setCols] = useState(80)
  const [rows, setRows] = useState(24)
  const [session, setSession] = useState<Session>()
  const [transcript, setTranscript] = useState<Transcript>({ chunks: [], dropped: 0 })
  const [page, setPage] = useState<ProcessPage>()
  const [hostGap, setHostGap] = useState(0)
  const [paused, setPaused] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [stdin, setStdin] = useState('')
  const [newline, setNewline] = useState(false)
  const [end, setEnd] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure>()
  const [unknown, setUnknown] = useState(false)
  const lifetime = useRef<AbortController>()
  const inFlight = useRef(false)
  const reading = useRef(false)
  const cursor = useRef(0)
  const available = connected && room.phase === 'authorized' && room.mode === 'danger-full-access'
  const sameIdentity = !session || (session.roomId === room.id && session.epoch === room.epoch)
  const active = available && sameIdentity
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller
    return () => { controller.abort(); if (lifetime.current === controller) lifetime.current = undefined }
  }, [room.id, room.epoch, available])
  useEffect(() => {
    if (!session || !active || paused) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async (): Promise<void> => {
      if (controller.signal.aborted) return
      if (reading.current) { timer = setTimeout(() => { void read() }, 50); return }
      reading.current = true
      try {
        const result = pageOf(await api.process(session, `${session.kind}.read`, { handle: session.handle, after: cursor.current, maxBytes: RETAIN_BYTES }, controller.signal), cursor.current)
        if (controller.signal.aborted) return
        cursor.current = result.nextCursor
        setTranscript(previous => retain(previous, result.chunks)); setPage(result)
        if (result.gap) setHostGap(previous => previous + result.gapBytes)
        if (!result.outputClosed || result.nextCursor < result.latestCursor) timer = setTimeout(() => { void read() }, 500)
      } catch (error) {
        if (!controller.signal.aborted) { setFailure(failureOf(error)); setPaused(true) }
      } finally { reading.current = false }
    }
    void read()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [session, active, paused, refresh, api])
  const command = async (method: ProcessMethod, args: Json, done?: (value: Json) => void): Promise<void> => {
    if (!active || inFlight.current) return
    const controller = lifetime.current
    if (!controller || controller.signal.aborted) return
    inFlight.current = true; setBusy(true); setFailure(undefined)
    try {
      const value = await api.process({ roomId: room.id, epoch: room.epoch }, method, args, controller.signal)
      if (!controller.signal.aborted) done?.(value)
      else setUnknown(true)
    } catch (error) {
      const failure = failureOf(error)
      setFailure(failure)
      if (controller.signal.aborted || uncertain(failure)) setUnknown(true)
    } finally { inFlight.current = false; setBusy(false) }
  }
  const running = !!session && !page?.outputClosed
  const interaction = active && !!session && !busy && !unknown && running
  return <section className="rr-terminal" aria-label={t('terminal')}><div className="rr-sectionhead"><h3>{t('terminal')}</h3><span className="rr-badge">{session?.kind === 'pty' ? t('pty') : t('command')}</span></div>
    <p className="rr-warning">{t('fullWarning')}</p><p className="rr-notice">{t('transcriptHint')}</p>
    {!active ? <p className="rr-warning" role="status">{t('terminalStale')}</p> : null}
    <form className="rr-form" onSubmit={event => {
      event.preventDefault()
      if (!active || busy || running || unknown) return
      let parsed: unknown
      try { parsed = JSON.parse(argv); if (!Array.isArray(parsed) || !parsed.length || parsed.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error(t('argvInvalid')) } catch { setFailure({ code: 'INVALID_INPUT', message: t('argvInvalid') }); return }
      const args: { [key: string]: Json } = { argv: parsed as string[] }
      if (cwd.trim()) args.cwd = cwd.trim()
      if (kind === 'pty') { args.cols = cols; args.rows = rows }
      void command(`${kind}.start`, args, value => {
        const started = startOf(value)
        cursor.current = 0; setSession({ ...started, roomId: room.id, epoch: room.epoch }); setPage(undefined); setTranscript({ chunks: [], dropped: 0 }); setHostGap(0); setPaused(false); setStdin('')
      })
    }}>
      <div className="rr-terminal-config"><label className="rr-label">{t('processKind')}<select className="rr-input" disabled={busy || running} value={kind} onChange={event => setKind(event.target.value as ProcessKind)}><option value="exec">{t('command')}</option><option value="pty">{t('pty')}</option></select></label><label className="rr-label">{t('cwd')}<input className="rr-input" disabled={busy || running} value={cwd} onChange={event => setCwd(event.target.value)} placeholder={room.root ?? '.'} spellCheck={false} /></label></div>
      <label className="rr-label">{t('argv')}<textarea className="rr-input" rows={2} required disabled={busy || running} value={argv} onChange={event => setArgv(event.target.value)} autoComplete="off" spellCheck={false} placeholder={'["powershell.exe","-NoLogo","-NoProfile"]'} /></label><p className="rr-notice">{t('argvHint')}</p>
      <div className="rr-buttons"><button className="rr-btn" type="submit" data-danger="true" disabled={!active || busy || running || unknown || !argv.trim()}>{busy ? t('busy') : t('startProcess')}</button>{session ? <button className="rr-btn" type="button" disabled={!active || busy} onClick={() => { setPaused(false); setRefresh(value => value + 1) }}>{t('readOutput')}</button> : null}{session ? <button className="rr-btn" type="button" data-danger="true" disabled={!active || busy || !running || unknown} onClick={() => { if (window.confirm(t('confirmKill'))) void command(`${session.kind}.kill`, { handle: session.handle }, () => { setPaused(false); setRefresh(value => value + 1) }) }}>{t('killProcess')}</button> : null}</div>
    </form>
    {failure ? <div className="rr-error" role="alert">{failure.message}<br /><code>{failure.code}</code></div> : null}{unknown ? <p className="rr-warning" role="alert">{t('processUnknown')}</p> : null}{paused ? <p className="rr-notice" role="status">{t('readPaused')}</p> : null}
    {session ? <><div className="rr-terminal-status"><span className="rr-badge">{page ? t(page.status.state === 'starting' ? 'processStarting' : page.status.state === 'running' ? 'processRunning' : page.status.state === 'exited' ? 'processExited' : 'failed') : t('processStarting')}</span><span className="rr-size">{session.handle}</span>{page?.status.exitCode !== null && page?.status.exitCode !== undefined ? <span>{t('exitCode')}: {page.status.exitCode}</span> : null}{page?.status.signal ? <span>{t('signal')}: {page.status.signal}</span> : null}{page?.status.reason ? <code>{page.status.reason}</code> : null}</div>
      {hostGap || transcript.dropped ? <p className="rr-warning" role="status">{t('outputGap')} · {t('hostDropped')}: {hostGap.toLocaleString()} B · {t('clientDropped')}: {transcript.dropped.toLocaleString()} B</p> : null}
      <pre className="rr-terminal-output" tabIndex={0} aria-label={t('output')}><code>{transcript.chunks.map((chunk, index) => <span key={`${chunk.from}:${index}`} data-stream={chunk.stream}>{plain(chunk.text)}</span>)}</code></pre>
      <form className="rr-form" onSubmit={event => { event.preventDefault(); if (!interaction) return; const args: { [key: string]: Json } = { handle: session.handle, data: stdin + (newline ? '\n' : '') }; if (session.kind === 'exec') args.end = end; void command(`${session.kind}.write`, args, () => setStdin('')) }}>
        <label className="rr-label">{t('stdin')}<textarea className="rr-input" rows={2} disabled={!interaction} value={stdin} onChange={event => setStdin(event.target.value)} spellCheck={false} /></label><div className="rr-buttons"><label className="rr-check"><input type="checkbox" checked={newline} onChange={event => setNewline(event.target.checked)} disabled={!interaction} />{t('appendNewline')}</label>{session.kind === 'exec' ? <label className="rr-check"><input type="checkbox" checked={end} onChange={event => setEnd(event.target.checked)} disabled={!interaction} />{t('endStdin')}</label> : null}<button className="rr-btn" type="submit" disabled={!interaction || (!stdin && !newline && !end)}>{t('sendStdin')}</button></div>
      </form>
      {session.kind === 'pty' || kind === 'pty' ? <div className="rr-terminal-resize"><label className="rr-label">{t('cols')}<input className="rr-input" type="number" min={2} max={500} step={1} value={cols} onChange={event => setCols(Number(event.target.value))} /></label><label className="rr-label">{t('rows')}<input className="rr-input" type="number" min={1} max={200} step={1} value={rows} onChange={event => setRows(Number(event.target.value))} /></label><button className="rr-btn" disabled={!interaction || session.kind !== 'pty' || !Number.isInteger(cols) || cols < 2 || cols > 500 || !Number.isInteger(rows) || rows < 1 || rows > 200} onClick={() => { void command('pty.resize', { handle: session.handle, cols, rows }) }}>{t('resizePty')}</button></div> : null}
    </> : null}
  </section>
}
