/**
 * dsh-history — trajectory graph model.
 *
 * Turns the DSH session history event log (as returned by
 * `connection.api.sessions.history`) into a display graph:
 *
 *   TimelineGraph
 *     └─ turns: TurnNode[]        one per `turn/start`…`turn/end`
 *          ├─ title/user text     from the first `user/message`
 *          ├─ reply               concatenated `assistant/message` text
 *          └─ files: FileNode[]   file sub-nodes derived from tool calls
 *               └─ (each FileNode carries the tools that touched that path)
 *          └─ edges: ToolEdge[]   ordered tool-call edges within the turn
 *
 * Every event is read defensively (the shape is a stable wire contract but
 * third-party/plugin tools may extend it). Anything unrecognized is skipped,
 * never fatal.
 */
import type { HistoryEntry, SessionEvent } from './wire.ts'

/** A tool call recorded by the model. `filePath` is extracted from arguments when present. */
export interface ToolEdge {
  /** The provider call id pairing `tool/call` with its `tool/result`. */
  callId: string
  /** Tool name, e.g. `read`, `write`, `edit`, `grep`, `web_search`. */
  name: string
  /** Raw arguments JSON string as produced by the model (unparsed). */
  arguments: string
  /** Human-readable target: file path, search pattern, or url/query. */
  target?: string
  /** Short summary line shown on the edge label. */
  summary: string
  /** Whether the call ended in an error (from `tool/result.error`). */
  error?: boolean
  /** Result text (best-effort extraction from the `tool/result`). */
  result?: string
  /** Event sequence number — used to keep edges in log order. */
  seq: number
}

/** One file sub-node: the set of tool edges that touched a given path. */
export interface FileNode {
  /** Normalized file path (basename for very long paths). */
  path: string
  /** Display name (basename). */
  name: string
  /** Tool edges that operated on this path, in log order. */
  edges: ToolEdge[]
  /** Accumulated read/write/search tally for the badge. */
  reads: number
  writes: number
  searches: number
}

/** One interaction turn — the primary timeline node. */
export interface TurnNode {
  /** Sequential index (1-based) as displayed. */
  index: number
  turn: number
  /** Human timestamp of the turn start. */
  time: number
  /** User prompt text (first user message content). */
  userText: string
  /** Concatenated assistant reply text. */
  reply: string
  /** All tool-call edges in this turn, log order. */
  edges: ToolEdge[]
  /** File sub-nodes keyed by path. */
  files: FileNode[]
  /** Whether the turn ended normally (`turn/end.reason`). */
  endReason?: string
}

/** The whole trajectory for one session. */
export interface TimelineGraph {
  turns: TurnNode[]
  /** Total file-touching edges across all turns. */
  edgeCount: number
}

/** Map a tool name to a compact action tag shown on edges. */
function actionTag(name: string): string {
  switch (name) {
    case 'read': return '读'
    case 'read_image': return '看图'
    case 'write': return '写'
    case 'edit': return '改'
    case 'grep': return '搜'
    case 'glob': return '搜'
    case 'web_search': return '网搜'
    case 'web_fetch': return '抓取'
    case 'bash': return '执行'
    case 'list': return '列'
    case 'ls': return '列'
    default: return name
  }
}

/** Extract a human-readable target from a tool call's parsed arguments. */
function extractTarget(name: string, args: Record<string, unknown>): string | undefined {
  const fp = args.file_path
  if (typeof fp === 'string' && fp) return fp
  const path = args.path
  if (typeof path === 'string' && path) return path
  const url = args.url
  if (typeof url === 'string' && url) return url
  const query = args.query
  if (typeof query === 'string' && query) return query
  const pattern = args.pattern
  if (typeof pattern === 'string' && pattern) return pattern
  if (typeof fp === 'object' && fp !== null) {
    const any = fp as Record<string, unknown>
    if (typeof any.file_path === 'string') return any.file_path
    if (typeof any.path === 'string') return any.path
  }
  return undefined
}

/** Flatten a DSH ContentBlock[] into plain text (text + reasoning blocks). */
/**
 * Flatten content blocks to text. By default only `text` blocks are kept —
 * `reasoning` blocks are the model's private thinking, NOT the answer the
 * user should see on the card. Pass `includeReasoning` only when the raw
 * thinking is wanted (e.g. a dedicated debug view).
 */
