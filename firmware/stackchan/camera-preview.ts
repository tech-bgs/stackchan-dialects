// @ts-nocheck
import type { CameraCaptureOptions, CameraFrame, RobotCamera } from './camera.js'
import {
  checkRgb565LeFrame,
  copyRgb565LeFrameBytes,
  getRgb565LePixelBuffer,
  getRgb565PoolCopyGeneration,
  readRgb565LeBytes,
  sampleRgb565LeCenterLuma,
  sampleRgb565LeMeanLuma,
  sampleRgb565LeMosaic,
  wrapOwnedRgb565LeFrame,
} from './camera-preview-utils.js'

import Timer from 'timer'
import Bitmap from 'commodetto/Bitmap'
import {
  Container,
  Port,
  type Container as PiuContainer,
  type Content as PiuContent,
  type Port as PiuPort,
} from 'piu/MC'
import RuntimeBitmapPort, { sampleRuntimeBitmapPortPocoFb } from 'runtime-bitmap-port'
import {
  getPhotoFlushIliStats,
  getPhotoFlushSendStats,
  resetPhotoPostFlushBaseline,
  tracePhotoFbNote,
  tracePhotoFlushNote,
  tracePhotoPostFlush,
} from './photo-display-diagnostics.js'
import {
  notePhotoBitmapConstruct,
  notePhotoBitmapReuse,
  getPhotoPortOnDrawCount,
  getPhotoLcdPaintSnapshot,
  getPhotoPreviewDisplayingStats,
  getPhotoRepaintCount,
  notePhotoDrawBlit,
  notePhotoPreviewLuma,
  notePhotoPreviewPortDisplaying,
  notePhotoPreviewShellDisplaying,
  notePhotoDrawBackdropOnly,
  notePhotoRepaint,
  setPhotoLcdPaintTraceActive,
  setPhotoPocoOnDrawFrame,
  tracePhotoFrameComposition,
  tracePhotoLcdOnDrawResult,
  tracePhotoLcdOnDrawSteps,
  notePhotoPiuShellNodes,
  notePhotoPortOnDraw,
  resetPhotoGraphicsDiagnosticsForTest,
  resetPhotoPortOnDrawCount,
  tracePhotoDrawOnDraw,
  tracePhotoDrawNote,
  tracePhotoDrawSummary,
  tracePhotoNativeNote,
  tracePhotoGfxCheckpoint,
} from './photo-graphics-diagnostics.js'
import {
  tracePhotoPhase,
  tracePhotoTimeline,
  photoPathStep,
  tracePhotoHeapCapture,
  tracePhotoLatencyMilestone,
} from './photo-session-diagnostics.js'
export { tracePhotoDrawSummary } from './photo-graphics-diagnostics.js'

/** M5Stack CoreS3 LCD — full-screen layout (e.g. photo result overlay). */
export const CAMERA_PREVIEW_SCREEN_WIDTH = 320
export const CAMERA_PREVIEW_SCREEN_HEIGHT = 240

/** Small in-face preview widget (mosaic Port). */
export const CAMERA_PREVIEW_WIDTH = 200
export const CAMERA_PREVIEW_HEIGHT = 120

export const CAMERA_PREVIEW_CAPTURE_OPTIONS: CameraCaptureOptions = {
  width: CAMERA_PREVIEW_SCREEN_WIDTH,
  height: CAMERA_PREVIEW_SCREEN_HEIGHT,
  imageType: 'rgb565le',
}

export const CAMERA_PREVIEW_OVERLAY_KEY = 'cameraPreview'
export const PHOTO_RESULT_BACKDROP_COLOR = '#000000'

export type CameraPreviewRenderMode = 'runtime-bitmap-port' | 'mosaic'
export type CameraPreviewLayout = 'native' | 'fit-screen'

export type CameraPreviewOptions = {
  layout?: CameraPreviewLayout
  onRender?: (mode: CameraPreviewRenderMode) => void
  onDismiss?: (source: string) => void
}

export type PhotoResultOverlayOptions = {
  onRender?: (mode: CameraPreviewRenderMode) => void
  onDismiss?: (source: string) => void
  traceOriginMs?: number
}

export type PhotoResultOverlayBundle = {
  overlay: PiuContent
  previewPort: PiuContent
  /** Monotonic id — one buildPhotoResultOverlay must pair with one disposePhotoResultOverlay. */
  shellId: number
  displayLeft: number
  displayTop: number
  displayWidth: number
  displayHeight: number
  refreshDisplay: (app?: { invalidate?: () => void }) => void
  /** After first blit: skip onDraw and drop port refs (LCD keeps the painted image). */
  lockPreviewAfterPaint: () => void
  /** Drop port frame/bitmap refs before disposing pixel buffers. */
  releasePreviewResources: () => void
}

export type PhotoOverlayLifecycleStats = {
  buildCount: number
  disposeCount: number
  liveCount: number
  imbalance: number
  lastShellId: number
}

let photoOverlayNextShellId = 1
let photoOverlayBuildCount = 0
let photoOverlayDisposeCount = 0
let photoOverlayLastShellId = 0

function instrumentationMap(name: string): number | undefined {
  try {
    const key = native('xs_instrumentation_map').call(undefined, name)
    return typeof key === 'number' ? key : undefined
  } catch {
    return undefined
  }
}

function instrumentationGet(key: number): number | undefined {
  try {
    const value = native('xs_instrumentation_get').call(undefined, key)
    return typeof value === 'number' ? value : undefined
  } catch {
    return undefined
  }
}

function triggerPhotoOverlayGc(label: string): boolean {
  let ran = false
  const gc = (globalThis as { gc?: () => void }).gc
  if (typeof gc === 'function') {
    try {
      gc()
      ran = true
    } catch {
      /* ignore */
    }
  }
  trace(`[Photo] gc after ${label}: ${ran ? 'ok' : 'unavailable (no globalThis.gc)'}\n`)
  return ran
}

/** @internal Diagnostic — XS slot/chunk stats around overlay create/dispose. */
export function tracePhotoOverlayHeap(phase: string, shellId?: number): void {
  const slotKey = instrumentationMap('XS Slot Heap Used')
  const chunkKey = instrumentationMap('XS Chunk Heap Used')
  const sysFreeKey = instrumentationMap('System Free Memory')
  const slot = slotKey != null ? instrumentationGet(slotKey) : undefined
  const chunk = chunkKey != null ? instrumentationGet(chunkKey) : undefined
  const sysFree = sysFreeKey != null ? instrumentationGet(sysFreeKey) : undefined
  const liveCount = photoOverlayBuildCount - photoOverlayDisposeCount
  const idPart = shellId != null ? ` shell#${shellId}` : ''
  trace(
    `[Photo] heap ${phase}${idPart}: slot=${slot ?? '?'} chunk=${chunk ?? '?'} sysFree=${sysFree ?? '?'} live=${liveCount} build=${photoOverlayBuildCount} dispose=${photoOverlayDisposeCount}\n`,
  )
}

