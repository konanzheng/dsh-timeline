/**
 * dsh-history client plugin — browser half (`dsh.client` module).
 *
 * Adds a "时间轴" toggle inside the built-in "轨迹" toolbar (left of its search
 * box). Opening it loads the CURRENT session's raw event history via
 * `connection.api.sessions.history` — the current session id resolved through
 * the standard runtime service `ctx.sessions.list` (never "the first session
 * in the list") — folds it into a trajectory graph ({@link buildGraph}), and
 * renders an S-shaped timeline ({@link renderTimeline}) where each turn is a
 * node carrying its user input, assistant reply, file sub-nodes, and tool-call
 * edges.
 *
 * This file is intentionally self-contained: it does not import the DSH
 * workspace packages (not published for standalone consumption). The browser
 * `ctx` is typed structurally.
 */
import { buildGraph, type TimelineGraph } from './model.ts'
import { renderTimeline } from './timeline.ts'
import type { ConnectionApi, HistoryEntry, RpcResponse } from './wire.ts'
import styles from './timeline.css'

/** Unwrap a unary RPC response to its business `value` (undefined on error/absent). */
function unwrap<T>(res: RpcResponse<T> | undefined): T | undefined {
  return res?.result?.ok ? res.result.value : undefined
}

/**
 * Minimal structural face of the runtime sessions service we consume
 * (`ctx.sessions.list` is the standard current-session feed).
 */
export interface HistorySessions {
  list?: {
    getSnapshot?(): { current?: string; byId?: Record<string, unknown> }
  }
}

/** Minimal structural face of the browser ctx we consume. */
export interface HistoryContext {
  effect?(fn: () => () => void): void
  slots?: unknown
  /** Standard runtime service: current session selection (see HistorySessions). */
  sessions?: HistorySessions
  /** Provided by @deepseek-ai/dsh-client-connection (injected). */
  connection?: ConnectionApi
}

/** Options accepted by `apply`. */
export interface HistoryOptions {
  /** Max history events to request per page (default 400). */
  maxMessages?: number
}

const DEFAULT_OPTS: Required<HistoryOptions> = { maxMessages: 400 }

/**
 * Client-entry injection target — the `connection` wire plus the standard
 * `sessions` runtime service (for the current session id).
 */
export const inject: string[] = ['connection', 'sessions']

/** Module-level cleanup hook, torn down on plugin unload. */
let overlayCleanup: (() => void) | null = null

/** Root element id used for removal on dispose. */
const ROOT_ID = 'dsh-history-root'

/**
 * Plugin body called by the DSH client module loader.
 * @param ctx - browser cordis context (structurally typed).
 * @param opts - optional plugin configuration.
 */
export function apply(ctx: HistoryContext, opts: HistoryOptions = {}): void {
  const o: Required<HistoryOptions> = { ...DEFAULT_OPTS, ...opts }
  mountPanel(o, ctx.connection, ctx.sessions)

  ;(window as unknown as { __historyCtx?: unknown; __historyConn?: unknown }).__historyCtx = ctx
  ;(window as unknown as { __historyConn?: unknown }).__historyConn = ctx.connection

  // Tear down on plugin dispose.
  ctx.effect?.(() => () => {
    overlayCleanup?.()
    overlayCleanup = null
    document.getElementById(ROOT_ID)?.remove()
  })
}

/**
 * Mount the panel + toggle button. The button is injected into the trajectory
 * toolbar (left of its search box) and ONLY there — on the conversation page
 * (no trajectory toolbar mounted) the button is removed, so the entry lives
 * exclusively inside the 轨迹 view. The DSH trajectory panel exposes no
 * standard child slot for third-party toolbar items, so the DOM insert with a
 * stable semantic anchor (`[role=toolbar]` + `input[type=search]`) is the
 * supported way to land there. Clicking it toggles the timeline panel anchored
 * over the middle content column; ESC closes it.
 */
