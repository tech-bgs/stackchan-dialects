// @ts-nocheck
/** Bitmap / RuntimeBitmapPort / PIU shell counters for photo preview chunk-heap diagnosis. */

/**
 * Post-capture display corruption (same suspected root: Poco displayList / scratch).
 * Fix priority: photo preview (black screen, fill-overwrite on repaint) — PhotoFrame / DL-STATE.
 * Deferred until preview path is stable — do not chase checkbox/face shaders separately.
 *
 * Recorded symptoms (persist until reboot; reproducible after photo capture):
 * - Photo preview: face visible briefly, then black fill from onDraw#2+ / fill-only flush
 * - Main face LCD: vertical color stripes / mosaic
 * - Menu chrome: checkbox tiles square → tall vertical rectangles (stride/rowBytes class)
 *
 * Root cause (2025): Moddable PocoRectangleFill had `pc->h;` instead of `pc->h = h` — garbage
 * fill height (e.g. wh=320x3869) corrupts Poco scratch → all UI. Fixed in commodettoPocoBlit.c.
 * Trace tag `[PhotoFill]` logs Fill input/clip/built/at-DrawingEnd without armPhotoFlushIliTrace.
 */
export const PHOTO_POST_CAPTURE_CORRUPTION_DEFERRED = true

let photoKnownCorruptionLogged = false

/** One-line firmware log so xsbug grep ties UI glitches to the same incident. */
export function tracePhotoKnownCorruptionSymptomsOnce(): void {
  if (photoKnownCorruptionLogged) {
    return
  }
  photoKnownCorruptionLogged = true
  trace(
    `[PhotoGfx] known-post-capture corruption (deferred): stripes/mosaic on face; checkbox aspect wrong; active fix=preview-black/fill-overwrite fw=${PHOTO_FW_TRACE_TAG}\n`,
  )
}

/** Keep in sync with camera-preview PHOTO_FW_TRACE_TAG. */
const PHOTO_FW_TRACE_TAG = 'v22-photo-phase-trace'
import { getXsChunkHeapUsed } from './photo-session-diagnostics.js'

export type PhotoOverlayLifecycleSnapshot = {
  buildCount: number
  disposeCount: number
  liveCount: number
}

export type PhotoGfxCheckpointOptions = {
  livePort?: unknown
  /** Overlay shell after dispose — probe PIU parent retention. */
  staleOverlay?: unknown
  shellId?: number
  sharedBitmap?: { held: boolean; width: number; height: number }
  overlay?: PhotoOverlayLifecycleSnapshot
}

export type PhotoGraphicsDiagnostics = {
  sharedBitmapCount: number
  sharedBitmapSize: string
  bitmapConstructCount: number
  bitmapReuseCount: number
  bitmapReplaceCount: number
  portBitmapBindCount: number
  portBitmapClearCount: number
  portLiveRuntimeBinding: number
  portOnDrawCount: number
  textureConstructCount: number
  piuShellNodesBuilt: number
  overlayBuildCount: number
  overlayDisposeCount: number
  overlayLiveCount: number
  portBindUncleared: number
  shellMounted: number
}

let bitmapConstructCount = 0
let bitmapReuseCount = 0
let bitmapReplaceCount = 0
let portBitmapBindCount = 0
let portBitmapClearCount = 0
let portOnDrawCount = 0
let photoPreviewShellDisplayingCount = 0
let photoPreviewPortDisplayingCount = 0
let textureConstructCount = 0
let piuShellNodesBuilt = 0
let lastGfxCheckpointChunk: number | undefined
let photoDrawBlitSuccess = 0
let photoDrawBlitFail = 0
let photoDrawBackdropOnly = 0
let lastPhotoDrawFailReason = 'none'
let photoPreviewLastMeanLuma = -1
let photoPreviewLastCenterLuma = -1

