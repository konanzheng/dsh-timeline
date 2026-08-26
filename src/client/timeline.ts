/**
 * dsh-history — S-shaped timeline layout + renderer.
 *
 * Arranges the turn nodes from {@link buildGraph} into a grid using a
 * boustrophedon ("ox-plowing" / S-shape) order: the first row runs left→right,
 * the next row right→left, and so on. When a row is full the path turns down
 * and reverses direction — producing a continuous S through every node.
 *
 * Rendering is plain DOM: absolutely-positioned node cards over a full-size
 * absolutely-positioned SVG that draws the connecting path and arrowheads.
 * Node size is fixed (`--node-w` / node height), so column count derives from
 * the stage width.
 */
import type { TimelineGraph, ToolEdge, TurnNode } from './model.ts'

/** Layout metrics (px). */
export interface TimelineMetrics {
  nodeW: number
  nodeH: number
  gapX: number
  gapY: number
  colGap: number
  rowGap: number
  /** Vertical band reserved below the node card for the turn-back connector. */
  wrapBand: number
}

const DEFAULTS: TimelineMetrics = {
  nodeW: 264,
  nodeH: 132,
  gapX: 96,
  gapY: 120,
  colGap: 0,
  rowGap: 0,
  wrapBand: 56,
}

/** One positioned node with its grid coordinates. */
export interface PlacedNode {
  turn: TurnNode
  col: number
  row: number
  x: number
  y: number
}

/** Result of layout: node positions plus the S-path polyline through them. */
export interface Layout {
  nodes: PlacedNode[]
  /** Row-major column count. */
  columns: number
  /** Total width/height of the layout. */
  width: number
  height: number
  /** Traversal order polyline (absolute coords, in S order), for the SVG path. */
  pathPoints: Array<{ x: number; y: number }>
  /** Zoom factor this layout was computed at (1 = 100%). */
  zoom: number
}

/**
 * Compute the boustrophedon layout. `stageW` is the available inner width.
 * `cardHeights` holds the real rendered height of EVERY card (one per node, in
 * graph order); when absent the fixed `nodeH` is used.
 *
 * Rows never overlap: each row's top is computed from the TALLEST card in the
 * row above. But the S-path runs through each card's OWN center (`ry +
 * cardHeight_i/2`), so in a row with mixed card heights the connector hugs
 * every card instead of drifting to the tallest one's midline.
 */
export function layoutGraph(
  graph: TimelineGraph,
  stageW: number,
  metrics: TimelineMetrics = DEFAULTS,
  cardHeights?: number[],
  offsetY = 0,
): Layout {
  const { nodeW, nodeH, gapX, gapY, wrapBand } = metrics
  const usable = Math.max(200, stageW - 24)
  const stepX = nodeW + gapX
  const columns = Math.max(1, Math.floor((usable + gapX) / stepX))
  const nodes = graph.turns
  const rowCount = Math.ceil(nodes.length / columns)

  // Per-row "tallest card" height, for row spacing (never overlap).
  const rowMaxH: number[] = []
  for (let r = 0; r < rowCount; r++) {
    let h = nodeH
    for (let i = r * columns; i < Math.min(nodes.length, (r + 1) * columns); i++) {
      h = Math.max(h, cardHeights?.[i] ?? nodeH)
    }
    rowMaxH[r] = h
  }

  // Row top offsets from the measured (or estimated) row heights.
  const rowY: number[] = []
  let y = 12 + offsetY
  for (let r = 0; r < rowCount; r++) {
    rowY[r] = y
    y += rowMaxH[r] + gapY + wrapBand
  }

  const placed: PlacedNode[] = []
  const pathPoints: Array<{ x: number; y: number }> = []
  let maxX = 0
  let maxY = 0

  nodes.forEach((turn, i) => {
    const row = Math.floor(i / columns)
    const inRow = i % columns
    // Boustrophedon: odd rows are traversed right→left.
    const col = (row % 2 === 0) ? inRow : (columns - 1 - inRow)
    const x = 8 + col * stepX
    const ry = rowY[row]
    const h = cardHeights?.[i] ?? nodeH
    placed.push({ turn, col, row, x, y: ry })
    maxX = Math.max(maxX, x + nodeW)
    maxY = Math.max(maxY, ry + h)
    // Path center point — this card's OWN center, so the connector always
    // touches the card (mixed-height rows no longer detach shorter cards).
    pathPoints.push({ x: x + nodeW / 2, y: ry + h / 2 })
  })

  // Pad the canvas so the wrap band / last row have breathing room.
  const width = maxX + 8
  const height = maxY + gapY + 12

  return { nodes: placed, columns, width, height, pathPoints, zoom: nodeW / DEFAULTS.nodeW }
}

/**
 * Build a smooth SVG path `d` attribute through the node centers (Catmull-Rom
 * → cubic Bézier, so the S-shaped turns round off instead of making hard 90°
 * corners) plus per-segment arrowheads.
 *
 * The path is drawn *through* the node centers — the opaque node cards are
 * painted on top of the SVG, so the curve disappears under each card and
 * emerges with a continuous tangent on the other side. That is what makes the
 * connector feel like one flowing ribbon rather than a set of broken lines.
 */
export function buildPathData(
  points: Array<{ x: number; y: number }>,
  _metrics: TimelineMetrics = DEFAULTS,
): { line: string; arrows: string } {
  if (points.length < 2) return { line: '', arrows: '' }
  const n = points.length
  const d: string[] = []
  const arrows: string[] = []

  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(n - 1, i + 2)]
    // Catmull-Rom control points (tension 1/6).
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    if (i === 0) d.push(`M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`)
    d.push(`C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`)

    // Arrowhead at the segment midpoint, oriented along the curve tangent.
    const t = 0.5
    const mt = 1 - t
    const bx = mt * mt * mt * p1.x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * p2.x
    const by = mt * mt * mt * p1.y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * p2.y
    const tx = 3 * mt * mt * (c1x - p1.x) + 6 * mt * t * (c2x - c1x) + 3 * t * t * (p2.x - c2x)
    const ty = 3 * mt * mt * (c1y - p1.y) + 6 * mt * t * (c2y - c1y) + 3 * t * t * (p2.y - c2y)
    const tl = Math.hypot(tx, ty) || 1
    const ux = tx / tl
    const uy = ty / tl
    const s = 7
    const px = -uy
    const py = ux
    arrows.push(
      `M ${bx.toFixed(1)} ${by.toFixed(1)} ` +
      `L ${(bx - ux * s + px * s * 0.6).toFixed(1)} ${(by - uy * s + py * s * 0.6).toFixed(1)} ` +
      `L ${(bx - ux * s - px * s * 0.6).toFixed(1)} ${(by - uy * s - py * s * 0.6).toFixed(1)} Z`,
    )
  }

  return { line: d.join(' '), arrows: arrows.join(' ') }
}

