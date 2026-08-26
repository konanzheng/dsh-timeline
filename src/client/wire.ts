/**
 * dsh-history — wire type declarations.
 *
 * Structural (not imported from the harness packages, which are not published
 * for standalone consumption). These mirror the browser `connection.api`
 * return shapes consumed by `model.ts` and `plugin.ts`.
 */

/**
 * RPC envelope mirroring `@deepseek-ai/dsh-host-apiproxy`'s four-quadrant
 * model. Unary calls (`connection.api.sessions.*`) return an `RpcResponse<T>`:
 *
 *   { rpcId, result: RpcResult<T> }   where RpcResult<T> = { ok: true; value: T } | { ok: false; error }
 *
 * So the payload lives at `response.result.value` (NOT `response.data`), and
 * only when `result.ok === true`. See the real `IApiClient.sessions.list` /
 * `.history` return types — this structural mirror must stay in sync or
 * nothing renders.
 */

/** A session event as returned by `sessions.history`. */
export interface SessionEvent {
  type: string
  seq?: number
  time?: number
  data: unknown
  view?: unknown
}

/** One history row: the raw event plus an optional presentation view. */
export interface HistoryEntry {
  event: SessionEvent
  view?: unknown
}

/** One session list entry. */
export interface SessionSummary {
  /** The session id — the field is `sessionId`, NOT `id`. */
  sessionId: string
  updatedAt?: number
  running?: boolean
}

/** `result` slot of a unary RPC response. */
export type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message?: string } }

/** Full unary response envelope. */
export interface RpcResponse<T> {
  rpcId?: string
  result: RpcResult<T>
}

/** Minimal face of `connection.api.sessions` we consume. */
export interface SessionApi {
  list(payload: { cursor?: string }, signal?: AbortSignal): Promise<RpcResponse<{
    items: SessionSummary[]
  }>>
  history(payload: {
    sessionId: string
    beforeSeq?: number
    maxMessages?: number
  }, signal?: AbortSignal): Promise<RpcResponse<{
    events: HistoryEntry[]
    hasMore: boolean
  }>>
}

/** The `connection` service provided by the injected client-connection module. */
export interface ConnectionApi {
  api?: {
    sessions: SessionApi
  }
}