export function notePhotoDrawBlit(success: boolean, reason?: string): void {
  if (success) {
    photoDrawBlitSuccess += 1
    return
  }
  photoDrawBlitFail += 1
  if (reason) {
    lastPhotoDrawFailReason = reason
  }
}

export function notePhotoDrawBackdropOnly(): void {
  photoDrawBackdropOnly += 1
}

export function getPhotoPortOnDrawCount(): number {
  return portOnDrawCount
}

const setPhotoPocoOnDrawFrameNative = native('xs_stackchan_photo_set_on_draw_frame')

/** Correlate Poco DL-STATE / flush with PIU onDraw#1..#3 (grep PhotoFrame). */
export function setPhotoPocoOnDrawFrame(frame: number): void {
  try {
    setPhotoPocoOnDrawFrameNative.call(undefined, frame | 0)
  } catch {
    /* native optional until rebuild */
  }
}

/**
 * Per onDraw paint composition (fill queued vs bitmap blit vs later flush).
 * Logged for onDraw#1..#6 — grep: PhotoFrame onDraw#
 */
export function tracePhotoFrameComposition(onDrawN: number, step: string, detail: string): void {
  if (onDrawN > 6) {
    return
  }
  trace(
    `[PhotoFrame] onDraw#${onDrawN} step=${step} ${detail} globalOnDraw=${portOnDrawCount} repaints=${photoRepaintCount} fw=${PHOTO_FW_TRACE_TAG}\n`,
  )
}

export function notePhotoPreviewLuma(meanLuma: number, centerLuma: number): void {
  photoPreviewLastMeanLuma = meanLuma
  photoPreviewLastCenterLuma = centerLuma
}

export function getPhotoPreviewLuma(): { meanLuma: number; centerLuma: number } {
  return { meanLuma: photoPreviewLastMeanLuma, centerLuma: photoPreviewLastCenterLuma }
}

export function tracePhotoDrawSummary(phase: string): void {
  const luma =
    photoPreviewLastMeanLuma >= 0
      ? ` meanLuma=${photoPreviewLastMeanLuma} centerLuma=${photoPreviewLastCenterLuma}`
      : ''
  const line = `summary ${phase}: onDraw=${portOnDrawCount} blitOk=${photoDrawBlitSuccess} blitFail=${photoDrawBlitFail} backdropOnly=${photoDrawBackdropOnly} lastFail=${lastPhotoDrawFailReason}${luma} fw=${PHOTO_FW_TRACE_TAG}`
  trace(`[PhotoDraw] ${line}\n`)
  trace(`[Photo] PhotoDraw ${line}\n`)
}

/** Log one onDraw pass (grep: PhotoDraw onDraw). */
export function tracePhotoDrawOnDraw(detail: {
  n: number
  path: string
  drew: boolean
  reason?: string
  frameWxH?: string
  bitmapWxH?: string
  bitmapFormat?: number | string
  atX?: number
  atY?: number
  sw?: number
  sh?: number
  portWxH?: string
  nativeOk?: boolean
  bufferBytes?: number
  hasCachedBitmap?: boolean
}): void {
  const {
    n,
    path,
    drew,
    reason = '',
    frameWxH = '',
    bitmapWxH = '',
    bitmapFormat = '',
    atX = '',
    atY = '',
    sw = '',
    sh = '',
    portWxH = '',
    nativeOk = '',
    bufferBytes = '',
    hasCachedBitmap = '',
  } = detail
  const line = `onDraw#${n} path=${path} drew=${drew ? 1 : 0} reason=${reason || (drew ? 'ok' : 'unknown')} frame=${frameWxH} bitmap=${bitmapWxH} fmt=${bitmapFormat} at=${atX},${atY} sw=${sw} sh=${sh} port=${portWxH} native=${nativeOk} bufB=${bufferBytes} cached=${hasCachedBitmap} fw=${PHOTO_FW_TRACE_TAG}`
  trace(`[PhotoDraw] ${line}\n`)
  if (n <= 6 || !drew) {
    trace(`[Photo] PhotoDraw ${line}\n`)
  }
}