/** Format a timestamp as a compact HH:MM. */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** Render the full timeline into `container` (a scrollable stage). Returns nothing. */
export function renderTimeline(container: HTMLElement, graph: TimelineGraph): void {
  container.innerHTML = ''
  // Per-turn "what is the AI doing" summaries + milestone markers — this is
  // the layer that turns a log into a readable line of thinking.
  const turnInsights = graph.turns.map(t => summarizeTurn(t))
  const milestones = markMilestones(graph)
  const milestoneByIndex = new Map(milestones.map(m => [m.index, m.kind]))
  const cards = graph.turns.map((turn, i) => renderNode(turn, turnInsights[i], milestoneByIndex.get(i)))

  const state: TimelineState = { container, graph, cards, svg: null, zoom: 1, insightH: 0 }

  // Insight strip: derived stats across the whole trajectory (not just a
  // different view — computed facts about the work itself).
  const insights = analyzeGraph(graph)
  if (insights) {
    const strip = renderInsightStrip(insights)
    container.appendChild(strip)
    state.insightH = strip.offsetHeight
  }

  // Clicking a card header opens a DETAIL WINDOW for that turn (the card
  // itself stays compact — it never expands in place). The panel is anchored
  // near the clicked card.
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i]
    const head = card.querySelector<HTMLElement>('.dsh-history-node-head')
    const turn = graph.turns[i]
    head?.addEventListener('click', () => {
      openTurnDetail(container, turn, card)
    })
  }

  relayout(state, false)

  // Ctrl/Cmd + wheel zooms the canvas: re-run the layout with scaled metrics
  // so the stage's scroll area grows/shrinks with the content.
  const onZoomWheel = (e: WheelEvent): void => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.zoom * factor))
    if (next === state.zoom) return
    state.zoom = next
    // Keep the point under the cursor roughly stationary: remember the stage
    // scroll offset ratio and the cursor position, then re-apply after relayout.
    const ratioX = container.scrollLeft / (container.scrollWidth - container.clientWidth || 1)
    const ratioY = container.scrollTop / (container.scrollHeight - container.clientHeight || 1)
    const cursorX = e.clientX - container.getBoundingClientRect().left
    const cursorY = e.clientY - container.getBoundingClientRect().top
    relayout(state, false)
    // Anchor the content to the cursor: keep the fractional scroll ratio but
    // nudge toward keeping the cursor's content-point fixed.
    requestAnimationFrame(() => {
      const maxSX = Math.max(0, container.scrollWidth - container.clientWidth)
      const maxSY = Math.max(0, container.scrollHeight - container.clientHeight)
      // Content point under the cursor, in old coordinate space:
      const oldScale = next / factor
      const contentX = (container.scrollLeft + cursorX) / oldScale
      const contentY = (container.scrollTop + cursorY) / oldScale
      container.scrollLeft = Math.max(0, Math.min(maxSX, contentX * next - cursorX))
      container.scrollTop = Math.max(0, Math.min(maxSY, contentY * next - cursorY))
      if (ratioX !== ratioX) container.scrollLeft = ratioX * maxSX
      if (ratioY !== ratioY) container.scrollTop = ratioY * maxSY
    })
  }
  container.addEventListener('wheel', onZoomWheel, { passive: false })
  ;(state as unknown as { disposeZoom?: () => void }).disposeZoom = () =>
    container.removeEventListener('wheel', onZoomWheel)

  // Kick the stagger animation on the next frame so the cards fade in after
  // the path has started drawing.
  requestAnimationFrame(() => {
    for (const el of cards) el.classList.add('dsh-history-in')
  })
}

/** Live layout state for one rendered timeline (kept so expand can re-flow). */
interface TimelineState {
  container: HTMLElement
  graph: TimelineGraph
  cards: HTMLElement[]
  svg: SVGSVGElement | null
  /** Current zoom factor (1 = 100%). Applied by re-running layoutGraph. */
  zoom: number
  /** Height of the insight strip (absolute overlay); layout starts below it. */
  insightH: number
}

/** Zoom limits (fraction of 100%). */
const ZOOM_MIN = 0.4
const ZOOM_MAX = 2.5

/** Column count for a given stage width (must match `layoutGraph`). */
function computeColumns(stageW: number): number {
  const usable = Math.max(200, stageW - 24)
  return Math.max(1, Math.floor((usable + DEFAULTS.gapX) / (DEFAULTS.nodeW + DEFAULTS.gapX)))
}

/**
 * Measure the real rendered height of EVERY card (respecting expanded state),
 * in graph order. Cards are cloned into an offscreen flex row so `offsetHeight`
 * reflects the true laid-out height of each card independently.
 */
function measureCardHeights(cards: HTMLElement[]): number[] {
  const hidden = document.createElement('div')
  hidden.className = 'dsh-history-measure'
  document.body.appendChild(hidden)
  const heights: number[] = []
  for (const el of cards) {
    hidden.innerHTML = ''
    hidden.appendChild(el.cloneNode(true))
    heights.push(hidden.offsetHeight || DEFAULTS.nodeH)
  }
  hidden.remove()
  return heights
}