export function getPhotoOverlayLifecycleStats(): PhotoOverlayLifecycleStats {
  const liveCount = photoOverlayBuildCount - photoOverlayDisposeCount
  return {
    buildCount: photoOverlayBuildCount,
    disposeCount: photoOverlayDisposeCount,
    liveCount,
    imbalance: photoOverlayBuildCount - photoOverlayDisposeCount,
    lastShellId: photoOverlayLastShellId,
  }
}

type OverlayMountProbe = PiuContent & {
  name?: string
  active?: boolean
  visible?: boolean
  container?: PiuContainer & { name?: string }
}

/** Log whether an overlay node still has a PIU parent (mounted on OVERLAY). */
export function describePhotoOverlayMountState(
  overlay: PiuContent | null | undefined,
  label: string,
  shellId?: number,
): void {
  if (!overlay) {
    trace(`[Photo] mount ${label}${shellId != null ? ` shell#${shellId}` : ''}: overlay=null\n`)
    return
  }
  const node = overlay as OverlayMountProbe
  const parent = node.container
  const mounted = !!parent
  const parentName = parent?.name ?? (mounted ? 'unnamed' : 'none')
  trace(
    `[Photo] mount ${label}${shellId != null ? ` shell#${shellId}` : ''}: name=${node.name ?? '?'} mounted=${mounted} parent=${parentName} active=${node.active !== false} visible=${node.visible !== false}\n`,
  )
}

/** Per-capture overlay callbacks (no shared PIU shell). */
const photoResultOverlayRuntime: {
  onRender?: (mode: CameraPreviewRenderMode) => void
  onDismiss?: (source: string) => void
  dismissHandled: boolean
} = {
  dismissHandled: false,
}

/** Letterbox position for native-resolution frame on the 320×240 LCD. */
export function centeredPhotoDisplayOffset(frameWidth: number, frameHeight: number): { left: number; top: number } {
  return {
    left: ((CAMERA_PREVIEW_SCREEN_WIDTH - frameWidth) / 2) | 0,
    top: ((CAMERA_PREVIEW_SCREEN_HEIGHT - frameHeight) / 2) | 0,
  }
}

const PREVIEW_LEFT = 60
const PREVIEW_TOP = 60
const PREVIEW_BLOCK_SIZE = 48
const PREVIEW_BACKGROUND = '#101010'

/** Grep-friendly firmware id — bump when photo overlay diagnostics change. */
export const PHOTO_FW_TRACE_TAG = 'v22-photo-phase-trace'
/** Grep boot + capture logs — confirms PhotoUiTrace / PhotoWinTrace firmware on device. */
export const PHOTO_UI_TRACE_BUILD_ID = 'photo-ui-trace-v1'
/** Post-capture face stripes / checkbox aspect: see PHOTO_POST_CAPTURE_CORRUPTION_DEFERRED in photo-graphics-diagnostics (fix preview first). */

/** After onDraw#1 blit ok: extra invalidate (LCD composite / one-shot paint). */
const PHOTO_POST_ONDRAW_INVALIDATE_MS = [50, 200, 1000]
export const PHOTO_OVERLAY_BUILD_ID = `preview-no-boost-${PHOTO_FW_TRACE_TAG}`

export function tracePhotoFw(phase: string, detail = ''): void {
  const extra = detail ? ` ${detail}` : ''
  trace(`[PhotoFw] ${PHOTO_FW_TRACE_TAG} ${phase}${extra}\n`)
}

const PHOTO_DRAW_LOG_FIRST_N = 24
const PHOTO_DRAW_LOG_EVERY_N = 32
const PHOTO_MOSAIC_BLOCK_SIZE = 16

/** One Bitmap for 320×240 pool buffer — recreate when pool generation advances. */
let sharedPhotoDisplayBitmap: InstanceType<typeof Bitmap> | null = null
let sharedPhotoDisplayBitmapGeneration = -1

export function getSharedPhotoDisplayBitmapDiag(): {
  held: boolean
  width: number
  height: number
} {
  const bitmap = sharedPhotoDisplayBitmap
  return {
    held: bitmap != null,
    width: bitmap?.width ?? 0,
    height: bitmap?.height ?? 0,
  }
}

/** Log PIU z-order: single Port child (fill+bitmap in onDraw), no sibling backdrop. */
export function tracePhotoPreviewLayerStack(
  phase: string,
  shell: PiuContainer | null | undefined,
  previewPort: PiuContent | null | undefined,
): void {
  const shellProbe = shell as (PiuContainer & { visible?: boolean; active?: boolean; first?: PiuContent }) | null
  const portProbe = previewPort as (PiuContent & { visible?: boolean; container?: PiuContainer }) | null
  const firstName = shellProbe?.first ? 'previewPort' : 'none'
  trace(
    `[PhotoLayer] ${phase}: shell vis=${shellProbe?.visible !== false} active=${shellProbe?.active !== false} children=1(${firstName}) port vis=${portProbe?.visible !== false} portParent=${portProbe?.container?.name ?? '?'}\n`,
  )
  tracePhotoFw(
    'PhotoLayer',
    `${phase} shellVis=${shellProbe?.visible !== false} portVis=${portProbe?.visible !== false}`,
  )
}

export function tracePhotoGraphicsForPhase(
  phase: string,
  livePort?: unknown,
  staleOverlay?: unknown,
  shellId?: number,
): void {
  tracePhotoGfxCheckpoint(phase, {
    livePort,
    staleOverlay,
    shellId,
    sharedBitmap: getSharedPhotoDisplayBitmapDiag(),
    overlay: getPhotoOverlayLifecycleStats(),
  })
}

type BitmapPort = PiuPort & {
  drawBitmap?: (bitmap: Bitmap, x: number, y: number, sx?: number, sy?: number, sw?: number, sh?: number) => boolean
}

function piuColor(color: number): string {
  const hex = color.toString(16).padStart(6, '0')
  return `#${hex}`
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function photoResultElapsed(traceOriginMs: number | undefined): string {
  if (traceOriginMs == null) return ''
  return ` +${Date.now() - traceOriginMs}ms`
}

function photoResultScreenLayout() {
  return {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    visible: true,
    active: true,
    clip: false,
  }
}

type PortWithBounds = PiuPort & { width?: number; height?: number; bounds?: { width: number; height: number } }

function photoResultPortDrawSize(port: PiuPort): { width: number; height: number } {
  const p = port as PortWithBounds
  let width = (p.width ?? p.bounds?.width ?? 0) | 0
  let height = (p.height ?? p.bounds?.height ?? 0) | 0
  if (width <= 0) width = CAMERA_PREVIEW_SCREEN_WIDTH
  if (height <= 0) height = CAMERA_PREVIEW_SCREEN_HEIGHT
  return { width, height }
}

type PhotoPreviewPortBehavior = Behavior & {
  frame: CameraFrame | null
  previewFrameReleased: boolean
  displayBitmap: Bitmap | null
  displayBitmapBuffer: ArrayBuffer | null
  displayWidth: number
  displayHeight: number
  traceOriginMs: number | undefined
  ensureDisplayBitmap(frame: CameraFrame): Bitmap | null
  lockPreviewAfterPaint(): void
  releaseDisplayResources(): void
}

type PhotoResultContainerBehavior = Behavior & {
  traceOriginMs: number | undefined
}

function shouldLogPhotoDrawPass(onDrawN: number, drew: boolean): boolean {
  return onDrawN <= PHOTO_DRAW_LOG_FIRST_N || !drew || onDrawN % PHOTO_DRAW_LOG_EVERY_N === 0
}

function drawCachedDisplayBitmap(
  port: BitmapPort,
  bitmap: InstanceType<typeof Bitmap>,
  atX: number,
  atY: number,
  sw: number,
  sh: number,
): boolean {
  const draw = (port as RuntimeBitmapPort).drawBitmap
  if (typeof draw !== 'function') {
    notePhotoDrawBlit(false, 'drawBitmap-missing')
    return false
  }
  tracePhotoNativeNote('PhotoNative ENTER drawCachedDisplayBitmap')
  const nativeOk = !!draw.call(port, bitmap, atX, atY, 0, 0, sw, sh)
  notePhotoDrawBlit(nativeOk, nativeOk ? undefined : 'native-blit-false-cached')
  if (!nativeOk) {
    tracePhotoDrawNote(
      `blit FAIL cached bitmap=${bitmap.width}x${bitmap.height} fmt=${bitmap.format} at=${atX},${atY} sw=${sw} sh=${sh}`,
    )
  }
  return nativeOk
}

function drawRgb565Bitmap(
  port: BitmapPort,
  frame: CameraFrame,
  atX: number,
  atY: number,
  behavior?: PhotoPreviewPortBehavior | null,
): boolean {
  const check = checkRgb565LeFrame(frame)
  if (!check.ok) {
    notePhotoDrawBlit(false, `frame-check:${check.reason ?? 'bad'}`)
    tracePhotoDrawNote(`blit FAIL frame-check: ${check.reason}`)
    return false
  }
  const draw = (port as RuntimeBitmapPort).drawBitmap
  if (typeof draw !== 'function') {
    notePhotoDrawBlit(false, 'drawBitmap-missing')
    tracePhotoDrawNote('blit FAIL drawBitmap missing')
    return false
  }

  const pixelBuffer = getRgb565LePixelBuffer(frame)
  if (!pixelBuffer) {
    notePhotoDrawBlit(false, 'no-pixel-buffer')
    tracePhotoDrawNote('blit FAIL no pixel buffer')
    return false
  }

  const sw = frame.width | 0
  const sh = frame.height | 0
  const bitmap = behavior?.ensureDisplayBitmap(frame) ?? getSharedPhotoDisplayBitmap(sw, sh, pixelBuffer)
  if (!bitmap) {
    notePhotoDrawBlit(false, 'no-bitmap-object')
    tracePhotoDrawNote('blit FAIL no Bitmap object')
    return false
  }

  tracePhotoNativeNote('PhotoNative ENTER drawRgb565Bitmap')
  const nativeOk = !!draw.call(port, bitmap, atX, atY, 0, 0, sw, sh)
  notePhotoDrawBlit(nativeOk, nativeOk ? undefined : 'native-blit-false-frame')
  if (!nativeOk) {
    tracePhotoDrawNote(
      `blit FAIL frame bitmap=${bitmap.width}x${bitmap.height} fmt=${bitmap.format} at=${atX},${atY} sw=${sw} sh=${sh} bufB=${pixelBuffer.byteLength}`,
    )
  }
  return nativeOk
}

function getSharedPhotoDisplayBitmap(sw: number, sh: number, pixelBuffer: ArrayBuffer): Bitmap {
  const bitmap = sharedPhotoDisplayBitmap
  const poolGen = getRgb565PoolCopyGeneration()
  if (bitmap && bitmap.width === sw && bitmap.height === sh && sharedPhotoDisplayBitmapGeneration === poolGen) {
    notePhotoBitmapReuse()
    return bitmap
  }
  const replaced = bitmap != null
  notePhotoBitmapConstruct(replaced)
  sharedPhotoDisplayBitmapGeneration = poolGen
  sharedPhotoDisplayBitmap = new Bitmap(sw, sh, Bitmap.RGB565LE, pixelBuffer, 0)
  trace(
    `[PhotoGfx] Commodetto Bitmap ${replaced ? 'rebound' : 'constructed'} ${sw}x${sh} poolGen=${poolGen} (buildPhotoResultOverlay uses shared singleton)\n`,
  )
  return sharedPhotoDisplayBitmap
}

function _drawMosaicPreview(
  port: PiuPort,
  frame: CameraFrame,
  atX: number,
  atY: number,
  drawW: number,
  drawH: number,
  maxBlocks = 12,
): number {
  let fills = 0
  for (const block of sampleRgb565LeMosaic(frame, {
    width: drawW,
    height: drawH,
    blockSize: PHOTO_MOSAIC_BLOCK_SIZE,
  })) {
    if (maxBlocks > 0 && fills >= maxBlocks) break
    port.fillColor(piuColor(block.color), atX + block.x, atY + block.y, block.width, block.height)
    fills++
  }
  return fills
}

/** Release port refs, stop PIU nodes, and drop the shared display Bitmap binding. */
export function disposePhotoResultOverlay(bundle: PhotoResultOverlayBundle | null | undefined, reason: string): void {
  if (!bundle) {
    trace(`[PhotoUiTrace] disposePhotoResultOverlay skip (no bundle) reason=${reason}\n`)
    trace(`[Photo] disposePhotoResultOverlay skip (${reason}): no bundle\n`)
    return
  }
  const shellId = bundle.shellId
  trace(`[PhotoUiTrace] disposePhotoResultOverlay enter shell#=${shellId} reason=${reason}\n`)
  tracePhotoFw('disposePhotoResultOverlay', `shell#=${shellId} reason=${reason}`)
  tracePhotoOverlayHeap('before dispose', shellId)
  describePhotoOverlayMountState(bundle.overlay, `before dispose (${reason})`, shellId)

  tracePhotoDrawSummary(`dispose-enter shell#${shellId}`)
  tracePhotoGraphicsForPhase(`dispose-enter`, bundle.previewPort, undefined, shellId)
  bundle.releasePreviewResources()
  const port = bundle.previewPort as RuntimeBitmapPort & { stop?: () => void }
  port?.clearRuntimeBitmapBinding?.()
  const overlay = bundle.overlay as PiuContent & { stop?: () => void; active?: boolean; visible?: boolean }
  overlay.active = false
  overlay.visible = false
  try {
    port.stop?.()
  } catch (error) {
    trace(`[Photo] overlay port stop failed (${reason}): ${errorMessage(error)}\n`)
  }
  try {
    overlay.stop?.()
  } catch (error) {
    trace(`[Photo] overlay shell stop failed (${reason}): ${errorMessage(error)}\n`)
  }
  // Keep one Bitmap for the permanent RGB565 pool — recreating it each dismiss leaks host chunks.
  photoResultOverlayRuntime.onRender = undefined
  photoResultOverlayRuntime.onDismiss = undefined
  // Do not reset dismissHandled here — stale shell may still receive a late container touch.

  photoOverlayDisposeCount += 1
  const stats = getPhotoOverlayLifecycleStats()
  describePhotoOverlayMountState(bundle.overlay, `after stop (${reason})`, shellId)
  triggerPhotoOverlayGc(`dispose shell#${shellId} (${reason})`)
  tracePhotoDrawSummary(`dispose-after-gc shell#${shellId}`)
  tracePhotoGraphicsForPhase(`dispose-after-gc`, bundle.previewPort, bundle.overlay, shellId)
  tracePhotoOverlayHeap('after dispose+gc', shellId)
  trace(
    `[Photo] overlay PIU shell disposed (${reason}) shell#${shellId} build=${stats.buildCount} dispose=${stats.disposeCount} live=${stats.liveCount}\n`,
  )
  if (stats.imbalance !== 0) {
    trace(`[Photo] WARNING overlay lifecycle imbalance: build-dispose=${stats.imbalance} (expect 0)\n`)
  }
  trace(
    `[PhotoLifecycle] post-dispose shell#=${shellId} build=${stats.buildCount} dispose=${stats.disposeCount} live=${stats.liveCount} (next PhotoFw boot = firmware restart)\n`,
  )
}

export function prepareCameraPreviewDisplayFrame(frame: CameraFrame): CameraFrame {
  photoPathStep('prepare.enter', PHOTO_OVERLAY_BUILD_ID)
  trace(
    `[PhotoFw] prepareCameraPreviewDisplayFrame ${PHOTO_OVERLAY_BUILD_ID} expect=prepare.meanLuma NOT boost.pixelLoop\n`,
  )
  photoPathStep('prepare.check.before')
  const check = checkRgb565LeFrame(frame)
  photoPathStep('prepare.check.after', check.ok ? 'ok' : check.reason)
  if (!check.ok) {
    trace(`[CameraPreview] display copy skip: ${check.reason}\n`)
    throw new RangeError(`[CameraPreview] ${check.reason}`)
  }
  const byteLength = frame.width * frame.height * 2
  photoPathStep('prepare.copy.before', `bytes=${byteLength}`)
  const copy = copyRgb565LeFrameBytes(frame.buffer, byteLength)
  photoPathStep('prepare.copy.after', `bytes=${copy.byteLength}`)
  photoPathStep('prepare.meanLuma.before')
  const meanLuma = sampleRgb565LeMeanLuma({
    width: frame.width,
    height: frame.height,
    imageType: frame.imageType,
    buffer: copy,
  })
  photoPathStep('prepare.meanLuma.after', `mean=${meanLuma}`)
  photoPathStep('prepare.centerLuma.before')
  const centerLuma = sampleRgb565LeCenterLuma({
    width: frame.width,
    height: frame.height,
    imageType: frame.imageType,
    buffer: copy,
  })
  photoPathStep('prepare.centerLuma.after', `center=${centerLuma}`)
  photoPathStep('prepare.frameClose.before')
  try {
    frame.close?.()
  } catch (error) {
    trace(`[CameraPreview] source frame close failed: ${errorMessage(error)}\n`)
  }
  photoPathStep('prepare.frameClose.after')
  trace(`[CameraPreview] display copy ${frame.width}x${frame.height} mean=${meanLuma} center=${centerLuma}\n`)
  photoPathStep('prepare.wrap.before')
  const wrapped = wrapOwnedRgb565LeFrame(frame.width, frame.height, frame.imageType, copy)
  photoPathStep('prepare.wrap.after')
  return wrapped
}

export function disposeCameraPreviewFrame(frame: CameraFrame | null | undefined) {
  try {
    frame?.close?.()
  } catch (error) {
    trace(`[CameraPreview] frame dispose failed: ${errorMessage(error)}\n`)
  }
}

export async function releasePreviewCamera(camera: RobotCamera): Promise<void> {
  try {
    await camera.teardownAfterCapture()
  } catch (error) {
    trace(`[CameraPreview] teardown failed: ${errorMessage(error)}\n`)
  }
}

/**
 * Build a fresh photo overlay PIU shell for each capture (dismiss must call disposePhotoResultOverlay).
 */
export function obtainPhotoResultOverlay(
  frame: CameraFrame,
  options: PhotoResultOverlayOptions = {},
): PhotoResultOverlayBundle {
  const traceOriginMs = options.traceOriginMs
  photoResultOverlayRuntime.onRender = options.onRender
  photoResultOverlayRuntime.onDismiss = options.onDismiss
  photoResultOverlayRuntime.dismissHandled = false

  trace(`[Photo] obtainPhotoResultOverlay enter ${frame.width}x${frame.height}${photoResultElapsed(traceOriginMs)}\n`)
  const bundle = buildPhotoResultOverlay(frame, traceOriginMs)
  trace(`[Photo] obtainPhotoResultOverlay (new PIU shell#${bundle.shellId})${photoResultElapsed(traceOriginMs)}\n`)
  return bundle
}

/** @deprecated Prefer obtainPhotoResultOverlay — kept for tests and callers. */
export function createPhotoResultOverlay(
  frame: CameraFrame,
  options: PhotoResultOverlayOptions = {},
): PhotoResultOverlayBundle {
  return obtainPhotoResultOverlay(frame, options)
}

/**
 * Full-screen photo review: native 320×240 RGB565 at (0,0).
 */
function buildPhotoResultOverlay(frame: CameraFrame, traceOriginMs: number | undefined): PhotoResultOverlayBundle {
  const shellId = photoOverlayNextShellId
  photoOverlayNextShellId += 1
  photoOverlayLastShellId = shellId
  photoOverlayBuildCount += 1
  tracePhotoFw('buildPhotoResultOverlay-enter', `shell#${shellId}`)
  tracePhotoOverlayHeap('before build', shellId)

  const requestDismissOnce = (source: string) => {
    trace(
      `[PhotoUiTrace] requestDismissOnce enter shell#=${shellId} source=${source} handled=${photoResultOverlayRuntime.dismissHandled ? 1 : 0}\n`,
    )
    if (photoResultOverlayRuntime.dismissHandled) {
      trace(`[PhotoUiTrace] requestDismissOnce skip (already handled) shell#=${shellId} source=${source}\n`)
      return
    }
    photoResultOverlayRuntime.dismissHandled = true
    trace(`[PhotoUiTrace] requestDismissOnce calling onDismiss shell#=${shellId} source=${source}\n`)
    photoResultOverlayRuntime.onDismiss?.(source)
  }

  resetPhotoPortOnDrawCount()
  const { left: displayLeft, top: displayTop } = centeredPhotoDisplayOffset(frame.width, frame.height)
  trace(
    `[Photo] buildPhotoResultOverlay ${PHOTO_OVERLAY_BUILD_ID} shell#=${shellId} ${frame.width}x${frame.height} build=${photoOverlayBuildCount}${photoResultElapsed(traceOriginMs)}\n`,
  )
  trace(
    `[PhotoWinTrace] photoResultOverlay shell#=${shellId} component=RuntimeBitmapPort blitAt=${displayLeft},${displayTop} frame=${frame.width}x${frame.height} screen=${CAMERA_PREVIEW_SCREEN_WIDTH}x${CAMERA_PREVIEW_SCREEN_HEIGHT}\n`,
  )
  trace(
    `[PhotoGfx] buildPhotoResultOverlay shell#=${shellId}: new PIU nodes (Container+Port+Content), Bitmap deferred until first onDraw, Texture=0\n`,
  )

  const previewPort = new RuntimeBitmapPort(
    { frame, traceOriginMs, displayLeft, displayTop },
    {
      ...photoResultScreenLayout(),
      width: CAMERA_PREVIEW_SCREEN_WIDTH,
      height: CAMERA_PREVIEW_SCREEN_HEIGHT,
      backgroundTouch: true,
      Behavior: class extends Behavior implements PhotoPreviewPortBehavior {
        frame: CameraFrame | null = null
        options: PhotoResultOverlayOptions | null = null
        traceOriginMs: number | undefined
        displayLeft = 0
        displayTop = 0
        displayWidth = 0
        displayHeight = 0
        loggedFirstBitmap = false
        previewFrameReleased = false
        displayBitmap: Bitmap | null = null
        displayBitmapBuffer: ArrayBuffer | null = null
        previewPort: PiuPort | null = null

        ensureDisplayBitmap(frame: CameraFrame): Bitmap | null {
          photoPathStep('ensureBitmap.before')
          const check = checkRgb565LeFrame(frame)
          if (!check.ok) {
            photoPathStep('ensureBitmap.after', 'frame-check-fail')
            return null
          }
          let pixelBuffer = getRgb565LePixelBuffer(frame)
          if (!pixelBuffer) {
            photoPathStep('ensureBitmap.readHost.before')
            const pixelBytes = readRgb565LeBytes(frame.buffer)
            photoPathStep('ensureBitmap.readHost.after', `len=${pixelBytes?.length ?? 0}`)
            if (!pixelBytes) {
              photoPathStep('ensureBitmap.after', 'no-bytes')
              return null
            }
            pixelBuffer = pixelBytes.buffer instanceof ArrayBuffer ? pixelBytes.buffer : getRgb565LePixelBuffer(frame)
            if (!pixelBuffer) {
              photoPathStep('ensureBitmap.after', 'no-buffer')
              return null
            }
          }
          const sw = frame.width | 0
          const sh = frame.height | 0
          this.displayBitmapBuffer = pixelBuffer
          this.displayBitmap = getSharedPhotoDisplayBitmap(sw, sh, pixelBuffer)
          this.displayWidth = sw
          this.displayHeight = sh
          photoPathStep('ensureBitmap.after', `poolGen=${getRgb565PoolCopyGeneration()}`)
          return this.displayBitmap
        }

        /** Drop port CameraFrame ref after first blit; keep Bitmap for PIU redraw each frame. */
        lockPreviewAfterPaint() {
          this.previewFrameReleased = true
          this.frame = null
        }

        releaseDisplayResources() {
          this.previewFrameReleased = false
          ;(this.previewPort as RuntimeBitmapPort).clearRuntimeBitmapBinding?.()
          this.frame = null
          this.displayBitmap = null
          this.displayBitmapBuffer = null
          this.displayWidth = 0
          this.displayHeight = 0
          this.loggedFirstBitmap = false
        }

        paintPreviewBitmap(port: PiuPort): boolean {
          const bitmap = this.displayBitmap
          const sw = this.displayWidth
          const sh = this.displayHeight
          if (!bitmap || sw <= 0 || sh <= 0) {
            return false
          }
          return drawCachedDisplayBitmap(port as BitmapPort, bitmap, this.displayLeft, this.displayTop, sw, sh)
        }

        onCreate(
          port: PiuPort,
          data: {
            frame: CameraFrame
            traceOriginMs?: number
            displayLeft: number
            displayTop: number
          },
        ) {
          this.previewPort = port
          this.frame = data.frame
          this.options = null
          this.traceOriginMs = data.traceOriginMs
          this.displayLeft = data.displayLeft
          this.displayTop = data.displayTop
        }

        onDisplaying(port: PiuPort) {
          notePhotoPreviewPortDisplaying()
          const size = photoResultPortDrawSize(port)
          const visible = (port as PiuContent & { visible?: boolean }).visible !== false
          const mounted = !!(port as PiuContent & { container?: unknown }).container
          tracePhotoPhase(
            'previewPort-onDisplaying',
            `${size.width}x${size.height} visible=${visible ? 1 : 0} mounted=${mounted ? 1 : 0} onDrawSoFar=${getPhotoPortOnDrawCount()}`,
          )
          trace(
            `[PhotoDisplay] previewPort onDisplaying ${size.width}x${size.height} visible=${visible} mounted=${mounted} onDrawSoFar=${getPhotoPortOnDrawCount()}${photoResultElapsed(this.traceOriginMs)}\n`,
          )
          port.invalidate()
          trace('[PhotoDisplay] previewPort onDisplaying → port.invalidate()\n')
        }

        onTouchBegan(port: PiuPort, id: number, x: number, y: number, ticks: number) {
          const probe = port as PiuPort & { active?: boolean; visible?: boolean; container?: unknown }
          trace(
            `[PhotoUiTrace] previewPort.onTouchBegan shell#=${shellId} id=${id} x=${x} y=${y} ticks=${ticks} active=${probe.active !== false ? 1 : 0} vis=${probe.visible !== false ? 1 : 0} mounted=${probe.container ? 1 : 0} handled=${photoResultOverlayRuntime.dismissHandled ? 1 : 0}\n`,
          )
          return true
        }

        onTouchEnded(port: PiuPort, id: number, x: number, y: number, ticks: number) {
          trace(
            `[PhotoUiTrace] previewPort.onTouchEnded enter shell#=${shellId} id=${id} x=${x} y=${y} ticks=${ticks} handled=${photoResultOverlayRuntime.dismissHandled ? 1 : 0}\n`,
          )
          if (photoResultOverlayRuntime.dismissHandled) {
            trace(`[PhotoUiTrace] previewPort.onTouchEnded skip (dismiss handled) shell#=${shellId}\n`)
            return true
          }
          trace(
            `[PhotoDismiss] path=A previewPort.onTouchEnded id=${id} x=${x} y=${y} ticks=${ticks}${photoResultElapsed(this.traceOriginMs)}\n`,
          )
          requestDismissOnce(`previewPort.onTouchEnded@${x},${y}`)
          return true
        }

        onDraw(port: PiuPort) {
          notePhotoPortOnDraw()
          const onDrawN = getPhotoPortOnDrawCount()
          setPhotoPocoOnDrawFrame(onDrawN)
          if (onDrawN <= 3) {
            tracePhotoFrameComposition(
              onDrawN,
              'start',
              `frameHeld=${this.frame ? 1 : 0} cached=${this.displayBitmap ? 1 : 0} released=${this.previewFrameReleased ? 1 : 0}`,
            )
          }
          if (onDrawN === 1) {
            tracePhotoTimeline('onDraw#1')
            tracePhotoDrawNote(`port onDraw first call (${PHOTO_OVERLAY_BUILD_ID})`)
          }
          const portSize = photoResultPortDrawSize(port)
          if (onDrawN <= 3) {
            tracePhotoFrameComposition(
              onDrawN,
              'fill-queued',
              `fillColor black rect=0,0,${portSize.width}x${portSize.height} (runs after DrawContent in same UpdateStep)`,
            )
          }
          tracePhotoLcdOnDrawSteps(
            onDrawN,
            'backdrop-fill',
            `color=#000000 rect=0,0,${portSize.width}x${portSize.height}`,
          )
          port.fillColor(PHOTO_RESULT_BACKDROP_COLOR, 0, 0, portSize.width, portSize.height)
          const frame = this.frame
          const pixelBuffer = frame ? getRgb565LePixelBuffer(frame) : null
          const path = frame && pixelBuffer != null ? 'frame' : 'cached'
          let drew = false
          let failReason = ''
          const blitSw = this.displayWidth || frame?.width || 0
          const blitSh = this.displayHeight || frame?.height || 0
          if (onDrawN <= 3) {
            tracePhotoFrameComposition(
              onDrawN,
              'bitmap-attempt',
              `path=${path} at=${this.displayLeft},${this.displayTop} sw=${blitSw} sh=${blitSh}`,
            )
          }
          tracePhotoLcdOnDrawSteps(
            onDrawN,
            'blit',
            `attempt path=${path} at=${this.displayLeft},${this.displayTop} sw=${blitSw} sh=${blitSh}`,
          )
          if (frame && pixelBuffer != null) {
            tracePhotoNativeNote(`PhotoNative ENTER onDraw#${onDrawN} path=frame blit`)
            drew = drawRgb565Bitmap(port as BitmapPort, frame, this.displayLeft, this.displayTop, this)
            if (!drew) {
              failReason = 'frame-blit-failed'
            }
          } else {
            if (!this.displayBitmap) {
              failReason = frame ? 'frame-no-pixel-buffer' : 'no-frame-no-cached-bitmap'
            }
            tracePhotoNativeNote(`PhotoNative ENTER onDraw#${onDrawN} path=cached blit`)
            drew = this.paintPreviewBitmap(port)
            if (!drew && !failReason) {
              failReason = 'cached-blit-failed'
            }
          }
          const bitmap = this.displayBitmap
          if (shouldLogPhotoDrawPass(onDrawN, drew)) {
            tracePhotoDrawOnDraw({
              n: onDrawN,
              path,
              drew,
              reason: drew ? 'ok' : failReason,
              frameWxH: frame ? `${frame.width}x${frame.height}` : 'none',
              bitmapWxH: bitmap ? `${bitmap.width}x${bitmap.height}` : 'none',
              bitmapFormat: bitmap?.format ?? '',
              atX: this.displayLeft,
              atY: this.displayTop,
              sw: this.displayWidth || frame?.width || 0,
              sh: this.displayHeight || frame?.height || 0,
              portWxH: `${portSize.width}x${portSize.height}`,
              bufferBytes: pixelBuffer?.byteLength ?? 0,
              hasCachedBitmap: bitmap ? 1 : 0,
            })
          }
          tracePhotoLcdOnDrawResult(
            onDrawN,
            drew,
            path,
            this.displayLeft,
            this.displayTop,
            this.displayWidth || frame?.width || 0,
            this.displayHeight || frame?.height || 0,
          )
          if (onDrawN <= 3) {
            tracePhotoFrameComposition(
              onDrawN,
              'bitmap-result',
              `drew=${drew ? 1 : 0} reason=${drew ? 'ok' : failReason || 'unknown'} expectedListOrder=fill-then-bitmap-if-drew`,
            )
            tracePhotoPhase(
              `onDraw#${onDrawN}`,
              `path=${path} drew=${drew ? 1 : 0} reason=${drew ? 'ok' : failReason || 'unknown'} port=${portSize.width}x${portSize.height} backdropOnly=${drew ? 0 : 1}`,
            )
          }
          if (!drew) {
            notePhotoDrawBackdropOnly()
            if (onDrawN <= 3) {
              tracePhotoFrameComposition(
                onDrawN,
                'end-backdrop-only',
                `reason=${failReason || 'unknown'} displayList likely fill-only at flush`,
              )
            }
            if (onDrawN <= PHOTO_DRAW_LOG_FIRST_N || onDrawN % PHOTO_DRAW_LOG_EVERY_N === 0) {
              tracePhotoDrawNote(
                `backdrop-only onDraw#${onDrawN} (black Content visible, bitmap did not paint) reason=${failReason || 'unknown'}`,
              )
            }
            setPhotoPocoOnDrawFrame(0)
            return
          }
          if (!this.loggedFirstBitmap) {
            this.loggedFirstBitmap = true
            const meanLuma = frame ? sampleRgb565LeMeanLuma(frame) : -1
            const luma = frame ? sampleRgb565LeCenterLuma(frame) : -1
            const size = `${this.displayWidth}x${this.displayHeight}`
            trace(
              `[Photo] overlay preview bitmap ${size} meanLuma=${meanLuma} center=${luma} released=${this.previewFrameReleased ? 1 : 0} (${PHOTO_OVERLAY_BUILD_ID})${photoResultElapsed(this.traceOriginMs)}\n`,
            )
            notePhotoPreviewLuma(meanLuma, luma)
            tracePhotoHeapCapture(
              'onDraw#1-first-blit',
              `meanLuma=${meanLuma} poolGen=${getRgb565PoolCopyGeneration()}`,
            )
            tracePhotoLatencyMilestone('lcd-onDraw#1-first-blit', `meanLuma=${meanLuma} center=${luma}`)
            if (onDrawN === 1) {
              tracePhotoFbNote(
                `onDraw#1 camera meanLuma=${meanLuma} center=${luma} ([PhotoFb] is displayList-era scratch; SPI luma = ili.blitRow)`,
              )
              tracePhotoLcdOnDrawSteps(
                onDrawN,
                'blit',
                `ok meanLuma=${meanLuma} center=${luma} (LCD black but blitOk=1 → check poco FB vs screen.send)`,
              )
              probePocoFbAfterPaint(
                'onDraw#1 sync',
                port,
                this.displayLeft,
                this.displayTop,
                this.displayWidth || frame?.width || 0,
                this.displayHeight || frame?.height || 0,
              )
              const blitRect = {
                x: this.displayLeft,
                y: this.displayTop,
                w: this.displayWidth || frame?.width || 0,
                h: this.displayHeight || frame?.height || 0,
              }
              const lcdSnap = getPhotoLcdPaintSnapshot()
              tracePhotoPostFlush('onDraw#1-after-blit', blitRect, {
                pocoMeanLuma: sampleRuntimeBitmapPortPocoFb(port, blitRect.x, blitRect.y, blitRect.w, blitRect.h),
                onDraw: onDrawN,
                repaints: getPhotoRepaintCount(),
                afterOnDraw1: lcdSnap.repaintsAfterOnDraw1,
              })
              tracePhotoLatencyMilestone('lcd-onDraw#1-postFlush', `ili.send=${getPhotoFlushIliStats().send}`)
              for (const delayMs of PHOTO_POST_ONDRAW_INVALIDATE_MS) {
                Timer.set(() => {
                  const n = getPhotoPortOnDrawCount()
                  tracePhotoLcdOnDrawSteps(n, 'blit', `post-invalidate +${delayMs}ms onDrawCount=${n}`)
                  tracePhotoFlushNote(`post-invalidate +${delayMs}ms`)
                  invalidatePreviewPaintChain(`post-onDraw#1+${delayMs}ms`)
                  const pocoMean = sampleRuntimeBitmapPortPocoFb(port, blitRect.x, blitRect.y, blitRect.w, blitRect.h)
                  probePocoFbAfterPaint(
                    `post-invalidate +${delayMs}ms`,
                    port,
                    blitRect.x,
                    blitRect.y,
                    blitRect.w,
                    blitRect.h,
                  )
                  tracePhotoPostFlush(`post-invalidate+${delayMs}ms`, blitRect, {
                    pocoMeanLuma: pocoMean,
                    onDraw: getPhotoPortOnDrawCount(),
                    repaints: getPhotoRepaintCount(),
                    afterOnDraw1: getPhotoLcdPaintSnapshot().repaintsAfterOnDraw1,
                  })
                }, delayMs)
              }
            }
            photoResultOverlayRuntime.onRender?.('runtime-bitmap-port')
            if (frame) {
              this.lockPreviewAfterPaint()
            }
          } else if (!this.previewFrameReleased && frame) {
            this.lockPreviewAfterPaint()
          }
          if (onDrawN <= 3) {
            tracePhotoFrameComposition(
              onDrawN,
              'end',
              `drew=${drew ? 1 : 0} cached=${this.displayBitmap ? 1 : 0} released=${this.previewFrameReleased ? 1 : 0} (grep PhotoFrame flush + DL-STATE for displayList)`,
            )
          }
          tracePhotoDrawNote(
            `onDraw#${onDrawN} end cached=${this.displayBitmap ? 1 : 0} released=${this.previewFrameReleased ? 1 : 0} fw=${PHOTO_FW_TRACE_TAG}`,
          )
          setPhotoPocoOnDrawFrame(0)
        }
      },
    },
  )

  const overlay = new Container(
    { traceOriginMs },
    {
      ...photoResultScreenLayout(),
      backgroundTouch: true,
      name: 'photoCaptureResult',
      Behavior: class extends Behavior implements PhotoResultContainerBehavior {
        traceOriginMs: number | undefined

        onCreate(_container: PiuContainer, data: { traceOriginMs?: number }) {
          this.traceOriginMs = data.traceOriginMs
        }

        onDisplaying(container: PiuContainer) {
          notePhotoPreviewShellDisplaying()
          const c = container as PiuContainer & {
            width?: number
            height?: number
            bounds?: { width: number; height: number }
          }
          const w = (c.width ?? c.bounds?.width ?? 0) | 0
          const h = (c.height ?? c.bounds?.height ?? 0) | 0
          const port = (c as PiuContainer & { first?: PiuPort }).first
          trace(
            `[PhotoDisplay] overlay shell onDisplaying ${w}x${h} portChild=${port ? 1 : 0} onDrawSoFar=${getPhotoPortOnDrawCount()}${photoResultElapsed(this.traceOriginMs)}\n`,
          )
          trace(
            `[PhotoDraw] overlay shell onDisplaying ${w}x${h} (single RuntimeBitmapPort: fill+bitmap in onDraw)${photoResultElapsed(this.traceOriginMs)}\n`,
          )
          port?.invalidate?.()
          trace('[PhotoDisplay] overlay shell onDisplaying → previewPort.invalidate()\n')
        }

        onTouchBegan(container: PiuContainer, id: number, x: number, y: number, ticks: number) {
          const probe = container as PiuContainer & { active?: boolean; visible?: boolean; container?: unknown }
          trace(
            `[PhotoUiTrace] overlayShell.onTouchBegan shell#=${shellId} id=${id} x=${x} y=${y} ticks=${ticks} active=${probe.active !== false ? 1 : 0} vis=${probe.visible !== false ? 1 : 0} mounted=${probe.container ? 1 : 0} handled=${photoResultOverlayRuntime.dismissHandled ? 1 : 0}\n`,
          )
          return true
        }

        onTouchEnded(_container: PiuContainer, id: number, x: number, y: number, ticks: number) {
          trace(
            `[PhotoUiTrace] overlayShell.onTouchEnded enter shell#=${shellId} id=${id} x=${x} y=${y} ticks=${ticks} handled=${photoResultOverlayRuntime.dismissHandled ? 1 : 0}\n`,
          )
          if (photoResultOverlayRuntime.dismissHandled) {
            trace(`[PhotoUiTrace] overlayShell.onTouchEnded skip (dismiss handled) shell#=${shellId}\n`)
            return true
          }
          trace(
            `[PhotoDismiss] path=B overlayShell.onTouchEnded id=${id} x=${x} y=${y} ticks=${ticks}${photoResultElapsed(this.traceOriginMs)}\n`,
          )
          requestDismissOnce(`overlayShell.onTouchEnded@${x},${y}`)
          return true
        }
      },
      contents: [previewPort],
    },
  )

  notePhotoPiuShellNodes(2)
  trace(`[Photo] buildPhotoResultOverlay built${photoResultElapsed(traceOriginMs)}\n`)
  tracePhotoDrawNote(
    `build shell#${shellId} layout frame=${frame.width}x${frame.height} at=${displayLeft},${displayTop} port=${CAMERA_PREVIEW_SCREEN_WIDTH}x${CAMERA_PREVIEW_SCREEN_HEIGHT}`,
  )
  tracePhotoGraphicsForPhase('capture-build-done', previewPort, undefined, shellId)

  const probePocoFbAfterPaint = (label: string, port: PiuPort, atX: number, atY: number, sw: number, sh: number) => {
    const pocoMean = sampleRuntimeBitmapPortPocoFb(port, atX, atY, sw, sh)
    const flush = getPhotoFlushSendStats()
    tracePhotoFbNote(`${label} pocoMeanLuma=${pocoMean} screen.send.calls=${flush.calls} bytes=${flush.bytes}`)
  }

  const invalidatePreviewPaintChain = (source: string) => {
    tracePhotoFrameComposition(
      getPhotoPortOnDrawCount(),
      'invalidate',
      `source=${source} (may trigger onDraw#2+#3 fill-only black repaint)`,
    )
    notePhotoRepaint(source)
    overlay.invalidate?.()
    previewPort.invalidate?.()
    let ancestor = overlay as PiuContent & { container?: PiuContent }
    while (ancestor.container) {
      ancestor = ancestor.container as PiuContent & { container?: PiuContent }
      ancestor.invalidate?.()
    }
  }

  const refreshDisplay = (app?: { invalidate?: () => void }) => {
    const shell = overlay as PiuContent & { visible?: boolean; active?: boolean }
    shell.visible = true
    shell.active = true
    const portProbe = previewPort as PiuContent & { container?: unknown; visible?: boolean; active?: boolean }
    const disp = getPhotoPreviewDisplayingStats()
    trace(
      `[PhotoDisplay] refreshDisplay shell#${shellId} portMounted=${!!portProbe.container} portVis=${portProbe.visible !== false} shellDisp=${disp.shellDisplaying} portDisp=${disp.portDisplaying} onDraw=${disp.onDraw}\n`,
    )
    tracePhotoFlushNote(`refreshDisplay shell#${shellId} onDraw=${disp.onDraw}`)
    invalidatePreviewPaintChain('refreshDisplay.shell+port+ancestors')
    app?.invalidate?.()
  }

  const lockPreviewAfterPaint = () => {
    const port = previewPort as PiuPort & { behavior?: PhotoPreviewPortBehavior }
    port.behavior?.lockPreviewAfterPaint()
  }

  const releasePreviewResources = () => {
    const port = previewPort as PiuPort & { behavior?: PhotoPreviewPortBehavior }
    port.behavior?.releaseDisplayResources()
  }

  trace(`[Photo] buildPhotoResultOverlay returned shell#${shellId}${photoResultElapsed(traceOriginMs)}\n`)
  tracePhotoFw('buildPhotoResultOverlay-return', `shell#${shellId} (no dispose until dismiss)`)
  tracePhotoOverlayHeap('after build', shellId)

  return {
    overlay,
    previewPort,
    shellId,
    displayLeft,
    displayTop,
    displayWidth: frame.width | 0,
    displayHeight: frame.height | 0,
    refreshDisplay,
    lockPreviewAfterPaint,
    releasePreviewResources,
  }
}

/** @internal Test hook — clear overlay runtime callbacks. */
export function resetPhotoResultOverlayRuntimeForTest(): void {
  photoResultOverlayRuntime.onRender = undefined
  photoResultOverlayRuntime.onDismiss = undefined
  photoResultOverlayRuntime.dismissHandled = false
  sharedPhotoDisplayBitmap = null
  sharedPhotoDisplayBitmapGeneration = -1
  photoOverlayNextShellId = 1
  photoOverlayBuildCount = 0
  photoOverlayDisposeCount = 0
  photoOverlayLastShellId = 0
  resetPhotoGraphicsDiagnosticsForTest()
}

export function createCameraPreviewFace(frame: CameraFrame, options: CameraPreviewOptions = {}): PiuContainer {
  const previewPort = new Port(
    { frame, options },
    {
      left: 0,
      top: 0,
      width: CAMERA_PREVIEW_WIDTH,
      height: CAMERA_PREVIEW_HEIGHT,
      active: true,
      Behavior: class extends Behavior {
        frame: CameraFrame | null = null
        options: CameraPreviewOptions | null = null
        didReportRenderMode = false

        onCreate(_port: PiuPort, data: { frame: CameraFrame; options: CameraPreviewOptions }) {
          this.frame = data.frame
          this.options = data.options
        }

        onDisplaying(port: PiuPort) {
          port.invalidate()
        }

        onTouchEnded(_port: PiuPort, _id: number, x: number, y: number, ticks: number) {
          this.options?.onDismiss?.(`livePreviewPort.onTouchEnded@${x},${y},${ticks}`)
        }

        onDraw(port: PiuPort) {
          port.fillColor(PREVIEW_BACKGROUND, 0, 0, CAMERA_PREVIEW_WIDTH, CAMERA_PREVIEW_HEIGHT)
          const frame = this.frame
          if (!frame) return

          for (const block of sampleRgb565LeMosaic(frame, {
            width: CAMERA_PREVIEW_WIDTH,
            height: CAMERA_PREVIEW_HEIGHT,
            blockSize: PREVIEW_BLOCK_SIZE,
          })) {
            port.fillColor(piuColor(block.color), block.x, block.y, block.width, block.height)
          }
          this.reportRenderMode()
        }

        reportRenderMode() {
          if (this.didReportRenderMode) return
          this.didReportRenderMode = true
          this.options?.onRender?.('mosaic')
        }
      },
    },
  )

  return new Container(null, {
    left: PREVIEW_LEFT,
    top: PREVIEW_TOP,
    width: CAMERA_PREVIEW_WIDTH,
    height: CAMERA_PREVIEW_HEIGHT,
    contents: [previewPort],
  })
}