let photoRepaintCount = 0
let photoLcdPaintTraceActive = false
let photoLcdRepaintsAfterFirstOnDraw = 0

export function setPhotoLcdPaintTraceActive(active: boolean): void {
  photoLcdPaintTraceActive = active
  if (active) {
    photoLcdRepaintsAfterFirstOnDraw = 0
    trace(`[PhotoLcd] trace ON (grep PhotoLcd — onDraw#1 backdrop/blit, repaints after onDraw)\n`)
  } else {
    trace(
      `[PhotoLcd] trace OFF repaintsAfterOnDraw#1=${photoLcdRepaintsAfterFirstOnDraw} totalRepaints=${photoRepaintCount}\n`,
    )
  }
}

export function isPhotoLcdPaintTraceActive(): boolean {
  return photoLcdPaintTraceActive
}

export function tracePhotoLcdOnDrawSteps(n: number, step: 'backdrop-fill' | 'blit', detail: string): void {
  if (!photoLcdPaintTraceActive) return
  trace(`[PhotoLcd] onDraw#${n} ${step} ${detail} fw=${PHOTO_FW_TRACE_TAG}\n`)
}

export function tracePhotoLcdOnDrawResult(
  n: number,
  drew: boolean,
  path: string,
  atX: number,
  atY: number,
  sw: number,
  sh: number,
): void {
  if (!photoLcdPaintTraceActive) return
  trace(
    `[PhotoLcd] onDraw#${n} result drew=${drew ? 1 : 0} path=${path} blitAt=${atX},${atY} sw=${sw} sh=${sh} backdropOnly=${drew ? 0 : 1} fw=${PHOTO_FW_TRACE_TAG}\n`,
  )
}

export function getPhotoLcdPaintSnapshot(): {
  onDraw: number
  repaintCount: number
  repaintsAfterOnDraw1: number
  blitOk: number
  blitFail: number
  backdropOnly: number
} {
  return {
    onDraw: portOnDrawCount,
    repaintCount: photoRepaintCount,
    repaintsAfterOnDraw1: photoLcdRepaintsAfterFirstOnDraw,
    blitOk: photoDrawBlitSuccess,
    blitFail: photoDrawBlitFail,
    backdropOnly: photoDrawBackdropOnly,
  }
}

export function tracePhotoLcdMountTick(tick: number, detail: string): void {
  if (!photoLcdPaintTraceActive) return
  trace(`[PhotoLcd] mount tick=${tick} ${detail} fw=${PHOTO_FW_TRACE_TAG}\n`)
}

export function notePhotoRepaint(source: string): void {
  photoRepaintCount += 1
  if (photoRepaintCount <= 24) {
    trace(`[PhotoRepaint] #${photoRepaintCount} ${source} onDraw=${portOnDrawCount} fw=${PHOTO_FW_TRACE_TAG}\n`)
  }
  if (photoLcdPaintTraceActive && portOnDrawCount >= 1) {
    photoLcdRepaintsAfterFirstOnDraw += 1
    trace(
      `[PhotoLcd] repaint-after-onDraw#${portOnDrawCount} n=${photoLcdRepaintsAfterFirstOnDraw} source=${source} fw=${PHOTO_FW_TRACE_TAG}\n`,
    )
  }
}

export function getPhotoRepaintCount(): number {
  return photoRepaintCount
}

export function tracePhotoDrawNote(message: string): void {
  trace(`[PhotoDraw] ${message}\n`)
  trace(`[Photo] PhotoDraw ${message}\n`)
}

let photoNativeTraceCount = 0
const PHOTO_NATIVE_TRACE_MAX = 48

/** Same xsbug `<log>` path as [PhotoDraw] (`trace()`), not modLog/UART. */
export function tracePhotoNativeNote(message: string): void {
  if (photoNativeTraceCount >= PHOTO_NATIVE_TRACE_MAX) {
    return
  }
  photoNativeTraceCount += 1
  trace(`[PhotoNative] ${message}\n`)
}