/** Recompute layout from current (possibly expanded) card heights and apply it. */
function relayout(state: TimelineState, animate: boolean): void {
  const { container, graph, cards, zoom } = state
  const width = Math.max(container.clientWidth - 16, 320)
  const cardHeights = measureCardHeights(cards)
  // Zoom scales every metric (node size, gaps, wrap band) so the whole canvas
  // — cards AND connector — grows/shrinks together, and the stage's scroll
  // area follows the content size.
  const scaled: TimelineMetrics = {
    ...DEFAULTS,
    nodeW: DEFAULTS.nodeW * zoom,
    nodeH: DEFAULTS.nodeH * zoom,
    gapX: DEFAULTS.gapX * zoom,
    gapY: DEFAULTS.gapY * zoom,
    wrapBand: DEFAULTS.wrapBand * zoom,
  }
  const scaledHeights = cardHeights.map(h => h * zoom)
  const layout = layoutGraph(graph, width, scaled, scaledHeights, state.insightH)

  // min-WIDTH only: the stage is a flex-scroll viewport, so its height must
  // stay the flex-allocated one (never min-height — that would blow the panel
  // open instead of scrolling). The absolute cards + SVG overflow the stage
  // and the stage scrolls.
  container.style.minWidth = `${layout.width}px`

  // Rebuild the SVG path layer behind the cards.
  const svg = buildSvgLayer(layout)
  state.svg?.remove()
  container.insertBefore(svg, container.firstChild)
  state.svg = svg

  const position = (): void => {
    layout.nodes.forEach((placed, i) => {
      const el = cards[i]
      el.style.left = `${placed.x}px`
      el.style.top = `${placed.y}px`
      // Zoom: scale the card about its top-left corner so its painted size
      // matches the scaled gaps/path the layout computed above. The card's
      // layout width (--node-w) stays at its unscaled value — scaling it too
      // would double-zoom the card (layout width × transform).
      if (zoom !== 1) {
        el.style.transform = `scale(${zoom})`
        el.style.transformOrigin = 'left top'
      } else {
        el.style.transform = ''
      }
      if (el.parentElement !== container) container.appendChild(el)
    })
  }

  if (animate) {
    // Enable left/top transitions for the move, then clear the flag once the
    // new positions have been committed.
    container.classList.add('dsh-history-relayout')
    requestAnimationFrame(() => {
      position()
      requestAnimationFrame(() => container.classList.remove('dsh-history-relayout'))
    })
  } else {
    position()
  }
}

/** Build the SVG layer (smooth path + arrowheads + glow + travelling pulse). */
function buildSvgLayer(layout: Layout): SVGSVGElement {
  const svgNS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('class', 'dsh-history-path')
  svg.setAttribute('width', String(layout.width))
  svg.setAttribute('height', String(layout.height))

  // Energy gradient for the connector: blue → violet → pink along the path.
  const defs = document.createElementNS(svgNS, 'defs')
  const grad = document.createElementNS(svgNS, 'linearGradient')
  grad.setAttribute('id', 'dsh-history-energy')
  grad.setAttribute('x1', '0%')
  grad.setAttribute('y1', '0%')
  grad.setAttribute('x2', '100%')
  grad.setAttribute('y2', '100%')
  for (const [offset, color] of [['0%', '#4f6df5'], ['50%', '#8b5cf6'], ['100%', '#ec4899']] as const) {
    const stop = document.createElementNS(svgNS, 'stop')
    stop.setAttribute('offset', offset)
    stop.setAttribute('stop-color', color)
    grad.appendChild(stop)
  }
  defs.appendChild(grad)
  svg.appendChild(defs)

  const pathData = buildPathData(layout.pathPoints)
  if (pathData.line) {
    const line = document.createElementNS(svgNS, 'path')
    line.setAttribute('d', pathData.line)
    line.setAttribute('pathLength', '1')
    line.setAttribute('id', 'dsh-history-trajectory')
    line.setAttribute('class', 'path-line')
    svg.appendChild(line)

    const glow = document.createElementNS(svgNS, 'path')
    glow.setAttribute('d', pathData.line)
    glow.setAttribute('class', 'path-line path-glow')
    svg.appendChild(glow)

    // Fixed "energy node" glow at every card center — the connector appears to
    // plug into each node. (The moving pulse below travels along the path.)
    for (const pt of layout.pathPoints) {
      const dot = document.createElementNS(svgNS, 'circle')
      dot.setAttribute('cx', String(pt.x))
      dot.setAttribute('cy', String(pt.y))
      dot.setAttribute('r', '5.5')
      dot.setAttribute('class', 'path-node-dot')
      svg.appendChild(dot)
    }

    const pulse = document.createElementNS(svgNS, 'circle')
    pulse.setAttribute('r', String(3.5 * layout.zoom))
    pulse.setAttribute('class', 'path-pulse')
    const motion = document.createElementNS(svgNS, 'animateMotion')
    motion.setAttribute('dur', '3.8s')
    motion.setAttribute('repeatCount', 'indefinite')
    motion.setAttribute('rotate', 'auto')
    const mpath = document.createElementNS(svgNS, 'mpath')
    mpath.setAttribute('href', '#dsh-history-trajectory')
    mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#dsh-history-trajectory')
    motion.appendChild(mpath)
    pulse.appendChild(motion)
    svg.appendChild(pulse)
  }
  if (pathData.arrows) {
    const arrows = document.createElementNS(svgNS, 'path')
    arrows.setAttribute('d', pathData.arrows)
    arrows.setAttribute('class', 'path-arrow')
    svg.appendChild(arrows)
  }
  return svg
}

/** Derived stats for the insight strip (computed, not re-rendered data). */
interface GraphInsights {
  turnCount: number
  edgeCount: number
  fileCount: number
  /** Distinct file paths across ALL turns, weighted by touches. */
  hotFiles: Array<{ path: string; touches: number; writes: number }>
  errorCount: number
  /** Tool-kind distribution: read/write/search/exec/other counts. */
  kinds: { read: number; write: number; search: number; exec: number; other: number }
}

/**
 * One-line "what is the AI doing here" summary for a turn, derived from the
 * turn's own evidence (user ask + tool behavior). This is what turns a log
 * into a readable line of thinking.
 */