function mountPanel(
  opts: Required<HistoryOptions>,
  connection?: ConnectionApi,
  sessions?: HistorySessions,
): void {
  const root = document.createElement('div')
  root.id = ROOT_ID
  root.className = 'dsh-history-root'
  root.innerHTML = `
    <style>${styles}</style>
    <div class="dsh-history-header">
      <span class="dsh-history-title">轨迹时间轴</span>
      <span class="dsh-history-sub">按交互轮次 · S 形排列</span>
      <button type="button" class="dsh-history-close" title="关闭 (ESC)">×</button>
    </div>
    <div class="dsh-history-stage"></div>
  `
  document.body.appendChild(root)

  const stage = root.querySelector<HTMLElement>('.dsh-history-stage')!
  const closeBtn = root.querySelector<HTMLElement>('.dsh-history-close')!

  // Anchor the panel to the middle content column, avoiding sidebar + composer.
  let panelRect: { x: number; y: number; w: number; h: number } | null = null
  const align = (): boolean => {
    const sc = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    const seat = document.querySelector<HTMLElement>('[data-composer-seat]')
    if (!sc) return false
    const sr = sc.getBoundingClientRect()
    const bottom = seat ? seat.getBoundingClientRect().top : sr.bottom
    const h = Math.max(0, bottom - sr.top)
    if (sr.width <= 0 || h <= 0) return false
    panelRect = { x: sr.left, y: sr.top, w: sr.width, h }
    return true
  }
  const applyRect = (): void => {
    if (!panelRect) return
    root.style.left = `${panelRect.x}px`
    root.style.top = `${panelRect.y}px`
    root.style.width = `${panelRect.w}px`
    root.style.height = `${panelRect.h}px`
  }

  let open = false
  let loadToken = 0

  const close = (): void => {
    if (!open) return
    open = false
    root.classList.remove('dsh-history-open')
    btn.classList.remove('dsh-history-active')
    loadToken++ // invalidate any in-flight render
  }

  const onKey = (e: KeyboardEvent): void => {
    // ESC closes the timeline panel — but NOT while a turn-detail window is
    // open (that window owns ESC; see timeline.ts openTurnDetail).
    if (e.key !== 'Escape') return
    if (document.querySelector('.dsh-history-detail')) return
    close()
  }
  window.addEventListener('keydown', onKey)

  const onResize = (): void => {
    if (open && align()) applyRect()
  }
  window.addEventListener('resize', onResize)

  // Re-anchor whenever the SPA re-renders the layout (throttled).
  let busy = false
  const mo = new MutationObserver(() => {
    if (busy) return
    busy = true
    setTimeout(() => { busy = false }, 120)
    if (align() && open) applyRect()
  })
  mo.observe(document.body, { childList: true, subtree: true, attributes: true })

  const openPanel = (): void => {
    if (open) return
    if (!align()) return
    open = true
    applyRect()
    root.classList.add('dsh-history-open')
    btn.classList.add('dsh-history-active')
    loadPanel()
  }

  const loadPanel = async (): Promise<void> => {
    const token = ++loadToken
    stage.innerHTML = '<div class="dsh-history-empty">正在加载轨迹…</div>'
    const graph = await fetchGraph(connection, sessions, opts.maxMessages)
    if (token !== loadToken) return
    stage.innerHTML = ''
    if (!graph || graph.turns.length === 0) {
      stage.innerHTML = '<div class="dsh-history-empty">暂无可展示的轨迹（当前会话为空）</div>'
      return
    }
    renderTimeline(stage, graph)
  }

  const toggle = (): void => (open ? close() : openPanel())

  closeBtn.addEventListener('click', () => close())

  // Inject the toggle button. Preferred home: inside the trajectory panel's
  // toolbar, immediately to the LEFT of its search box (the `[role=toolbar]`
  // with a `type=search` input). Fallback: the conversation tablist.
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'dsh-history-open-btn'
  btn.textContent = '时间轴'
  btn.title = '查看 S 形轨迹时间轴'
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle() })

  /** Find the trajectory toolbar's search box (stable semantics anchor). */
  const findSearchBox = (): HTMLElement | null => {
    const toolbars = document.querySelectorAll<HTMLElement>('[role=toolbar]')
    for (const tb of toolbars) {
      const input = tb.querySelector<HTMLElement>('input[type=search]')
      if (input) return input
    }
    return null
  }

  /**
   * Find the toolbar row the search box sits in — the flex-row parent that
   * holds the search AREA as one unit. The button lives OUTSIDE the search
   * control: as a sibling of the search area in that row. No getComputedStyle
   * here (MutationObserver callbacks must not force synchronous layout).
   *
   * NOTE: the input's own class matches `[class*=search]` (e.g. `searchInput`),
   * so the search AREA is resolved from the input's PARENT upward, never the
   * input itself.
   */
  const findSearchArea = (): HTMLElement | null => {
    const searchBox = findSearchBox()
    if (!searchBox) return null
    // Climb from the input's parent up to (but excluding) the toolbar root,
    // and return the first element whose class looks like the search area
    // (the wrapper that directly contains the input).
    let el = searchBox.parentElement
    const toolbar = searchBox.closest('[role=toolbar]')
    for (let i = 0; i < 4 && el && el !== toolbar; i++) {
      if (/\bsearch\b|search/i.test(el.className.toString())) return el
      el = el.parentElement
    }
    // Fall back to the input's immediate parent (the search area wrapper).
    return searchBox.parentElement
  }

  /** The toolbar's action row: the parent holding .actions + search area. */
  const findToolbarRow = (searchArea: HTMLElement): HTMLElement | null => {
    const toolbar = searchArea.closest('[role=toolbar]')
    // The search area's direct parent is the toolbar's flex row (.inner). Only
    // climb further if that parent looks like a single-child wrapper.
    let el: HTMLElement | null = searchArea.parentElement
    for (let i = 0; i < 3 && el && el !== toolbar; i++) {
      if (el.children.length >= 2) return el
      el = el.parentElement
    }
    return searchArea.parentElement
  }

  /** Last placed position, to skip redundant queries while already seated. */
  let seated = false
  const mountBtn = (): void => {
    // The button lives ONLY inside the trajectory toolbar (left of its search
    // area). On the conversation page (no trajectory toolbar mounted) the
    // button is removed entirely — no fallback tab, no leftover in the tablist.
    const searchArea = findSearchArea()
    if (searchArea) {
      const row = findToolbarRow(searchArea)
      if (row) {
        if (btn.parentElement === row && btn.nextElementSibling === searchArea) {
          seated = true
          return
        }
        row.insertBefore(btn, searchArea)
        btn.classList.add('dsh-history-in-toolbar')
        seated = true
        return
      }
    }
    // No trajectory toolbar: remove the button wherever it was (tablist, etc.).
    seated = false
    btn.classList.remove('dsh-history-in-toolbar')
    if (btn.isConnected) btn.remove()
  }
  const btnMo = new MutationObserver(mountBtn)
  btnMo.observe(document.body, { childList: true, subtree: true })
  mountBtn()

  // ── Auto-open: when the user switches to the 轨迹 view, show the timeline
  // panel right away (the toggle button lives in that view's toolbar, but
  // "default open on entering 轨迹" is the requested behavior). Detection:
  // watch the tablist for a tab labelled 轨迹 becoming selected. Only fires on
  // a transition into 轨迹 (not on every re-render, not on leaving it).
  let autoTabSeen = false
  const tryAutoOpen = (): void => {
    const tabs = document.querySelectorAll<HTMLElement>('[role=tablist] [role=tab]')
    for (const tab of tabs) {
      if (!tab.textContent?.trim().includes('轨迹')) continue
      const sel = tab.getAttribute('aria-selected') === 'true'
        || tab.getAttribute('data-state') === 'active'
        || tab.getAttribute('aria-current') === 'page'
      if (sel) {
        // 轨迹 tab is the active view — open the panel (once per activation).
        if (!autoTabSeen) {
          autoTabSeen = true
          requestAnimationFrame(() => {
            if (!open && document.querySelector('[role=toolbar]')) openPanel()
          })
        }
        return
      }
    }
    // No selected 轨迹 tab: the user left the trajectory view. If the panel
    // was open (auto-opened), close it — switching to 对话 dismisses the
    // timeline.
    autoTabSeen = false
    if (open) close()
  }
  const tabMo = new MutationObserver(() => {
    // Only react to attribute changes on tabs (aria-selected) — cheap and
    // targeted; openPanel itself does layout so keep this path light.
    tryAutoOpen()
  })
  // Observe any tablist wherever it appears (the app re-renders tabs).
  const tablistObs = (): void => {
    const tl = document.querySelector('[role=tablist]')
    if (tl && tl !== tabMoTarget) {
      tabMo.disconnect()
      tabMo.observe(tl, { attributes: true, attributeFilter: ['aria-selected', 'data-state', 'aria-current'], subtree: true })
      tabMoTarget = tl
    }
  }
  let tabMoTarget: Element | null = null
  // Re-scan for tablist on body mutations (SPA re-renders).
  const tabScanMo = new MutationObserver(() => tablistObs())
  tabScanMo.observe(document.body, { childList: true, subtree: true })
  tablistObs()
  // Initial state: if we're already on 轨迹 when the plugin mounts.
  tryAutoOpen()

  overlayCleanup = (): void => {
    window.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onResize)
    mo.disconnect()
    btnMo.disconnect()
    tabMo.disconnect()
    tabScanMo.disconnect()
    btn.remove()
    close()
  }
}