export function notePhotoBitmapConstruct(replaced: boolean): void {
  if (replaced) {
    bitmapReplaceCount += 1
  } else {
    bitmapConstructCount += 1
  }
}

export function notePhotoBitmapReuse(): void {
  bitmapReuseCount += 1
}

export function notePhotoPortBitmapBind(): void {
  portBitmapBindCount += 1
}

export function notePhotoPortBitmapClear(): void {
  portBitmapClearCount += 1
}

export function notePhotoPortOnDraw(): void {
  portOnDrawCount += 1
}

/** Photo preview path does not use PIU Texture; counter for accidental creates. */
export function notePhotoTextureConstruct(): void {
  textureConstructCount += 1
}

/** Backdrop + preview Port + overlay Container per buildPhotoResultOverlay. */
export function notePhotoPiuShellNodes(count: number): void {
  piuShellNodesBuilt += count | 0
}

export function resetPhotoPortOnDrawCount(): void {
  portOnDrawCount = 0
  photoPreviewShellDisplayingCount = 0
  photoPreviewPortDisplayingCount = 0
}

export function notePhotoPreviewShellDisplaying(): void {
  photoPreviewShellDisplayingCount += 1
}

export function notePhotoPreviewPortDisplaying(): void {
  photoPreviewPortDisplayingCount += 1
}

export function getPhotoPreviewDisplayingStats(): {
  shellDisplaying: number
  portDisplaying: number
  onDraw: number
} {
  return {
    shellDisplaying: photoPreviewShellDisplayingCount,
    portDisplaying: photoPreviewPortDisplayingCount,
    onDraw: portOnDrawCount,
  }
}

export function probePhotoPortRuntimeBitmapHeld(port: unknown): boolean {
  if (port == null || typeof port !== 'object') {
    return false
  }
  const binding = (port as { _runtimeBitmap?: unknown })._runtimeBitmap
  return binding !== undefined && binding != null
}

export function probePiuShellMounted(content: unknown): boolean {
  if (content == null || typeof content !== 'object') {
    return false
  }
  return !!(content as { container?: unknown }).container
}

function inferRetentionHint(d: PhotoGraphicsDiagnostics, chunkDelta: number | undefined): string {
  if (d.overlayLiveCount > 0) {
    return 'overlay-live-imbalance'
  }
  if (d.portLiveRuntimeBinding > 0) {
    return 'runtime-bitmap-bind-held'
  }
  if (d.shellMounted > 0) {
    return 'piu-shell-still-mounted'
  }
  if (d.portBindUncleared > 0) {
    return 'port-bind-uncleared'
  }
  if (d.bitmapReplaceCount > 0) {
    return 'shared-bitmap-replaced'
  }
  if (chunkDelta != null && chunkDelta > 65536 && d.overlayLiveCount === 0 && d.portLiveRuntimeBinding === 0) {
    return 'chunk-up-no-live-overlay-suspect-piu-gfx'
  }
  if (chunkDelta != null && chunkDelta > 32768 && d.overlayLiveCount === 0) {
    return 'chunk-up-after-dismiss'
  }
  return 'ok'
}

export function getPhotoGraphicsDiagnostics(
  sharedBitmap: { held: boolean; width: number; height: number } = { held: false, width: 0, height: 0 },
  livePort?: unknown,
  overlay: PhotoOverlayLifecycleSnapshot = { buildCount: 0, disposeCount: 0, liveCount: 0 },
  staleOverlay?: unknown,
): PhotoGraphicsDiagnostics {
  const portBindUncleared = Math.max(0, portBitmapBindCount - portBitmapClearCount)
  return {
    sharedBitmapCount: sharedBitmap.held ? 1 : 0,
    sharedBitmapSize: sharedBitmap.held ? `${sharedBitmap.width}x${sharedBitmap.height}` : 'none',
    bitmapConstructCount,
    bitmapReuseCount,
    bitmapReplaceCount,
    portBitmapBindCount,
    portBitmapClearCount,
    portLiveRuntimeBinding: probePhotoPortRuntimeBitmapHeld(livePort) ? 1 : 0,
    portOnDrawCount,
    textureConstructCount,
    piuShellNodesBuilt,
    overlayBuildCount: overlay.buildCount,
    overlayDisposeCount: overlay.disposeCount,
    overlayLiveCount: overlay.liveCount,
    portBindUncleared,
    shellMounted: probePiuShellMounted(staleOverlay) ? 1 : 0,
  }
}