export interface TurnInsight {
  /** Short action verb phrase, e.g. "修复行重叠" / "搜索定位问题". */
  intent: string
  /** Evidence-backed note, e.g. "重点修改 timeline.ts". */
  note?: string
  /** Whether this turn contains a failed tool call. */
  hadError: boolean
  /** Whether this turn wrote more than it read (action-heavy). */
  actionHeavy: boolean
  /**
   * The tool-call CAUSE-CHAIN of this turn: which call followed which, and
   * what that implies ("read file X → edit file X"). Derived from the log
   * order + tool semantics, not a model.
   */
  chain: ChainLink[]
}

/** One step in a turn's cause-chain, with the relation to the previous step. */
export interface ChainLink {
  /** Step index within the turn (1-based). */
  step: number
  /** Tool name of this call. */
  tool: string
  /** Short target (file basename / url / command head). */
  target: string
  /** Relation to the previous step, or 'start'. */
  relation: 'start' | 'read→edit' | 'search→read' | 'edit→run' | 'run→check' | 'error→fix' | 'repeat'
  /** Whether this call failed. */
  error: boolean
}

/** Map a tool call to its causal "verb" for chaining. */
function toolVerb(edge: ToolEdge): 'read' | 'search' | 'edit' | 'run' | 'other' {
  switch (edge.name) {
    case 'read': case 'read_image': return 'read'
    case 'grep': case 'glob': case 'list': case 'ls': return 'search'
    case 'write': case 'edit': return 'edit'
    case 'bash': return 'run'
    default: return 'other'
  }
}

/** Infer the cause-chain of a turn's tool calls (pure heuristic). */
export function buildTurnChain(turn: TurnNode): ChainLink[] {
  const out: ChainLink[] = []
  let prevVerb: ReturnType<typeof toolVerb> | null = null
  let prevError = false
  for (const edge of turn.edges) {
    const verb = toolVerb(edge)
    let relation: ChainLink['relation'] = 'start'
    if (prevVerb) {
      if (prevError) relation = 'error→fix'
      else if (prevVerb === 'read' && verb === 'edit') relation = 'read→edit'
      else if (prevVerb === 'search' && verb === 'read') relation = 'search→read'
      else if (prevVerb === 'edit' && verb === 'run') relation = 'edit→run'
      else if (prevVerb === 'run' && verb === 'read') relation = 'run→check'
      else if (prevVerb === verb) relation = 'repeat'
      else relation = 'repeat'
    }
    out.push({
      step: out.length + 1,
      tool: edge.name,
      target: edge.target ?? edge.summary ?? '',
      relation,
      error: !!edge.error,
    })
    prevVerb = verb
    prevError = !!edge.error
  }
  return out
}

/**
 * Summarize a turn's tool-call PATTERNS into natural-language insight, e.g.
 *   - many grep/glob → "通过 `plugin`、`timeline` 等关键字搜索定位关键代码"
 *   - many read/write → "通过多次读写文件（读 N 次、改 M 次）最终实现正确逻辑"
 *   - many bash    → "多次执行命令验证/调试运行效果"
 *   - failures     → "过程中出现 N 次报错，经修复后通过"
 * Returns one string per pattern found (may be empty).
 */
