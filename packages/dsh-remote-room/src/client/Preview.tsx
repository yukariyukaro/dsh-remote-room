/**
 * Read-only remote preview.
 *
 * Rendering is DSH's own: `MarkdownText` and `CodeBlock` come from the shared
 * `@deepseek-ai/dsh-client-ui-primitives` platform module the Web shell seeds, so a
 * remote file is drawn by the same Markdown pipeline and the same shiki highlighter
 * the conversation uses — not by a private viewer of ours. Only the room-scoped
 * chrome (source label, epoch, authorization, stale state, reload) is ours, and the
 * remote path is never handed to a local file reader.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { CodeBlock, MarkdownText, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Failure, RemoteRoomApi, RemoteFileRef } from './contracts.ts'
import { parseFileAddress } from './contracts.ts'
import type { ClientSnapshot } from './state.ts'
import type { Translate } from './locale.ts'
import { failureOf } from './bridge.ts'
import { ErrorNotice } from './ui.tsx'
import { styles } from './styles.ts'
export interface PreviewProps {
  t: Translate
  api: RemoteRoomApi
  useRoomState: <T>(selector: (state: ClientSnapshot) => T) => T
  useResource: (address: string) => { status: 'none' | 'loading' | 'live' | 'failed'; value?: { authorized: boolean }; failure?: { code: string; message: string } }
  useTabInfo: () => { tab: { id: string; contentId: string; signal: AbortSignal; navigation: { revision: number; params?: { line?: number } }; actions: { bindCommands(commands: { refresh: () => void }): () => void } } }
}
type Content = { kind: 'text'; text: string; version?: string } | { kind: 'image'; url: string }
const TEXT_SUFFIXES = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'scss', 'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'log', 'sh', 'bash', 'ps1', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sql', 'csv', 'tsv', 'html', 'htm', 'svg'])
const IMAGE_SUFFIXES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** Markdown image destinations the renderer may rewrite; bounded so a document cannot fan out reads. */
const MAX_INLINE_IMAGES = 8
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024
/** Authored destinations the shared renderer already displays without help. */
function isAbsoluteImage(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(value)
}
/** Remote directory of one room file, in the room's own `/`-separated coordinates. */
function directoryOf(remotePath: string): string {
  const index = remotePath.lastIndexOf('/')
  return index === -1 ? '' : remotePath.slice(0, index)
}
/** Resolve one authored destination against the previewed remote file's directory. */
export function relativeRemotePath(remotePath: string, destination: string): string | undefined {
  if (isAbsoluteImage(destination) || destination.startsWith('#')) return undefined
  const base = directoryOf(remotePath).split('/').filter(Boolean)
  const parts = destination.split('#')[0]!.split('?')[0]!.split('/')
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') { if (base.pop() === undefined) return undefined; continue }
    base.push(part)
  }
  return base.join('/')
}
function imageDestinations(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/gu)) {
    const destination = match[1]
    if (destination !== undefined && !isAbsoluteImage(destination)) found.add(destination)
  }
  return [...found].slice(0, MAX_INLINE_IMAGES)
}
export function Preview({ t, api, useTabInfo, useRoomState, useResource }: PreviewProps) {
  const { tab } = useTabInfo()
  const ref = useMemo(() => parseFileAddress(tab.contentId), [tab.contentId])
  const room = useRoomState(state => state.state.rooms.find(value => value.id === ref?.roomId))
  const connected = useRoomState(state => state.connected)
  const resource = useResource(tab.contentId)
  const authorized = connected && resource.status === 'live' && resource.value?.authorized === true && !!room && room.phase === 'authorized' && room.epoch === ref?.epoch
  const [loaded, setLoaded] = useState<{ address: string; content: Content }>()
  // A pane may navigate without unmounting. Never label A's retained bytes as B.
  const content = loaded?.address === tab.contentId ? loaded.content : undefined
  const [failure, setFailure] = useState<Failure>()
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [wrap, setWrap] = useState(true)
  const [inlineImages, setInlineImages] = useState<ReadonlyMap<string, string>>(new Map())
  const suffix = ref?.path.split('.').pop()?.toLowerCase() ?? ''
  const image = IMAGE_SUFFIXES.has(suffix)
  const markdown = suffix === 'md' || suffix === 'markdown'
  const text = TEXT_SUFFIXES.has(suffix) || !ref?.path.split('/').pop()?.includes('.')
  useEffect(() => tab.actions.bindCommands({ refresh: () => setRevision(value => value + 1) }), [tab.actions])
  useEffect(() => {
    if (!ref || !authorized || (!image && !text)) { setLoading(false); return }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    tab.signal.addEventListener('abort', abort, { once: true })
    if (tab.signal.aborted) controller.abort()
    setLoading(true); setFailure(undefined)
    const load = async (): Promise<void> => {
      if (image) {
        const result = await api.readBytes(ref, controller.signal)
        if (controller.signal.aborted) return
        if (!IMAGE_TYPES.has(result.mediaType)) throw new Error(t('unsupportedHint'))
        // The Host enforces a byte bound; check the encoded result before a browser allocation too.
        if (result.base64.length > 12 * 1024 * 1024) throw new Error(t('imageLimit'))
        const raw = atob(result.base64)
        const bytes = Uint8Array.from(raw, char => char.charCodeAt(0))
        const objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mediaType }))
        setLoaded({ address: tab.contentId, content: { kind: 'image', url: objectUrl } })
      } else {
        const result = await api.readText(ref, controller.signal)
        if (!controller.signal.aborted) setLoaded({ address: tab.contentId, content: { kind: 'text', ...result } })
      }
    }
    void load().catch(error => { if (!controller.signal.aborted) setFailure(failureOf(error)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort(); tab.signal.removeEventListener('abort', abort) }
  }, [api, ref, authorized, image, text, revision, tab.signal, tab.contentId, t])
  useEffect(() => () => { if (loaded?.content.kind === 'image') URL.revokeObjectURL(loaded.content.url) }, [loaded])
  // Relative Markdown images belong to the Host: fetch the bytes this document names,
  // then let DSH's renderer draw them from object URLs. Never a local path.
  const markdownText = content?.kind === 'text' && markdown ? content.text : undefined
  useEffect(() => {
    if (markdownText === undefined || !ref || !authorized) return
    const destinations = imageDestinations(markdownText)
    if (destinations.length === 0) { setInlineImages(new Map()); return }
    const controller = new AbortController()
    const created: string[] = []
    void (async () => {
      const next = new Map<string, string>()
      let budget = MAX_INLINE_IMAGE_BYTES
      for (const destination of destinations) {
        const remotePath = relativeRemotePath(ref.path, destination)
        if (remotePath === undefined) continue
        try {
          const result = await api.readBytes({ ...ref, path: remotePath }, controller.signal)
          if (controller.signal.aborted) return
          if (!IMAGE_TYPES.has(result.mediaType)) continue
          if (result.base64.length > budget) continue
          budget -= result.base64.length
          const raw = atob(result.base64)
          const url = URL.createObjectURL(new Blob([Uint8Array.from(raw, char => char.charCodeAt(0))], { type: result.mediaType }))
          created.push(url)
          next.set(destination, url)
        } catch {
          // A missing or unauthorized image stays inert alt text; the document itself still renders.
        }
      }
      if (controller.signal.aborted) return
      setInlineImages(next)
    })()
    return () => {
      controller.abort()
      for (const url of created) URL.revokeObjectURL(url)
    }
  }, [api, markdownText, ref, authorized])
  const pathImages = useMemo(() => ({ resolve: (value: string) => inlineImages.get(value) }), [inlineImages])
  // Stable identity per locale revision: a new object discards the streaming cache.
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('codeCopy'), copiedLabel: t('codeCopied') }, footnotes: t('footnotes'),
  }), [t])
  const label = markdown ? t('markdown') : image ? t('image') : t('text')
  const fullPath = ref?.path ?? tab.contentId
  // Show the path inside the shared root: the Host prefix is noise in a tab header.
  // Windows Hosts report backslash roots, so both sides compare in one separator.
  const slash = (value: string): string => value.replace(/\\/gu, '/').replace(/\/+$/u, '')
  const trimmedPath = slash(fullPath)
  const rootPrefix = room?.root === undefined ? undefined : `${slash(room.root)}/`
  const shownPath = rootPrefix !== undefined && trimmedPath.startsWith(rootPrefix) ? trimmedPath.slice(rootPrefix.length) : trimmedPath
  const basename = shownPath.split('/').pop() ?? shownPath
  const directory = basename.length < shownPath.length ? shownPath.slice(0, shownPath.length - basename.length - 1) : ''
  const roomId = room?.id ?? ref?.roomId ?? ''
  const epochShort = ref === undefined ? undefined : ref.epoch.slice(0, 8)
  return <section className="rr rr-preview">
    <style>{styles}</style>
    {/* Content only: the tab already names the file, so no private chrome is added here. */}
    {!authorized ? <p className="rr-stalechip" role="status">{content ? t('stale') : room ? t('noPermission') : t('noRoom')}</p> : null}
    {failure ? <div className="rr-bannerwrap"><ErrorNotice error={failure} t={t} /></div> : null}
    <div className="rr-previewbody" data-image={image} data-wrap={wrap} data-rr-renderer={content?.kind === 'text' ? markdown ? 'markdown' : 'code' : image ? 'image' : 'none'}>
      {content === undefined && loading ? <div className="rr-skeleton" aria-hidden="true"><span /><span /><span /><span /></div> : null}
      {content === undefined && !loading && !authorized && failure === undefined ? <p className="rr-emptyhint">{room ? t('unavailable') : t('noRoom')}</p> : null}
      {!image && !text ? <div className="rr-empty"><strong>{t('unsupported')}</strong>{t('unsupportedHint')}</div> : null}
      {content?.kind === 'image' ? <img className="rr-image" src={content.url} alt={ref?.path ?? ''} onError={() => setFailure({ code: 'image/decode-failed', message: t('imageFailed') })} />
        : content?.kind === 'text' ? (markdown
          ? <div className="rr-document"><MarkdownText text={content.text} labels={labels} pathImages={pathImages} /></div>
          : <CodeBlock code={content.text} lang={languageForPath(ref?.path ?? '')} lineNumbers copyLabel={t('codeCopy')} copiedLabel={t('codeCopied')} wrap={wrap} />)
          : null}
    </div>
  </section>
}