function blocksToText(blocks: unknown, includeReasoning = false): string {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map(b => {
      if (b == null) return ''
      if (typeof b === 'string') return b
      const block = b as { type?: string; text?: string }
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (includeReasoning && block.type === 'reasoning' && typeof block.text === 'string') return block.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Extract the assistant/reply text from a message's content blocks. */
function messageText(content: unknown): string {
  return blocksToText(content)
}

/** Extract a short result summary from a `tool/result` event. */
function extractResult(data: Record<string, unknown>): string {
  const message = data.message as { content?: unknown } | undefined
  const content = message?.content
  const arr = Array.isArray(content) ? content as unknown[] : []
  const first = arr[0] as { type?: string; content?: unknown } | undefined
  if (first?.type === 'tool-result') return blocksToText(first.content)
  return blocksToText(content)
}

/** Parse a JSON arguments string defensively. */
function parseArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return (typeof v === 'object' && v !== null) ? v as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/** Shorten an over-long target for display. */
function shortTarget(target: string, max = 42): string {
  if (target.length <= max) return target
  return `…${target.slice(-(max - 1))}`
}

/**
 * Build the trajectory graph from the raw history entries.
 * Entries must be supplied in ascending `seq` order (as `sessions.history`
 * returns them). Events not related to turn grouping are ignored.
 */
export function buildGraph(entries: HistoryEntry[]): TimelineGraph {
  const turns: TurnNode[] = []
  let current: TurnNode | null = null
  // callId -> ToolEdge, to pair tool/call with tool/result regardless of interleave.
  const byCallId = new Map<string, ToolEdge>()
  let edgeCount = 0

  for (const entry of entries) {
    const ev = entry?.event
    if (!ev) continue
    applyEvent(ev, {
      get current() { return current },
      set current(t) { current = t },
      turns,
      byCallId,
      bumpEdges(n) { edgeCount += n },
    })
  }
  // Close any dangling turn.
  const last = turns[turns.length - 1]
  if (last) last.endReason ??= '…'

  return { turns, edgeCount }
}

/** Internal mutation surface passed to {@link applyEvent} so the builder stays a pure fold. */
interface Fold {
  get current(): TurnNode | null
  set current(t: TurnNode | null)
  turns: TurnNode[]
  byCallId: Map<string, ToolEdge>
  bumpEdges(n: number): void
}

function applyEvent(ev: SessionEvent, fold: Fold): void {
  const data = ev.data as Record<string, unknown>
  switch (ev.type) {
    case 'turn/start': {
      const turn = typeof data.turn === 'number' ? data.turn : fold.turns.length
      const node: TurnNode = {
        index: fold.turns.length + 1,
        turn,
        time: ev.time ?? Date.now(),
        userText: '',
        reply: '',
        edges: [],
        files: [],
      }
      fold.turns.push(node)
      fold.current = node
      return
    }
    case 'turn/end': {
      if (fold.current) fold.current.endReason = typeof data.reason === 'string' ? data.reason : 'done'
      fold.current = null
      return
    }
    case 'user/message': {
      if (!fold.current) return
      const msg = data as { content?: unknown }
      const text = messageText(msg.content)
      if (text && !fold.current.userText) fold.current.userText = text
      return
    }
    case 'assistant/message': {
      if (!fold.current) return
      const msg = data as { message?: { content?: unknown } }
      const text = messageText(msg.message?.content)
      // Keep only the LAST assistant text of the turn — intermediate messages
      // are reasoning/tool-loop chatter; the final one is the actual summary.
      // (Overwrite, don't concatenate.)
      if (text) fold.current.reply = text
      return
    }
    case 'tool/call': {
      const callId = typeof data.callId === 'string' ? data.callId : `call:${ev.seq}`
      const name = typeof data.name === 'string' ? data.name : 'tool'
      const args = typeof data.arguments === 'string' ? data.arguments : ''
      const parsed = parseArgs(args)
      const target = extractTarget(name, parsed)
      const edge: ToolEdge = {
        callId,
        name,
        arguments: args,
        target,
        summary: buildSummary(name, parsed, target),
        seq: ev.seq ?? 0,
      }
      fold.byCallId.set(callId, edge)
      if (fold.current) {
        fold.current.edges.push(edge)
        fold.bumpEdges(1)
        // Index the edge under a file node when it names a file path.
        const fileTag = classifyTool(name)
        if (fileTag && target) {
          const normalized = normalizePath(target)
          const file = findOrCreateFile(fold.current, normalized, target)
          file.edges.push(edge)
          if (fileTag === 'read') file.reads++
          else if (fileTag === 'write') file.writes++
          else file.searches++
        }
      }
      return
    }
    case 'tool/result': {
      const msg = data.message as { source?: { callId?: string } } | undefined
      const callId = msg?.source?.callId
      const edge = typeof callId === 'string' ? fold.byCallId.get(callId) : undefined
      if (edge) {
        edge.result = extractResult(data as Record<string, unknown>)
        if (data.error) edge.error = true
      }
      return
    }
    default:
      // step/start, step/end, assistant/chunk, todo/write, request/header, … ignored.
      return
  }
}

/** Read/write/search classification for a tool name. */
type FileTag = 'read' | 'write' | 'search'
function classifyTool(name: string): FileTag | undefined {
  switch (name) {
    case 'read': case 'read_image': return 'read'
    case 'write': case 'edit': return 'write'
    case 'grep': case 'glob': return 'search'
    default: return undefined
  }
}

function buildSummary(name: string, args: Record<string, unknown>, target?: string): string {
  const tag = actionTag(name)
  if (target) return `${tag} ${shortTarget(target)}`
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v) return `${tag} ${shortTarget(v)}`
  }
  return tag
}

/** Find or create the FileNode for a path on the current turn. */
function findOrCreateFile(turn: TurnNode, path: string, raw: string): FileNode {
  let file = turn.files.find(f => f.path === path)
  if (!file) {
    file = { path, name: basename(raw), edges: [], reads: 0, writes: 0, searches: 0 }
    turn.files.push(file)
  }
  return file
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  const last = parts[parts.length - 1]
  return last || p
}

/** Collapse `./`, `../`, and duplicate slashes for a stable grouping key. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\.\//g, '').replace(/\/$/, '') || p
}