export function summarizeToolPatterns(turn: TurnNode): string[] {
  const edges = turn.edges
  const reads = edges.filter(e => e.name === 'read' || e.name === 'read_image').length
  const writes = edges.filter(e => e.name === 'write' || e.name === 'edit').length
  const searches = edges.filter(e => e.name === 'grep' || e.name === 'glob').length
  const execs = edges.filter(e => e.name === 'bash').length
  const errors = edges.filter(e => e.error).length
  const out: string[] = []

  // 1. Search pattern: collect the keywords used.
  if (searches >= 2) {
    const kws = new Set<string>()
    for (const e of edges) {
      if ((e.name === 'grep' || e.name === 'glob') && e.target) {
        // target is the pattern; take a short form (up to ~14 chars).
        const k = e.target.replace(/^['"]|['"]$/g, '').split(/[\\/]/).pop() || ''
        if (k) kws.add(k.slice(0, 14))
      }
    }
    const kwList = [...kws].slice(0, 3).join('、')
    out.push(kwList
      ? `通过「${kwList}」等 ${searches} 次搜索定位关键代码`
      : `通过 ${searches} 次搜索定位关键代码`)
  }

  // 2. Read/write volume: frequency of touching files.
  if (reads + writes >= 3) {
    const freq = writes >= 8 ? '超多次' : writes >= 3 ? '多次' : writes > 0 ? '少量' : '多次'
    const bits: string[] = []
    if (reads) bits.push(`读 ${reads} 次`)
    if (writes) bits.push(`改 ${writes} 次`)
    out.push(`通过${freq}读写文件（${bits.join('、')}）最终实现正确逻辑`)
  }

  // 3. Execution pattern.
  if (execs >= 2) {
    out.push(`通过 ${execs} 次命令执行验证运行效果`)
  } else if (execs === 1 && (reads + writes) >= 2) {
    out.push('修改后执行命令验证效果')
  }

  // 4. Error/recovery.
  if (errors >= 1) {
    out.push(`过程中出现 ${errors} 次报错，经调试修复后通过`)
  }

  return out
}

/** Heuristic one-line summarizer. Pure string work — no model call. */
export function summarizeTurn(turn: TurnNode): TurnInsight {
  const user = turn.userText.trim()
  const edges = turn.edges
  const hadError = edges.some(e => e.error)

  // 1. Intent from the user's own words (first meaningful clause).
  let intent = '推进任务'
  if (user) {
    const cleaned = user
      .replace(/@[\w./-]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (cleaned.length <= 40) {
      intent = cleaned
    } else {
      // Take the leading clause up to the first full stop (、，。？!…) — or 24
      // chars with an ellipsis if no clean boundary appears early enough.
      const m = cleaned.match(/^(.{1,24}?)[、，。？！!?\n]/)
      if (m && m[1]) intent = m[1]
      else intent = cleaned.slice(0, 24) + '…'
    }
  }

  // 2. Note from tool behavior — keep it to the SINGLE most telling fact.
  let note: string | undefined
  const writes = edges.filter(e => e.name === 'write' || e.name === 'edit').length
  const reads = edges.filter(e => e.name === 'read' || e.name === 'read_image').length
  const execs = edges.filter(e => e.name === 'bash').length
  const searches = edges.filter(e => e.name === 'grep' || e.name === 'glob').length
  const topFile = turn.files.length
    ? [...turn.files].sort((a, b) => (b.reads + b.writes + b.searches) - (a.reads + a.writes + a.searches))[0]
    : undefined
  if (topFile && topFile.writes > 0) {
    note = `改 ${topFile.name}${topFile.writes > 1 ? `×${topFile.writes}` : ''}`
  } else if (topFile) {
    note = `看 ${topFile.name}`
  } else if (execs) {
    note = `${execs} 次执行`
  } else if (searches) {
    note = `搜索定位`
  }

  return {
    intent,
    note,
    hadError,
    actionHeavy: writes > reads,
    chain: buildTurnChain(turn),
  }
}

/**
 * Mark "milestone" turns across the whole graph: first error, first
 * action-heavy turn, and the turn after an error (repair attempt).
 */
export interface Milestone {
  index: number
  kind: 'first-error' | 'repair' | 'action'
}

export function markMilestones(graph: TimelineGraph): Milestone[] {
  const out: Milestone[] = []
  let firstErrorIdx = -1
  graph.turns.forEach((t, i) => {
    const ins = summarizeTurn(t)
    if (ins.hadError && firstErrorIdx < 0) {
      firstErrorIdx = i
      out.push({ index: i, kind: 'first-error' })
    }
    if (ins.actionHeavy) out.push({ index: i, kind: 'action' })
  })
  // Repair: the first action-heavy turn AFTER the first error.
  if (firstErrorIdx >= 0) {
    const repair = graph.turns.findIndex((t, i) => i > firstErrorIdx && summarizeTurn(t).actionHeavy)
    if (repair > 0) out.push({ index: repair, kind: 'repair' })
  }
  return out
}

/** Aggregate the whole trajectory into computed insights. */
function analyzeGraph(graph: TimelineGraph): GraphInsights | null {
  const turns = graph.turns
  if (!turns.length) return null
  const fileCounts = new Map<string, { touches: number; writes: number }>()
  const kinds = { read: 0, write: 0, search: 0, exec: 0, other: 0 }
  let errorCount = 0
  for (const turn of turns) {
    for (const edge of turn.edges) {
      if (edge.error) errorCount++
      switch (edge.name) {
        case 'read': case 'read_image': kinds.read++; break
        case 'write': case 'edit': kinds.write++; break
        case 'grep': case 'glob': kinds.search++; break
        case 'bash': kinds.exec++; break
        default: kinds.other++; break
      }
      if (edge.target) {
        const key = edge.target.replace(/\\/g, '/')
        const cur = fileCounts.get(key) ?? { touches: 0, writes: 0 }
        cur.touches++
        if (edge.name === 'write' || edge.name === 'edit') cur.writes++
        fileCounts.set(key, cur)
      }
    }
  }
  const hotFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1].touches - a[1].touches)
    .slice(0, 3)
    .map(([path, v]) => ({ path, touches: v.touches, writes: v.writes }))
  return {
    turnCount: turns.length,
    edgeCount: graph.edgeCount,
    fileCount: fileCounts.size,
    hotFiles,
    errorCount,
    kinds,
  }
}

/** Render the insight strip above the timeline cards. */
function renderInsightStrip(ins: GraphInsights): HTMLElement {
  const strip = document.createElement('div')
  strip.className = 'dsh-history-insights'

  const stat = (label: string, value: string): HTMLElement => {
    const s = document.createElement('div')
    s.className = 'dsh-history-insight-stat'
    const v = document.createElement('div')
    v.className = 'dsh-history-insight-value'
    v.textContent = value
    const l = document.createElement('div')
    l.className = 'dsh-history-insight-label'
    l.textContent = label
    s.append(v, l)
    return s
  }

  strip.appendChild(stat('轮次', String(ins.turnCount)))
  strip.appendChild(stat('工具调用', String(ins.edgeCount)))
  strip.appendChild(stat('文件', String(ins.fileCount)))
  if (ins.errorCount) {
    const e = stat('失败调用', String(ins.errorCount))
    e.classList.add('has-error')
    strip.appendChild(e)
  }

  // Hot files — the actual "where did the work happen" answer.
  if (ins.hotFiles.length) {
    const hot = document.createElement('div')
    hot.className = 'dsh-history-insight-hot'
    const hl = document.createElement('div')
    hl.className = 'dsh-history-insight-hot-label'
    hl.textContent = '高频文件'
    hot.appendChild(hl)
    for (const f of ins.hotFiles) {
      const row = document.createElement('div')
      row.className = 'dsh-history-insight-hot-row'
      const bar = document.createElement('div')
      bar.className = 'dsh-history-insight-hot-bar'
      const max = ins.hotFiles[0].touches
      bar.style.width = `${Math.round((f.touches / max) * 100)}%`
      row.appendChild(bar)
      const nm = document.createElement('span')
      nm.className = 'dsh-history-insight-hot-name'
      nm.textContent = f.path.split('/').pop() || f.path
      nm.title = f.path
      row.appendChild(nm)
      const ct = document.createElement('span')
      ct.className = 'dsh-history-insight-hot-count'
      ct.textContent = `${f.touches}${f.writes ? ` · ${f.writes}改` : ''}`
      row.appendChild(ct)
      hot.appendChild(row)
    }
    strip.appendChild(hot)
  }

  // Tool-kind distribution as a tiny stacked bar.
  const total = ins.kinds.read + ins.kinds.write + ins.kinds.search + ins.kinds.exec + ins.kinds.other
  if (total > 0) {
    const dist = document.createElement('div')
    dist.className = 'dsh-history-insight-dist'
    const seg = (n: number, cls: string): HTMLElement => {
      const s = document.createElement('div')
      s.className = `dsh-history-insight-dist-seg ${cls}`
      s.style.width = `${Math.max(2, (n / total) * 100)}%`
      s.title = `${cls} ${n}`
      return s
    }
    dist.append(
      seg(ins.kinds.read, 'read'),
      seg(ins.kinds.write, 'write'),
      seg(ins.kinds.search, 'search'),
      seg(ins.kinds.exec, 'exec'),
      seg(ins.kinds.other, 'other'),
    )
    strip.appendChild(dist)
  }

  return strip
}

/**
 * Open a detail window for one turn: full prompt, full reply, per-file
 * operation log, and every tool call with its arguments/result. The window is
 * a modal overlay inside the stage; ESC or the × button closes it. The card
 * itself stays compact — detail lives here, not in the card.
 *
 * `anchor` (the clicked card, optional) positions the panel NEAR the click —
 * it flips to stay inside the stage viewport (bottom cards get the panel
 * above them, not at the top where it's out of view).
 */
function openTurnDetail(container: HTMLElement, turn: TurnNode, anchor?: HTMLElement): void {
  const overlay = document.createElement('div')
  overlay.className = 'dsh-history-detail'
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })

  const panel = document.createElement('div')
  panel.className = 'dsh-history-detail-panel'

  // ── Position the panel near the anchor card (or center if no anchor).
  // Cards and the overlay share the stage's CONTENT coordinate space
  // (both absolute children of the scrollable stage), so the card's
  // offsetLeft/offsetTop are directly usable. The panel appears over the
  // clicked card's neighbourhood and scrolls along with the content it
  // covers — which is exactly where the user's attention is.
  const place = (): void => {
    const panelW = 720
    // The stage's visible height can read small while the panel is animating
    // open (clientHeight still collapsing); re-measure from the offsetParent's
    // viewport instead when it looks wrong, and never go below 200px.
    const viewH = Math.max(container.clientHeight, 200)
    const panelH = Math.min(640, viewH - 32)
    let px: number
    let py: number
    if (anchor && anchor.isConnected) {
      const cx = anchor.offsetLeft + anchor.offsetWidth / 2
      const cy = anchor.offsetTop + anchor.offsetHeight / 2
      px = cx - panelW / 2
      // Prefer below the card; flip above when there is no room below.
      const below = cy + anchor.offsetHeight / 2 + 12 + panelH
      py = below <= container.scrollTop + container.clientHeight ? cy + anchor.offsetHeight / 2 + 12 : cy - anchor.offsetHeight / 2 - 12 - panelH
    } else {
      px = Math.max(8, (container.clientWidth - panelW) / 2)
      py = Math.max(container.scrollTop + 8, (container.scrollTop + container.clientHeight - panelH) / 2)
    }
    // Clamp into the stage's content viewport.
    const vTop = container.scrollTop + 8
    const vLeft = container.scrollLeft + 8
    const vRight = container.scrollLeft + container.clientWidth - panelW - 8
    const vBottom = container.scrollTop + container.clientHeight - panelH - 8
    px = Math.max(vLeft, Math.min(px, Math.max(vLeft, vRight)))
    py = Math.max(vTop, Math.min(py, Math.max(vTop, vBottom)))
    overlay.style.left = `${px}px`
    overlay.style.top = `${py}px`
    overlay.style.width = `${Math.min(panelW, container.clientWidth - 16)}px`
    overlay.style.height = `${panelH}px`
    panel.style.maxHeight = `${panelH}px`
  }

  // Header
  const head = document.createElement('div')
  head.className = 'dsh-history-detail-head'
  const title = document.createElement('span')
  title.className = 'dsh-history-detail-title'
  title.textContent = `轮次 ${turn.turn} 详情`
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'dsh-history-close'
  closeBtn.textContent = '×'
  closeBtn.title = '关闭 (ESC)'
  head.append(title, closeBtn)
  panel.appendChild(head)

  const body = document.createElement('div')
  body.className = 'dsh-history-detail-body'

  // 1. 用户提问（最上）
  if (turn.userText) {
    const sec = section('问', turn.userText, 'user')
    body.appendChild(sec)
  }

  // 2. 工具模式归纳：把调用统计成一句话洞察（用户最关心的"过程重点"）
  const patterns = summarizeToolPatterns(turn)
  if (patterns.length) {
    const wrap = document.createElement('div')
    wrap.className = 'dsh-history-detail-section'
    const lab = document.createElement('div')
    lab.className = 'dsh-history-detail-label'
    lab.textContent = '过程归纳'
    wrap.appendChild(lab)
    for (const p of patterns) {
      const row = document.createElement('div')
      row.className = 'dsh-history-detail-pattern'
      row.textContent = p
      wrap.appendChild(row)
    }
    body.appendChild(wrap)
  }

  // 3. 逻辑链：本轮的因果步骤流（放在用户对话下方，替代冗余的工具列表）
  const chain = buildTurnChain(turn)
  if (chain.length) {
    const wrap = document.createElement('div')
    wrap.className = 'dsh-history-detail-section'
    const lab = document.createElement('div')
    lab.className = 'dsh-history-detail-label'
    lab.textContent = `逻辑链 · ${chain.length} 步`
    wrap.appendChild(lab)
    const flow = document.createElement('div')
    flow.className = 'dsh-history-detail-chain'
    chain.forEach((link, i) => {
      const stepRow = document.createElement('div')
      stepRow.className = 'dsh-history-detail-chain-row'
      const stepNo = document.createElement('span')
      stepNo.className = 'dsh-history-detail-chain-step'
      stepNo.textContent = String(link.step)
      stepRow.appendChild(stepNo)
      const rel = document.createElement('span')
      rel.className = `dsh-history-detail-chain-rel${link.relation === 'start' ? ' start' : ''}`
      rel.textContent = relationText(link.relation)
      rel.title = link.relation
      stepRow.appendChild(rel)
      const act = document.createElement('span')
      act.className = `dsh-history-detail-chain-act${link.error ? ' error' : ''}`
      act.textContent = `${link.tool}${link.target ? ` → ${link.target}` : ''}`
      stepRow.appendChild(act)
      if (link.error) {
        const err = document.createElement('span')
        err.className = 'dsh-history-detail-op-err'
        err.textContent = '失败'
        stepRow.appendChild(err)
      }
      flow.appendChild(stepRow)
    })
    wrap.appendChild(flow)
    body.appendChild(wrap)
  }

  // 4. 回复（总结）
  if (turn.reply) {
    const sec = section('答', turn.reply, 'reply')
    body.appendChild(sec)
  }

  // 5. 文件操作（按文件分组，含每个文件上的工具调用明细）
  if (turn.files.length) {
    const wrap = document.createElement('div')
    wrap.className = 'dsh-history-detail-section'
    const lab = document.createElement('div')
    lab.className = 'dsh-history-detail-label'
    lab.textContent = `文件操作 · ${turn.files.length}`
    wrap.appendChild(lab)
    for (const file of turn.files) {
      const row = document.createElement('div')
      row.className = 'dsh-history-detail-file'
      const nm = document.createElement('span')
      nm.className = 'dsh-history-detail-file-name'
      nm.textContent = file.path
      row.appendChild(nm)
      const cnt = document.createElement('span')
      cnt.className = 'dsh-history-detail-file-count'
      const bits: string[] = []
      if (file.reads) bits.push(`${file.reads}读`)
      if (file.writes) bits.push(`${file.writes}改`)
      if (file.searches) bits.push(`${file.searches}搜`)
      cnt.textContent = bits.join(' · ')
      row.appendChild(cnt)
      // The individual tool edges on this file
      const ops = document.createElement('div')
      ops.className = 'dsh-history-detail-ops'
      for (const edge of file.edges) {
        ops.appendChild(opRow(edge))
      }
      row.appendChild(ops)
      wrap.appendChild(row)
    }
    body.appendChild(wrap)
  }

  panel.appendChild(body)
  overlay.appendChild(panel)
  container.appendChild(overlay)
  // Position once immediately, then again on the next frame — the stage's
  // clientHeight can still be settling right after the panel opens (e.g. it
  // reads 54px during the open animation), so the second pass fixes the size.
  place()
  requestAnimationFrame(place)

  // ESC closes the detail window only — stop propagation so the outer panel's
  // ESC handler (which closes the whole timeline) doesn't also fire.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    e.stopImmediatePropagation()
    close()
  }
  window.addEventListener('keydown', onKey)
  function close(): void {
    window.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  closeBtn.addEventListener('click', close)
}