/**
 * Compact checkpoint for capture/dismiss correlation (grep: PhotoGfxCheckpoint).
 * Logs priority counters + XS chunk delta.
 */
export function tracePhotoGfxCheckpoint(phase: string, options: PhotoGfxCheckpointOptions = {}): void {
  const chunk = getXsChunkHeapUsed()
  let chunkDelta: number | undefined
  let chunkPart: string
  if (chunk == null) {
    chunkPart = 'chunk=? chunkDelta=?'
  } else if (lastGfxCheckpointChunk == null) {
    lastGfxCheckpointChunk = chunk
    chunkPart = `chunk=${chunk} chunkDelta=baseline`
  } else {
    chunkDelta = chunk - lastGfxCheckpointChunk
    lastGfxCheckpointChunk = chunk
    const sign = chunkDelta >= 0 ? '+' : ''
    chunkPart = `chunk=${chunk} chunkDelta=${sign}${chunkDelta}`
  }
  const sharedBitmap = options.sharedBitmap ?? { held: false, width: 0, height: 0 }
  const d = getPhotoGraphicsDiagnostics(sharedBitmap, options.livePort, options.overlay, options.staleOverlay)
  const shellPart = options.shellId != null ? ` shell#${options.shellId}` : ''
  const hint = inferRetentionHint(d, chunkDelta)
  trace(
    `[PhotoGfxCheckpoint] ${phase}${shellPart}: ${chunkPart} bitmapNew=${d.bitmapConstructCount} bitmapReuse=${d.bitmapReuseCount} bitmapReplace=${d.bitmapReplaceCount} overlayBuild=${d.overlayBuildCount} overlayDispose=${d.overlayDisposeCount} overlayLive=${d.overlayLiveCount} portBind=${d.portBitmapBindCount} portClear=${d.portBitmapClearCount} portLiveBind=${d.portLiveRuntimeBinding} portBindUncleared=${d.portBindUncleared} piuNodesBuilt=${d.piuShellNodesBuilt} shellMounted=${d.shellMounted} hint=${hint}\n`,
  )
}

export function tracePhotoGraphicsInventory(
  phase: string,
  sharedBitmap: { held: boolean; width: number; height: number },
  livePort?: unknown,
  overlay: PhotoOverlayLifecycleSnapshot = { buildCount: 0, disposeCount: 0, liveCount: 0 },
  staleOverlay?: unknown,
): void {
  tracePhotoGfxCheckpoint(phase, { livePort, sharedBitmap, overlay, staleOverlay })
}

/** @internal Test hook */
export function resetPhotoGraphicsDiagnosticsForTest(): void {
  bitmapConstructCount = 0
  bitmapReuseCount = 0
  bitmapReplaceCount = 0
  portBitmapBindCount = 0
  portBitmapClearCount = 0
  portOnDrawCount = 0
  textureConstructCount = 0
  piuShellNodesBuilt = 0
  lastGfxCheckpointChunk = undefined
  photoDrawBlitSuccess = 0
  photoDrawBlitFail = 0
  photoDrawBackdropOnly = 0
  lastPhotoDrawFailReason = 'none'
  photoPreviewLastMeanLuma = -1
  photoPreviewLastCenterLuma = -1
  photoKnownCorruptionLogged = false
}