/**
 * Load the CURRENT session's raw event history and fold it into a graph.
 *
 * The session id comes from the standard runtime service `ctx.sessions.list`
 * (`.current` = the session the user actually has open), NOT from
 * `connection.api.sessions.list({})` — that RPC orders by updatedAt and its
 * first row is not necessarily the open session. Falls back to the RPC list
 * only when the runtime feed is unavailable.
 */
async function fetchGraph(
  connection: ConnectionApi | undefined,
  sessions: HistorySessions | undefined,
  maxMessages: number,
): Promise<TimelineGraph | null> {
  const api = connection?.api
  if (!api?.sessions) return null
  try {
    let sessionId: string | undefined
    const feed = sessions?.list?.getSnapshot?.()
    if (feed?.current) {
      sessionId = feed.current
    } else {
      // Fallback: most-recent session from the RPC list.
      const listRes = await api.sessions.list({})
      sessionId = unwrap(listRes)?.items?.[0]?.sessionId
    }
    if (!sessionId) {
      console.warn('[dsh-history] no current session:', { feed, connection: !!connection })
      return null
    }
    const histRes = await api.sessions.history({ sessionId, maxMessages })
    const events: HistoryEntry[] = unwrap(histRes)?.events ?? []
    return buildGraph(events)
  } catch (err) {
    console.warn('[dsh-history] fetchGraph failed:', err)
    return null
  }
}