/** One labelled text section (问/答). */
function section(kind: string, text: string, cls: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'dsh-history-detail-section'
  const lab = document.createElement('div')
  lab.className = `dsh-history-detail-label dsh-history-detail-label-${cls}`
  lab.textContent = kind
  wrap.appendChild(lab)
  const val = document.createElement('div')
  val.className = `dsh-history-detail-text dsh-history-detail-${cls}`
  val.textContent = text
  wrap.appendChild(val)
  return wrap
}

/** One tool-call row: name + target, expandable args/result. */
function opRow(edge: ToolEdge): HTMLElement {
  const row = document.createElement('div')
  row.className = `dsh-history-detail-op${edge.error ? ' error' : ''}`
  const name = document.createElement('span')
  name.className = 'dsh-history-detail-op-name'
  name.textContent = edge.name
  row.appendChild(name)
  const target = document.createElement('span')
  target.className = 'dsh-history-detail-op-target'
  target.textContent = edge.target ?? edge.summary
  row.appendChild(target)
  if (edge.error) {
    const err = document.createElement('span')
    err.className = 'dsh-history-detail-op-err'
    err.textContent = '失败'
    row.appendChild(err)
  }
  // Collapsible detail: arguments / result.
  const detailText: string[] = []
  if (edge.arguments) detailText.push(`参数: ${edge.arguments}`)
  if (edge.result) detailText.push(`结果: ${edge.result.slice(0, 400)}`)
  if (detailText.length) {
    const det = document.createElement('pre')
    det.className = 'dsh-history-detail-op-detail'
    det.textContent = detailText.join('\n')
    det.hidden = true
    row.appendChild(det)
    row.addEventListener('click', () => { det.hidden = !det.hidden })
    row.title = '点击展开 / 折叠参数与结果'
  }
  return row
}

