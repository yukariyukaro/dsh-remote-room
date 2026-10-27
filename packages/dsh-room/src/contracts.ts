/** The narrow slice of Host services this plugin uses. Kept structural so the plugin builds elsewhere. */

export interface HostRoute {
  path: string
  methods: ('GET' | 'POST')[]
  requestBody: 'buffered' | 'streaming'
  fetch(request: Request): Promise<Response>
}

export interface HostPeer {
  readonly id: string
  readonly principal: { readonly kind: string }
}

export interface HostConnection {
  readonly browserPeer: HostPeer
  admit(request: Request): { rejection: number } | { peer: HostPeer }
  authenticatedUrl(baseUrl: string): string
  fetch: { register(route: HostRoute): () => Promise<void> | void }
}

export interface HostWebServer {
  readonly protocol: string
  readonly port: number | undefined
  getOrigin(): string
}

export interface HostServices {
  webServer: HostWebServer
  connection: HostConnection
}