/** Build one node card DOM element. Compact by default; the header opens a
 *  detail window. Shows a one-line "what is the AI doing" intent label and an
 *  optional milestone badge (首次报错 / 修复 / 重点动作). */
function renderNode(turn: TurnNode, insight?: TurnInsight, milestone?: Milestone['kind']): HTMLElement {
  const card = document.createElement('div')
  card.className = 'dsh-history-node'
  card.style.setProperty('--node-w', `${DEFAULTS.nodeW}px`)

  const head = document.createElement('div')
  head.className = 'dsh-history-node-head'
  head.title = '点击查看详情'
  const chevron = document.createElement('span')
  chevron.className = 'dsh-history-chevron'
  chevron.textContent = '⋯'
  const badge = document.createElement('span')
  badge.className = 'dsh-history-node-badge'
  badge.textContent = String(turn.index)
  const title = document.createElement('span')
  title.className = 'dsh-history-node-title'
  title.textContent = `轮次 ${turn.turn}`
  const meta = document.createElement('span')
  meta.className = 'dsh-history-node-meta'
  const bits: string[] = []
  if (turn.files.length) bits.push(`${turn.files.length} 文件`)
  if (turn.edges.length) bits.push(`${turn.edges.length} 操作`)
  meta.textContent = bits.join(' · ')
  const time = document.createElement('span')
  time.className = 'dsh-history-node-time'
  time.textContent = formatTime(turn.time)
  head.append(chevron, badge, title, meta, time)
  card.appendChild(head)

  // One-line thinking label: the AI's intent this turn, derived from the ask.
  if (insight) {
    const label = document.createElement('div')
    label.className = `dsh-history-intent${insight.hadError ? ' has-error' : ''}`
    const mark = document.createElement('span')
    mark.className = 'dsh-history-intent-mark'
    mark.textContent = milestone
      ? milestone === 'first-error' ? '⚠ 首次报错'
      : milestone === 'repair' ? '🔧 修复'
      : '⚡ 重点动作'
      : insight.hadError ? '⚠ 有报错' : '→'
    label.appendChild(mark)
    const text = document.createElement('span')
    text.className = 'dsh-history-intent-text'
    text.textContent = insight.intent
    label.appendChild(text)
    if (insight.note) {
      const note = document.createElement('span')
      note.className = 'dsh-history-intent-note'
      note.textContent = insight.note
      label.appendChild(note)
    }
    card.appendChild(label)
  }

  // Mini cause-chain strip: condensed rhythm of the turn's tool calls.
  if (insight && insight.chain.length) {
    const chainEl = document.createElement('div')
    chainEl.className = 'dsh-history-chain'
    let prevLink: ChainLink | null = null
    for (const link of insight.chain) {
      if (prevLink) {
        const arrow = document.createElement('span')
        arrow.className = 'dsh-history-chain-arrow'
        arrow.textContent = relationArrow(link.relation)
        arrow.title = relationText(link.relation)
        chainEl.appendChild(arrow)
      }
      const node = document.createElement('span')
      node.className = `dsh-history-chain-link${link.error ? ' error' : ''}${link.relation === 'start' ? ' first' : ''}`
      node.textContent = chainLabel(link)
      node.title = `${link.tool}${link.target ? ` — ${link.target}` : ''}`
      chainEl.appendChild(node)
      prevLink = link
    }
    card.appendChild(chainEl)
  }

  const body = document.createElement('div')
  body.className = 'dsh-history-node-body'
  if (turn.userText) {
    const u = document.createElement('div')
    u.className = 'dsh-history-user'
    u.textContent = turn.userText
    body.appendChild(u)
  }
  if (turn.reply) {
    const r = document.createElement('div')
    r.className = 'dsh-history-reply'
    r.textContent = turn.reply
    body.appendChild(r)
  }
  card.appendChild(body)

  // File sub-nodes — one compact horizontal strip (label + file chips).
  if (turn.files.length > 0) {
    const filesEl = document.createElement('div')
    filesEl.className = 'dsh-history-files'
    const label = document.createElement('div')
    label.className = 'dsh-history-files-label'
    label.textContent = `文件 · ${turn.files.length}`
    filesEl.appendChild(label)
    const inner = document.createElement('div')
    inner.className = 'dsh-history-files-inner'
    for (const file of turn.files) {
      inner.appendChild(renderFile(file.path, file.name, file.reads, file.writes, file.searches))
    }
    filesEl.appendChild(inner)
    card.appendChild(filesEl)
  }

  // Tool-call chips — hidden in the compact card (full detail lives in the
  // detail window); shown only when the card is expanded.
  if (turn.edges.length > 0) {
    const toolsEl = document.createElement('div')
    toolsEl.className = 'dsh-history-tools'
    for (const edge of turn.edges) {
      toolsEl.appendChild(renderChip(edge))
    }
    card.appendChild(toolsEl)
  }

  // Reveal-order index is applied by the caller; collapsed clamp stays CSS-side.
  return card
}

/** Compact label for one chain link: `读 timeline.ts` → tool glyph + basename. */
function chainLabel(link: ChainLink): string {
  const name = link.tool
  const tag =
    name === 'read' || name === 'read_image' ? '读'
    : name === 'write' || name === 'edit' ? '改'
    : name === 'grep' || name === 'glob' ? '搜'
    : name === 'bash' ? '执行'
    : name
  // For commands, show only the head word(s); for files, the basename.
  let target = ''
  if (link.target) {
    if (name === 'bash') {
      target = ` ${link.target.replace(/\s+/g, ' ').slice(0, 18)}`
    } else {
      target = ` ${link.target.split(/[\\/]/).pop() || ''}`
    }
  }
  return `${tag}${target}`
}

/** Arrow glyph between chain links, by relation. */
function relationArrow(rel: ChainLink['relation']): string {
  switch (rel) {
    case 'read→edit': return '→'
    case 'search→read': return '→'
    case 'edit→run': return '▶'
    case 'run→check': return '↩'
    case 'error→fix': return '⚠→'
    case 'repeat': return '·'
    default: return '→'
  }
}

/** Tooltip text for a relation. */
function relationText(rel: ChainLink['relation']): string {
  switch (rel) {
    case 'read→edit': return '读后修改（理解→动手）'
    case 'search→read': return '搜索定位后深入读取'
    case 'edit→run': return '修改后运行验证'
    case 'run→check': return '运行后检查结果'
    case 'error→fix': return '出错后修复'
    case 'repeat': return '同类操作继续'
    default: return '开始'
  }
}

/** Render a single file sub-node row. */
function renderFile(
  path: string,
  name: string,
  reads: number,
  writes: number,
  searches: number,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'dsh-history-file'
  row.title = path

  const tag = document.createElement('span')
  const tagClass = writes > 0 ? 'write' : searches > 0 ? 'search' : ''
  tag.className = `dsh-history-file-tag ${tagClass}`.trim()
  tag.textContent = writes > 0 ? '改' : searches > 0 ? '搜' : '读'
  row.appendChild(tag)

  const nameEl = document.createElement('span')
  nameEl.className = 'dsh-history-file-name'
  nameEl.textContent = name
  row.appendChild(nameEl)

  const count = document.createElement('span')
  count.className = 'dsh-history-file-count'
  const bits: string[] = []
  if (reads) bits.push(`${reads}读`)
  if (writes) bits.push(`${writes}改`)
  if (searches) bits.push(`${searches}搜`)
  count.textContent = bits.join(' ')
  row.appendChild(count)

  return row
}

/** Render a tool-call chip. */
function renderChip(edge: ToolEdge): HTMLElement {
  const chip = document.createElement('span')
  chip.className = `dsh-history-tool-chip${edge.error ? ' error' : ''}`
  chip.textContent = edge.summary || edge.name
  chip.title = `${edge.name}${edge.target ? ` — ${edge.target}` : ''}`
  return chip
}
