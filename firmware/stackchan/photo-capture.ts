// @ts-nocheck
import type { CameraCaptureOptions, CameraFrame, RobotCamera } from './camera.js'
import { isCameraAvailable } from './camera.js'
import { isPhotoSdMountUnavailable, savePhoto } from './photo-save'
import {
  describePhotoOverlayMountState,
  disposeCameraPreviewFrame,
  disposePhotoResultOverlay,
  getPhotoOverlayLifecycleStats,
  PHOTO_FW_TRACE_TAG,
  PHOTO_OVERLAY_BUILD_ID,
  PHOTO_UI_TRACE_BUILD_ID,
  obtainPhotoResultOverlay,
  tracePhotoFw,
  prepareCameraPreviewDisplayFrame,
  tracePhotoDrawSummary,
  tracePhotoGraphicsForPhase,
  tracePhotoPreviewLayerStack,
  tracePhotoOverlayHeap,
  type PhotoResultOverlayBundle,
} from './camera-preview.js'
import { getCameraHostFrameStats } from './camera.js'
import { getSharedPhotoDisplayBitmapDiag } from './camera-preview.js'
import {
  isRgb565PreviewCopyPoolHeld,
  getRgb565PoolCopyGeneration,
  RGB565_PREVIEW_COPY_POOL_BYTES,
} from './camera-preview-utils.js'
import {
  getPhotoLcdPaintSnapshot,
  getPhotoPortOnDrawCount,
  getPhotoPreviewDisplayingStats,
  getPhotoPreviewLuma,
  setPhotoLcdPaintTraceActive,
  tracePhotoKnownCorruptionSymptomsOnce,
  tracePhotoLcdMountTick,
} from './photo-graphics-diagnostics.js'
import {
  armPhotoFlushIliTrace,
  getPhotoFlushIliStats,
  getPhotoFlushSendStats,
  installPhotoFlushSendTrace,
  resetPhotoFlushSendStats,
  resetPhotoPostFlushBaseline,
  tracePhotoFlushNote,
  tracePhotoPostFlush,
  uninstallPhotoFlushSendTrace,
} from './photo-display-diagnostics.js'
import { setPhotoLcdOverwriteTrace } from './photo-lcd-overwrite.js'
import {
  tracePhotoPhase,
  tracePhotoSessionDiag,
  tracePhotoTimeline,
  tracePhotoTakeStep,
  tracePhotoTouchTimeline,
  setPhotoTakeTraceFwTag,
  photoPathReset,
  photoPathStep,
  photoPathClear,
  photoPathAwaitBegin,
  photoPathAwaitEnd,
  photoPathEmitSummary,
  photoPathSeqCount,
  notePhotoCaptureCompleteMilestone,
  notePhotoShowCapturedMilestone,
  resetPhotoHeapCaptureBaseline,
  tracePhotoHeapCapture,
  tracePhotoLatencyMilestone,
  tracePhotoCycle,
  type PhotoCycleSnapshot,
} from './photo-session-diagnostics.js'

export { tracePhotoTouchTimeline } from './photo-session-diagnostics.js'
export { PHOTO_FW_TRACE_TAG, PHOTO_UI_TRACE_BUILD_ID } from './camera-preview.js'
import {
  getRgb565BufferByteLength,
  releaseRgb565PreviewCopyPool,
  sampleRgb565LeMeanLuma,
} from './camera-preview-utils.js'
import { Container, Label, Skin, Style, type Content as PiuContent } from 'piu/MC'
import Timer from 'timer'

/** Full LCD capture — preview blits 320×240 at (0,0), face fills the screen. */
export const PHOTO_CAPTURE_OPTIONS: CameraCaptureOptions = {
  width: 320,
  height: 240,
  imageType: 'rgb565le',
}

export const PHOTO_RESULT_OVERLAY_KEY = 'photoCaptureResult'
/** Black full-screen shell shown immediately after shutter — hides face during capture. */
export const PHOTO_CAPTURE_BACKDROP_KEY = 'photoCaptureBackdrop'
export const PHOTO_RESTART_OVERLAY_KEY = 'photoRestartNotice'
const PHOTO_CAPTURE_BUILD_ID = 'photo-planb-reuse-device'
/** Soft-reset after this many successful captures (heap recovery on CoreS3). */
const PHOTO_CAPTURES_BEFORE_SOFT_RESTART = 20
const PHOTO_SOFT_RESTART_DELAY_MS = 1000
const PHOTO_RESTART_MESSAGE = 'Restarting...'

export type CapturePhotoOptions = CameraCaptureOptions & {
  playShutter?: boolean
  showPreview?: boolean
  save?: boolean
}

export type CapturePhotoResult = {
  ok: boolean
  width?: number
  height?: number
  savedPath?: string
  frame?: CameraFrame
}

export type CapturePhotoRenderer = {
  addDecorator?: (decorator: PiuContent, key?: string) => void
  removeDecorator?: (decorator: PiuContent) => void
  showScreenOverlay?: (overlay: PiuContent, key: string) => void
  removeScreenOverlay?: (key: string) => void
  restoreScreenInput?: () => void
  /** Hide face layer only after preview pixels are painted (avoids black screen during capture). */
  obscureMainForPhotoPreview?: (obscure: boolean) => void
  tracePhotoUiLayers?: (phase: string, key?: string) => void
  tracePhotoOverlayMilestone?: (phase: string, key?: string) => void
  tracePhotoInputState?: (
    phase: string,
    hit?: { target: string; id: number; x: number; y: number },
    key?: string,
  ) => void
  tracePhotoOverlayHitState?: (phase: string, key?: string) => void
  tracePhotoOverlayRuntimeSnapshot?: (phase: string, key?: string) => void
  application?: { invalidate?: () => void; distribute?: (event: string) => void } | null
}

export type CapturePhotoRobot = {
  camera: RobotCamera
  tone: (hz: number, duration: number, volume?: number) => Promise<unknown>
  shutterClick?: (volume?: number) => Promise<unknown>
  renderer?: CapturePhotoRenderer | null
}

let captureInFlight = false
let photoResultOverlay: PiuContent | null = null
let photoResultOverlayBundle: PhotoResultOverlayBundle | null = null
/** Single owned full-screen buffer for preview + optional SD save. */
let previewFrame: CameraFrame | null = null
let photoResultUsesScreenOverlay = false
let photoOverlayRobot: CapturePhotoRobot | null = null
let photoPreviewPixelsFrozen = false
/** touch dismiss ran — blocks duplicate dismiss */
let photoResultDismissed = false
let pendingPhotoSave: {
  snapshot: CameraFrame
  onSaved: (savedPath: string | null) => void
} | null = null
let directCaptureRobot: CapturePhotoRobot | null = null
let photoUiPause: (() => void) | null = null
let photoUiResume: (() => void) | null = null
/** showCapturedPhoto success → dismiss dispose: block capturePhoto.finally photoUiResume. */
let photoUiResumeBlockedForOverlay = false
let cameraTeardownChain: Promise<void> = Promise.resolve()
let successfulPhotoCaptureCount = 0
let photoRestartScheduled = false
let previewHeapWatchTimers: ReturnType<typeof Timer.set>[] = []
let previewHeapWatchScheduled = false
let photoOverlayMountWatchTimer: ReturnType<typeof Timer.repeat> | undefined
let photoOverlayMountWatchTicks = 0
let photoCaptureBackdrop: PiuContent | null = null
let photoPreviewShowAtMs = 0
const PHOTO_OVERLAY_MOUNT_WATCH_MAX_TICKS = 30
/** Defer native camera teardown so PIU can paint preview before stream stop/drain. */
const PHOTO_TEARDOWN_DEFER_MS = 400
/** Timers after showCapturedPhoto — detect ili overwrites / black SPI / window mismatch. */
const PHOTO_POST_FLUSH_WATCH_MS = [0, 50, 150, 300, 600, 1000]

function previewFrameByteLength(frame: CameraFrame | null | undefined): number {
  if (!frame) {
    return 0
  }
  return getRgb565BufferByteLength(frame.buffer)
}

function overlayPreviewPortFrameHeld(): boolean {
  const bundle = photoResultOverlayBundle
  if (!bundle) {
    return false
  }
  const port = bundle.previewPort as {
    behavior?: {
      frame?: CameraFrame | null
      previewFrameReleased?: boolean
      displayBitmapBuffer?: ArrayBuffer | null
    }
  }
  const behavior = port.behavior
  return !!(behavior?.frame || behavior?.displayBitmapBuffer)
}

function overlayPreviewPortDrawLocked(): boolean {
  const bundle = photoResultOverlayBundle
  if (!bundle) {
    return false
  }
  const port = bundle.previewPort as { behavior?: { previewFrameReleased?: boolean } }
  return !!port.behavior?.previewFrameReleased
}

function snapshotPhotoCycleState(captureCount = successfulPhotoCaptureCount): PhotoCycleSnapshot {
  const cam = getCameraHostFrameStats()
  return {
    captureCount,
    readableDetached: cam.readableDetached,
    hostLive: cam.live,
    portLocked: overlayPreviewPortDrawLocked(),
    portFrame: overlayPreviewPortFrameHeld(),
    previewFrame: previewFrame ? previewFrameByteLength(previewFrame) : 0,
    pendingSave: pendingPhotoSave ? previewFrameByteLength(pendingPhotoSave.snapshot) : 0,
  }
}

function logPhotoCycle(phase: string, extra = '', captureCount?: number): void {
  tracePhotoCycle(phase, snapshotPhotoCycleState(captureCount ?? successfulPhotoCaptureCount), extra)
}

function tracePhotoUiLayers(renderer: CapturePhotoRenderer | null | undefined, phase: string, key?: string): void {
  renderer?.tracePhotoUiLayers?.(phase, key)
}

/** Safe wrapper for mods — on-robot-created must not call private tracePhotoUiLayers (ReferenceError). */
export function traceTakePhotoUiLayers(renderer: CapturePhotoRenderer | null | undefined, phase: string): void {
  trace(`[PhotoPath] traceUiLayers phase=${phase}\n`)
  try {
    tracePhotoUiLayers(renderer, phase, PHOTO_RESULT_OVERLAY_KEY)
  } catch (error) {
    trace(`[PhotoPath] traceUiLayers ERROR phase=${phase} ${errorMessage(error)}\n`)
  }
}

/** Drawer takePhoto: close via AppController.closeDrawer (avoid distribute hang/skip). */
export function closeDrawerForTakePhoto(robot: CapturePhotoRobot): void {
  trace('[PhotoPath] closeDrawer step=1 enter\n')
  const app = robot.renderer?.application as
    | {
        distribute?: (event: string) => void
        behavior?: { closeDrawer?: () => void; onDrawerClose?: () => void }
      }
    | undefined
  const behavior = app?.behavior
  if (typeof behavior?.closeDrawer === 'function') {
    trace('[PhotoPath] closeDrawer step=2 behavior.closeDrawer()\n')
    behavior.closeDrawer()
    trace('[PhotoPath] closeDrawer step=3 behavior.closeDrawer return\n')
    return
  }
  if (typeof behavior?.onDrawerClose === 'function') {
    trace('[PhotoPath] closeDrawer step=2 behavior.onDrawerClose()\n')
    behavior.onDrawerClose()
    trace('[PhotoPath] closeDrawer step=3 behavior.onDrawerClose return\n')
    return
  }
  trace('[PhotoPath] closeDrawer step=2 fallback distribute(onDrawerClose)\n')
  app?.distribute?.('onDrawerClose')
  trace('[PhotoPath] closeDrawer step=3 distribute return\n')
}

function tracePhotoGfxCheckpointAtDismiss(
  phase: string,
  bundle: PhotoResultOverlayBundle | null | undefined,
  staleOverlay?: PiuContent | null,
): void {
  tracePhotoGraphicsForPhase(phase, bundle?.previewPort, staleOverlay ?? undefined, bundle?.shellId)
}

/** RGB565 / host-frame retention snapshot for leak diagnosis. */
export function tracePhotoBufferInventory(phase: string): void {
  const cam = getCameraHostFrameStats()
  const bitmap = getSharedPhotoDisplayBitmapDiag()
  const poolHeld = isRgb565PreviewCopyPoolHeld()
  const livePort = photoResultOverlayBundle?.previewPort
  trace(
    `[PhotoBuf] ${phase}: hostLive=${cam.live} hostCreated=${cam.created} hostClosed=${cam.closed} hostDrainedDetached=${cam.drainedWhileDetached} lastDrain=${cam.lastStaleDrainCount} readableDetached=${cam.readableDetached ? 1 : 0} previewFrame=${previewFrame ? previewFrameByteLength(previewFrame) : 0} pendingSave=${pendingPhotoSave ? previewFrameByteLength(pendingPhotoSave.snapshot) : 0} pool153600=${poolHeld ? RGB565_PREVIEW_COPY_POOL_BYTES : 0} poolGen=${getRgb565PoolCopyGeneration()} sharedBitmap=${bitmap.held ? `${bitmap.width}x${bitmap.height}` : 'none'} portFrame=${overlayPreviewPortFrameHeld() ? 1 : 0} portLocked=${overlayPreviewPortDrawLocked() ? 1 : 0} capture#=${successfulPhotoCaptureCount}\n`,
  )
}

function formatPhotoPreviewPhaseState(extra = ''): string {
  const onDraw = getPhotoPortOnDrawCount()
  const disp = getPhotoPreviewDisplayingStats()
  const lcd = getPhotoLcdPaintSnapshot()
  const luma = getPhotoPreviewLuma()
  const parts = [
    `overlay=${photoResultOverlay ? 1 : 0}`,
    `dismissed=${photoResultDismissed ? 1 : 0}`,
    `frozen=${photoPreviewPixelsFrozen ? 1 : 0}`,
    `onDraw=${onDraw}`,
    `shellDisp=${disp.shellDisplaying ? 1 : 0}`,
    `portDisp=${disp.portDisplaying ? 1 : 0}`,
    `blitOk=${lcd.blitOk}`,
    `backdropOnly=${lcd.backdropOnly}`,
    `meanLuma=${luma.meanLuma}`,
  ]
  if (extra) parts.push(extra)
  return parts.join(' ')
}

function tracePhotoPreviewPhase(phase: string, extra = ''): void {
  tracePhotoPhase(phase, formatPhotoPreviewPhaseState(extra))
}

function schedulePhotoPostFlushWatch(bundle: PhotoResultOverlayBundle, shellId: number): void {
  const blit = {
    x: bundle.displayLeft,
    y: bundle.displayTop,
    w: bundle.displayWidth,
    h: bundle.displayHeight,
  }
  for (const delayMs of PHOTO_POST_FLUSH_WATCH_MS) {
    Timer.set(() => {
      if (photoResultDismissed || !photoResultOverlay) {
        return
      }
      const lcd = getPhotoLcdPaintSnapshot()
      tracePhotoPostFlush(`showCapturedPhoto+${delayMs}ms shell#${shellId}`, blit, {
        onDraw: getPhotoPortOnDrawCount(),
        repaints: lcd.repaintCount,
        afterOnDraw1: lcd.repaintsAfterOnDraw1,
      })
    }, delayMs)
  }
}

function clearPhotoOverlayMountWatch(reason: string) {
  if (photoOverlayMountWatchTimer === undefined) {
    return
  }
  Timer.clear(photoOverlayMountWatchTimer)
  photoOverlayMountWatchTimer = undefined
  trace(`[PhotoMount] cleared (${reason}) ticks=${photoOverlayMountWatchTicks} fw=${PHOTO_FW_TRACE_TAG}\n`)
  photoOverlayMountWatchTicks = 0
}

/** Log shell mounted / onDraw count every 1s while preview is on screen. */
function schedulePhotoOverlayMountWatch(overlay: PiuContent, bundle: PhotoResultOverlayBundle, shellId: number) {
  clearPhotoOverlayMountWatch('reschedule')
  photoOverlayMountWatchTicks = 0
  tracePhotoFw('PhotoMount-watch-start', `shell#${shellId} interval=1000ms max=${PHOTO_OVERLAY_MOUNT_WATCH_MAX_TICKS}`)
  tracePhotoPreviewPhase('mount-watch-start', `shell#${shellId} interval=1000ms`)
  photoOverlayMountWatchTimer = Timer.repeat(() => {
    photoOverlayMountWatchTicks += 1
    const tick = photoOverlayMountWatchTicks
    const onDrawN = getPhotoPortOnDrawCount()
    describePhotoOverlayMountState(overlay, `mount-watch +${tick}s`, shellId)
    tracePhotoPreviewLayerStack(`mount-watch +${tick}s`, overlay, bundle.previewPort)
    const disp = getPhotoPreviewDisplayingStats()
    const lcd = getPhotoLcdPaintSnapshot()
    const luma = getPhotoPreviewLuma()
    trace(
      `[PhotoMount] tick=${tick} onDrawCount=${onDrawN} shellDisp=${disp.shellDisplaying} portDisp=${disp.portDisplaying} frozen=${photoPreviewPixelsFrozen ? 1 : 0} dismissed=${photoResultDismissed ? 1 : 0} repaints=${lcd.repaintCount} afterOnDraw1=${lcd.repaintsAfterOnDraw1} blitOk=${lcd.blitOk} backdropOnly=${lcd.backdropOnly} meanLuma=${luma.meanLuma} fw=${PHOTO_FW_TRACE_TAG}\n`,
    )
    const phaseHint = photoResultDismissed
      ? 'post-dismiss'
      : onDrawN === 0
        ? 'overlay-up-no-onDraw'
        : 'preview-overlay-hold'
    tracePhotoTimeline(`mount-watch tick=${tick} onDraw=${onDrawN} hint=${phaseHint}`)
    const sinceShowMs = photoPreviewShowAtMs > 0 ? Date.now() - photoPreviewShowAtMs : -1
    tracePhotoPreviewPhase(
      `mount-tick-${tick}`,
      `hint=${phaseHint} shell#${shellId} sinceShow=${sinceShowMs >= 0 ? `${sinceShowMs}ms` : '?'}`,
    )
    tracePhotoLcdMountTick(
      tick,
      `onDraw=${onDrawN} repaints=${lcd.repaintCount} afterOnDraw1=${lcd.repaintsAfterOnDraw1} blitOk=${lcd.blitOk} backdropOnly=${lcd.backdropOnly} frozen=${photoPreviewPixelsFrozen ? 1 : 0}`,
    )
    photoOverlayRobot?.renderer?.tracePhotoDisplayHierarchy?.(`PhotoLcd tick=${tick}`, PHOTO_RESULT_OVERLAY_KEY)
    if (tick >= PHOTO_OVERLAY_MOUNT_WATCH_MAX_TICKS) {
      clearPhotoOverlayMountWatch('max ticks')
    }
  }, 1000)
}

function clearPreviewHeapWatch(reason: string) {
  if (previewHeapWatchTimers.length === 0) {
    previewHeapWatchScheduled = false
    return
  }
  for (const id of previewHeapWatchTimers) {
    Timer.clear(id)
  }
  trace(`[PhotoDiag] preview heap watch cleared (${reason}) timers=${previewHeapWatchTimers.length}\n`)
  previewHeapWatchTimers = []
  previewHeapWatchScheduled = false
}

function schedulePreviewHeapWatch() {
  if (previewHeapWatchScheduled) {
    return
  }
  previewHeapWatchScheduled = true
  const delays = [1000, 3000, 5000, 10000, 15000, 20000, 25000]
  for (const delayMs of delays) {
    const id = Timer.set(() => {
      tracePhotoSessionDiag(`preview holding +${delayMs}ms`)
      tracePhotoBufferInventory(`preview holding +${delayMs}ms`)
    }, delayMs)
    previewHeapWatchTimers.push(id)
  }
  trace(`[PhotoDiag] preview heap watch scheduled (${delays.join(',')}ms) count=${previewHeapWatchTimers.length}\n`)
}

/** Ignore face/overlay touch dismiss for this long after showCapturedPhoto (stale drawer touch-up experiment). */
export const PHOTO_PREVIEW_TOUCH_GUARD_MS = 500

let photoPreviewTouchGuardUntilMs = 0

export function startPhotoPreviewTouchGuard(): void {
  const now = Date.now()
  photoPreviewTouchGuardUntilMs = now + PHOTO_PREVIEW_TOUCH_GUARD_MS
  tracePhotoTouchTimeline(
    'preview touch-guard ON',
    `guardMs=${PHOTO_PREVIEW_TOUCH_GUARD_MS} untilT=${photoPreviewTouchGuardUntilMs}`,
  )
  tracePhotoTimeline('showCapturedPhoto touch-guard start')
}

export function clearPhotoPreviewTouchGuard(): void {
  if (photoPreviewTouchGuardUntilMs === 0) return
  photoPreviewTouchGuardUntilMs = 0
  tracePhotoTouchTimeline('preview touch-guard OFF', 'dismiss or replace')
}

/**
 * Drop touch while preview is on screen and within guard window (likely drawer button touch-up).
 * @returns true if the touch was ignored
 */
export function shouldIgnorePhotoPreviewTouch(source: string, id: number, x: number, y: number): boolean {
  const now = Date.now()
  const until = photoPreviewTouchGuardUntilMs
  if (until <= 0 || now >= until) {
    return false
  }
  if (!photoResultOverlay || photoResultDismissed) {
    return false
  }
  tracePhotoTouchTimeline(
    'touch IGNORED guard',
    `source=${source} id=${id} x=${x} y=${y} remainMs=${until - now} frozen=${photoPreviewPixelsFrozen ? 1 : 0}`,
  )
  return true
}

/** True while capture or frozen preview is active — avoid drawer close PIU work. */
/** Preview shell on screen (overlay up, not dismissed) — for LCD repaint tracing. */
export function isPhotoPreviewSessionActive(): boolean {
  return !!photoResultOverlay && !photoResultDismissed
}

export function isPhotoSessionBusy(): boolean {
  return captureInFlight || photoPreviewPixelsFrozen || (!!photoResultOverlay && !photoResultDismissed)
}

function tracePhotoOverlayMilestone(renderer: CapturePhotoRenderer | null | undefined, phase: string): void {
  renderer?.tracePhotoOverlayMilestone?.(phase, PHOTO_RESULT_OVERLAY_KEY)
}

function tracePhotoInputState(renderer: CapturePhotoRenderer | null | undefined, phase: string): void {
  renderer?.tracePhotoInputState?.(phase, undefined, PHOTO_RESULT_OVERLAY_KEY)
}

function tracePhotoOverlayRuntimeSnapshot(renderer: CapturePhotoRenderer | null | undefined, phase: string): void {
  renderer?.tracePhotoOverlayRuntimeSnapshot?.(phase, PHOTO_RESULT_OVERLAY_KEY)
}

function blockPhotoUiResumeUntilOverlayDismissed(): void {
  photoUiResumeBlockedForOverlay = true
}

function clearPhotoUiResumeOverlayBlock(): void {
  photoUiResumeBlockedForOverlay = false
}

/** Keep chat/face paused until preview dismiss — must not rely on async onDraw. */
function shouldHoldPhotoUiPaused(): boolean {
  return photoUiResumeBlockedForOverlay || (!!photoResultOverlay && !photoResultDismissed)
}

let photoUiPauseRegisterCount = 0

export function registerPhotoUiPause(pause: () => void, resume: () => void): void {
  photoUiPause = pause
  photoUiResume = resume
  photoUiPauseRegisterCount += 1
  const overlayStats = getPhotoOverlayLifecycleStats()
  trace(
    `[PhotoLifecycle] registerPhotoUiPause call#=${photoUiPauseRegisterCount} overlayBuild=${overlayStats.buildCount} overlayDispose=${overlayStats.disposeCount} live=${overlayStats.liveCount}\n`,
  )
  tracePhotoFw('registerPhotoUiPause', `overlay=${PHOTO_OVERLAY_BUILD_ID} call#=${photoUiPauseRegisterCount}`)
  trace(`[Photo] preview overlay firmware ${PHOTO_OVERLAY_BUILD_ID} tag=${PHOTO_FW_TRACE_TAG}\n`)
  trace(`[PhotoCap] registerPhotoUiPause ok fw=${PHOTO_FW_TRACE_TAG} overlay=${PHOTO_OVERLAY_BUILD_ID}\n`)
  trace(`[PhotoUiTrace] registerPhotoUiPause build=${PHOTO_UI_TRACE_BUILD_ID}\n`)
  trace(`[STACKCHAN-FW] photoUi=${PHOTO_UI_TRACE_BUILD_ID}\n`)
  setPhotoTakeTraceFwTag(PHOTO_FW_TRACE_TAG)
}

export function bindDirectPhotoCapture(robot: CapturePhotoRobot): void {
  directCaptureRobot = robot
}

/** Drawer Camera → FaceView → AppController.takePhoto (robot.xsb cannot override class method on relink builds). */
let takePhotoDrawerRunner: (() => void | Promise<unknown>) | null = null

export function registerTakePhotoDrawerRunner(runner: () => void | Promise<unknown>): void {
  takePhotoDrawerRunner = runner
  trace(`[PhotoCap] registerTakePhotoDrawerRunner ok fw=${PHOTO_FW_TRACE_TAG}\n`)
}

export function invokeRegisteredTakePhotoDrawer(): boolean {
  if (!takePhotoDrawerRunner) {
    return false
  }
  tracePhotoTakeStep(3, 'invokeRegisteredTakePhotoDrawer (onRobotCreated callback)')
  try {
    const result = takePhotoDrawerRunner()
    if (result && typeof (result as { catch?: (handler: (err: unknown) => void) => void }).catch === 'function') {
      ;(result as { catch: (handler: (err: unknown) => void) => void }).catch((err: unknown) => {
        trace(`[Photo] takePhoto drawer runner rejected ${String(err)}\n`)
      })
    }
  } catch (err) {
    trace(`[Photo] takePhoto drawer runner error ${String(err)}\n`)
  }
  return true
}

export async function invokeDirectPhotoCapture(): Promise<CapturePhotoResult> {
  if (!directCaptureRobot) {
    return { ok: false }
  }
  return capturePhoto(directCaptureRobot, {
    save: false,
    playShutter: true,
    showPreview: true,
  })
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function photoElapsed(traceOriginMs: number): string {
  return ` +${Date.now() - traceOriginMs}ms`
}

function invalidatePhotoApplication(renderer: CapturePhotoRenderer | null | undefined, reason = 'unknown'): void {
  const app = renderer?.application as { invalidate?: () => void } | undefined
  trace(`[PhotoWinTrace] application.invalidate reason=${reason} hasApp=${app ? 1 : 0}\n`)
  app?.invalidate?.()
}

function removeCapturingBackdrop(renderer: CapturePhotoRenderer | null | undefined, reason = 'unknown'): void {
  if (!photoCaptureBackdrop) {
    trace(`[PhotoWinTrace] capturing-backdrop remove skip reason=${reason} (not mounted)\n`)
    return
  }
  trace(`[PhotoWinTrace] capturing-backdrop remove begin reason=${reason} key=${PHOTO_CAPTURE_BACKDROP_KEY}\n`)
  renderer?.removeScreenOverlay?.(PHOTO_CAPTURE_BACKDROP_KEY)
  photoCaptureBackdrop = null
  tracePhotoTimeline('capturing-backdrop removed')
  trace(`[PhotoWinTrace] capturing-backdrop remove done reason=${reason}\n`)
}

/** Hide face immediately after shutter — black LCD while camera warms up / captures. */
function showCapturingBackdrop(robot: CapturePhotoRobot): void {
  const renderer = robot.renderer
  if (!renderer?.showScreenOverlay) {
    return
  }
  removeCapturingBackdrop(renderer)
  const overlay = new Container(null, {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    active: true,
    visible: true,
    skin: new Skin({ fill: '#000000' }),
  })
  photoCaptureBackdrop = overlay
  renderer.obscureMainForPhotoPreview?.(true)
  renderer.showScreenOverlay(overlay, PHOTO_CAPTURE_BACKDROP_KEY)
  invalidatePhotoApplication(renderer, 'showCapturingBackdrop')
  tracePhotoTimeline('capturing-backdrop shown')
  trace(
    `[PhotoWinTrace] capturing-backdrop mount key=${PHOTO_CAPTURE_BACKDROP_KEY} fullscreen=320x240 fill=#000 (black LCD while capture)\n`,
  )
  trace('[Photo] capturing backdrop mounted (face hidden until preview blit)\n')
}

function logPhotoOverlayLifecycle(tag: string) {
  const stats = getPhotoOverlayLifecycleStats()
  trace(
    `[Photo] overlay lifecycle ${tag}: build=${stats.buildCount} dispose=${stats.disposeCount} live=${stats.liveCount} lastShell#=${stats.lastShellId}\n`,
  )
  if (stats.imbalance !== 0) {
    trace(`[Photo] WARNING overlay lifecycle ${tag}: imbalance=${stats.imbalance}\n`)
  }
}

function releasePhotoCaptureBuffers(reason: string) {
  photoPathStep('releasePhotoCaptureBuffers >>> ENTER', `reason=${reason}`)
  releasePreviewFrame(reason)
  photoPathStep('releasePhotoCaptureBuffers.after-releasePreviewFrame')
  releaseRgb565PreviewCopyPool(reason)
  photoPathStep('releasePhotoCaptureBuffers.after-releaseRgb565PreviewCopyPool')
  triggerGcIfAvailable()
  photoPathStep('releasePhotoCaptureBuffers <<< EXIT')
}

function showPhotoRestartNotice(robot: CapturePhotoRobot) {
  const renderer = robot.renderer
  if (!renderer?.showScreenOverlay) {
    trace('[PhotoRestart] notice skipped: no showScreenOverlay\n')
    return
  }
  trace(
    `[PhotoRestart] NOTICE overlay key=${PHOTO_RESTART_OVERLAY_KEY} message="${PHOTO_RESTART_MESSAGE}" capture#=${successfulPhotoCaptureCount} (grep PhotoRestart — center ????? if font/heap)\n`,
  )
  const backdrop = new Skin({ fill: '#101010' })
  const messageStyle = new Style({
    font: '20px Open Sans',
    color: '#ffffff',
    horizontal: 'center',
    vertical: 'middle',
  })
  const overlay = new Container(null, {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    active: true,
    visible: true,
    skin: backdrop,
    contents: [
      new Label(null, {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        string: PHOTO_RESTART_MESSAGE,
        style: messageStyle,
      }),
    ],
  })
  renderer.showScreenOverlay(overlay, PHOTO_RESTART_OVERLAY_KEY)
  renderer.obscureMainForPhotoPreview?.(false)
  const app = renderer.application as { invalidate?: () => void } | undefined
  app?.invalidate?.()
  trace(`[PhotoRestart] NOTICE shown: ${PHOTO_RESTART_MESSAGE}\n`)
}

function schedulePhotoSoftRestart(robot: CapturePhotoRobot) {
  if (photoRestartScheduled) {
    trace('[PhotoRestart] schedule skipped (already scheduled)\n')
    return
  }
  photoRestartScheduled = true
  tracePhotoSessionHealth('soft-restart-scheduled')
  trace(
    `[PhotoRestart] SCHEDULE after capture #${successfulPhotoCaptureCount} delay=${PHOTO_SOFT_RESTART_DELAY_MS}ms threshold=${PHOTO_CAPTURES_BEFORE_SOFT_RESTART}\n`,
  )

  if (photoResultOverlay && !photoResultDismissed) {
    dismissPhotoResult(robot, 'replace', 'schedulePhotoSoftRestart')
  }
  releasePhotoCaptureBuffers('soft restart')
  disposePhotoResultOverlay(photoResultOverlayBundle, 'soft restart')
  photoResultOverlayBundle = null
  photoResultOverlay = null

  showPhotoRestartNotice(robot)

  Timer.set(() => {
    trace('[Photo] System.restart()\n')
    const restart = (globalThis as { System?: { restart?: () => void } }).System?.restart
    if (typeof restart === 'function') {
      restart.call((globalThis as { System?: { restart?: () => void } }).System)
      return
    }
    trace('[Photo] System.restart unavailable\n')
  }, PHOTO_SOFT_RESTART_DELAY_MS)
}

function triggerGcIfAvailable() {
  const gc = (globalThis as { gc?: () => void }).gc
  if (gc) {
    try {
      gc()
    } catch {
      /* ignore */
    }
  }
}

/** Grep: PhotoSession — heap/host-frame health after each capture (????? / leak diagnosis). */
function tracePhotoSessionHealth(phase: string): void {
  const cam = getCameraHostFrameStats()
  const stats = getPhotoOverlayLifecycleStats()
  tracePhotoHeapCapture(`PhotoSession.${phase}`, `capture#=${successfulPhotoCaptureCount}`)
  trace(
    `[PhotoSession] ${phase} capture#=${successfulPhotoCaptureCount} hostLive=${cam.live} hostCreated=${cam.created} hostClosed=${cam.closed} drainedDetachedTotal=${cam.drainedWhileDetached} lastDrain=${cam.lastStaleDrainCount} readableDetached=${cam.readableDetached ? 1 : 0} overlayLive=${stats.liveCount} overlayImbalance=${stats.imbalance} restartScheduled=${photoRestartScheduled ? 1 : 0}\n`,
  )
  if (cam.live > 0) {
    trace(`[PhotoSession] WARN hostLive=${cam.live} after ${phase} (host frame leak?)\n`)
  }
  if (cam.drainedWhileDetached > 0 && phase.includes('capture')) {
    trace(
      `[PhotoSession] detached-readable drained total=${cam.drainedWhileDetached} last=${cam.lastStaleDrainCount} (grep Camera drained readable while detached)\n`,
    )
  }
  if (stats.imbalance !== 0) {
    trace(`[PhotoSession] WARN overlay imbalance=${stats.imbalance} after ${phase}\n`)
  }
}

function releasePreviewFrame(reason: string) {
  const frame = previewFrame
  previewFrame = null
  if (!frame) {
    trace(`[Photo] preview snapshot release (${reason}): none held\n`)
    return
  }
  const bytes = getRgb565BufferByteLength(frame.buffer)
  disposeCameraPreviewFrame(frame)
  triggerGcIfAvailable()
  trace(`[Photo] preview snapshot released (${reason}): ${bytes} bytes\n`)
}

function cancelPendingPhotoSave(reason: string) {
  const pending = pendingPhotoSave
  if (!pending) {
    return
  }
  pendingPhotoSave = null
  pending.onSaved(null)
  if (previewFrame === pending.snapshot) {
    previewFrame = null
  }
  disposeCameraPreviewFrame(pending.snapshot)
  triggerGcIfAvailable()
  trace(`[Photo] pending save cancelled (${reason})\n`)
}

function flushPendingPhotoSave(options?: { disposeSnapshot?: boolean }) {
  if (isPhotoSdMountUnavailable()) {
    cancelPendingPhotoSave('SD mount unavailable')
    return
  }
  const pending = pendingPhotoSave
  if (!pending) {
    return
  }
  pendingPhotoSave = null
  const disposeSnapshot = options?.disposeSnapshot !== false
  try {
    const savedPath = savePhoto(pending.snapshot)
    pending.onSaved(savedPath)
  } catch (error) {
    trace(`[Photo] save error: ${errorMessage(error)}\n`)
    pending.onSaved(null)
  } finally {
    if (disposeSnapshot) {
      if (previewFrame === pending.snapshot) {
        previewFrame = null
      }
      disposeCameraPreviewFrame(pending.snapshot)
      triggerGcIfAvailable()
      trace('[Photo] snapshot buffer released after SD save\n')
    } else {
      trace('[Photo] SD save done (snapshot kept for preview)\n')
    }
  }
}

/** First successful blit — keep frame/bitmap for redraws until dismiss (do not lock onDraw early). */
export function freezePhotoPreviewPixels() {
  if (!photoPreviewPixelsFrozen) {
    photoPreviewPixelsFrozen = true
    trace('[Photo] preview ready (hold frame until dismiss)\n')
  }
  tracePhotoSessionDiag('preview on screen (freezePhotoPreviewPixels)')
  tracePhotoBufferInventory('freezePhotoPreviewPixels')
  tracePhotoGraphicsForPhase(
    'preview-on-screen',
    photoResultOverlayBundle?.previewPort,
    undefined,
    photoResultOverlayBundle?.shellId,
  )
  tracePhotoDrawSummary('freezePhotoPreviewPixels')
  schedulePreviewHeapWatch()
}

/** True while a painted preview is on screen and waiting for face-touch dismiss. */
export function isPhotoPreviewAwaitingFaceDismiss(): boolean {
  return photoPreviewPixelsFrozen && !!photoResultOverlay && !photoResultDismissed
}

/** A/B/C/D path letter for [PhotoDismiss] grep (v13-dismiss-source). */
export function photoDismissPathFromSource(source: string): 'A' | 'B' | 'C' | 'D' | '-' {
  if (source.startsWith('previewPort.onTouchEnded')) return 'A'
  if (source.startsWith('overlayShell.onTouchEnded')) return 'B'
  if (source.includes('CommonView.OVERLAY')) return 'C'
  if (source.includes('Face.onTouchEnded')) return 'D'
  return '-'
}

/** @returns true when a frozen preview was dismissed */
export function dismissPhotoPreviewFromFaceTouch(source = 'AppController.onFaceTouch'): boolean {
  trace(
    `[DISMISS_GATE] robot=${photoOverlayRobot ? 1 : 0} frozen=${photoPreviewPixelsFrozen ? 1 : 0} overlay=${photoResultOverlay ? 1 : 0} dismissed=${photoResultDismissed ? 1 : 0}\n`,
  )
  const robot = photoOverlayRobot
  if (!robot || !isPhotoPreviewAwaitingFaceDismiss()) {
    return false
  }
  const path = photoDismissPathFromSource(source)
  tracePhotoTouchTimeline('dismiss faceTouch', `path=${path} source=${source}`)
  trace(`[PhotoDismiss] path=${path} faceTouch source=${source}\n`)
  dismissPhotoResult(robot, 'touch', source)
  return true
}

function removePhotoResultOverlayFromRenderer(
  robot: CapturePhotoRobot,
  overlay: PiuContent,
  usesScreenOverlay: boolean,
) {
  const renderer = robot.renderer
  if (usesScreenOverlay) {
    renderer?.removeScreenOverlay?.(PHOTO_RESULT_OVERLAY_KEY)
  } else {
    renderer?.removeDecorator?.(overlay)
  }
  photoResultUsesScreenOverlay = false
  trace('[Photo] overlay removed from renderer\n')
}

async function waitForCameraTeardown(): Promise<void> {
  const t0 = photoPathAwaitBegin('waitForCameraTeardown')
  try {
    await cameraTeardownChain
    photoPathAwaitEnd('waitForCameraTeardown', t0, 'ok')
  } catch (error) {
    photoPathAwaitEnd('waitForCameraTeardown', t0, `error=${errorMessage(error)}`)
    trace(`[Photo] prior teardown error: ${errorMessage(error)}\n`)
  }
}

function scheduleCameraTeardown(robot: CapturePhotoRobot): void {
  cameraTeardownChain = cameraTeardownChain.then(() => robot.camera.teardownAfterCapture())
  void cameraTeardownChain.then(() => {
    trace('[Photo] camera teardown returned\n')
    tracePhotoBufferInventory('camera teardown returned')
    triggerGcIfAvailable()
  })
}

function scheduleCameraTeardownDeferred(robot: CapturePhotoRobot, reason: string): void {
  tracePhotoTimeline(`teardown deferred ${PHOTO_TEARDOWN_DEFER_MS}ms (${reason})`)
  Timer.set(() => scheduleCameraTeardown(robot), PHOTO_TEARDOWN_DEFER_MS)
}

/** Pre-capture beep — pins/audioout via robot.tone (before backdrop/camera). */
export async function playPhotoShutterClick(robot: CapturePhotoRobot): Promise<void> {
  await robot.tone(1000, 80, 0.35)
}

export async function playPhotoShutterSound(robot: CapturePhotoRobot): Promise<void> {
  trace('[ShutterTrace] playPhotoShutterSound enter\n')
  trace('[Photo] playPhotoShutterSound begin\n')
  try {
    if (robot.shutterClick) {
      trace('[ShutterTrace] playPhotoShutterSound -> robot.shutterClick\n')
      await robot.shutterClick(0.5)
    } else {
      trace('[ShutterTrace] playPhotoShutterSound -> robot.tone fallback\n')
      await robot.tone(3600, 10, 0.5)
      await robot.tone(1300, 20, 0.28)
    }
    trace('[Photo] playPhotoShutterSound done\n')
  } catch (error) {
    trace(`[Photo] shutter sound failed: ${errorMessage(error)}\n`)
  }
}

export function dismissPhotoResult(
  robot: CapturePhotoRobot,
  reason: 'touch' | 'replace' = 'touch',
  source = reason === 'replace' ? 'unknown-replace' : 'unknown-touch',
) {
  trace(
    `[PhotoUiTrace] dismissPhotoResult enter reason=${reason} source=${source} overlay=${photoResultOverlay ? 1 : 0} dismissed=${photoResultDismissed ? 1 : 0}\n`,
  )
  const path = reason === 'touch' ? photoDismissPathFromSource(source) : '-'
  if (reason === 'touch') {
    tracePhotoTouchTimeline('dismissPhotoResult', `path=${path} source=${source}`)
  }
  trace(`[PhotoDismiss] path=${path} dismiss reason=${reason} source=${source}\n`)
  trace(
    `[PhotoWinTrace] dismissPhotoResult.enter reason=${reason} overlay=${photoResultOverlay ? 1 : 0} backdrop=${photoCaptureBackdrop ? 1 : 0} dismissed=${photoResultDismissed ? 1 : 0}\n`,
  )
  tracePhotoPreviewPhase('dismissPhotoResult-enter', `reason=${reason} source=${source} path=${path}`)
  if (reason !== 'replace') {
    clearPhotoPreviewTouchGuard()
    setPhotoLcdPaintTraceActive(false)
    setPhotoLcdOverwriteTrace(false)
    armPhotoFlushIliTrace(false)
    const flush = getPhotoFlushSendStats()
    const ili = getPhotoFlushIliStats()
    tracePhotoFlushNote(
      `dismiss summary jsSend.calls=${flush.calls} jsSend.bytes=${flush.bytes} ili.begin=${ili.begin} ili.doSend=${ili.send} ili.bytes=${ili.bytes}`,
    )
    uninstallPhotoFlushSendTrace()
  }
  clearPhotoOverlayMountWatch(`dismissPhotoResult reason=${reason} source=${source}`)
  clearPreviewHeapWatch(`dismissPhotoResult reason=${reason} source=${source}`)
  removeCapturingBackdrop(robot.renderer, 'showCapturedPhoto')
  const bundleAtEnter = photoResultOverlayBundle
  const overlayAtEnter = photoResultOverlay
  tracePhotoGfxCheckpointAtDismiss('dismiss-enter', bundleAtEnter, overlayAtEnter)
  tracePhotoBufferInventory(`dismissPhotoResult enter reason=${reason}`)
  tracePhotoHeapCapture(`dismiss.enter reason=${reason}`, `capture#=${successfulPhotoCaptureCount}`)
  tracePhotoSessionDiag(`dismissPhotoResult enter reason=${reason}`)
  logPhotoOverlayLifecycle(`dismissPhotoResult enter reason=${reason}`)
  if (reason !== 'replace') {
    if (photoResultDismissed) {
      trace(`[PhotoUiTrace] dismissPhotoResult skip (already dismissed) reason=${reason} source=${source}\n`)
      trace(`[Photo] dismissPhotoResult ignored (already dismissed, reason=${reason})\n`)
      logPhotoOverlayLifecycle(`dismissPhotoResult ignored reason=${reason}`)
      return
    }
    photoResultDismissed = true
  }

  trace(`[Photo] dismissPhotoResult reason=${reason}\n`)
  photoPreviewPixelsFrozen = false

  const overlay = photoResultOverlay
  const bundle = photoResultOverlayBundle
  const shellId = bundle?.shellId
  const usesScreenOverlay = photoResultUsesScreenOverlay
  if (reason !== 'replace' && !overlay && !previewFrame && !pendingPhotoSave) {
    trace(`[PhotoUiTrace] dismissPhotoResult skip (noop) reason=${reason} source=${source}\n`)
    logPhotoOverlayLifecycle(`dismissPhotoResult noop reason=${reason}`)
    return
  }

  describePhotoOverlayMountState(overlay, `dismiss enter reason=${reason}`, shellId)

  photoResultOverlay = null
  photoResultOverlayBundle = null
  photoOverlayRobot = null

  if (overlay) {
    removePhotoResultOverlayFromRenderer(robot, overlay, usesScreenOverlay)
    describePhotoOverlayMountState(overlay, `after removeScreenOverlay reason=${reason}`, shellId)
    tracePhotoGfxCheckpointAtDismiss('dismiss-after-unmount', bundleAtEnter, overlay)
    disposePhotoResultOverlay(bundle, `dismiss ${reason}`)
    tracePhotoOverlayMilestone(robot.renderer, 'disposePhotoResultOverlay')
    robot.renderer?.tracePhotoInputState?.('disposePhotoResultOverlay', undefined, PHOTO_RESULT_OVERLAY_KEY)
    tracePhotoGfxCheckpointAtDismiss('dismiss-after-dispose', bundleAtEnter, overlay)
    if (reason !== 'replace') {
      robot.renderer?.restoreScreenInput?.()
      trace(`[Photo] dismiss: preview ended (${reason})\n`)
    }
  } else {
    disposePhotoResultOverlay(bundle, `dismiss ${reason}`)
    tracePhotoOverlayMilestone(robot.renderer, 'disposePhotoResultOverlay')
    robot.renderer?.tracePhotoInputState?.('disposePhotoResultOverlay', undefined, PHOTO_RESULT_OVERLAY_KEY)
    tracePhotoGfxCheckpointAtDismiss('dismiss-after-dispose', bundleAtEnter, overlay)
    if (reason !== 'replace') {
      robot.renderer?.removeScreenOverlay?.(PHOTO_RESULT_OVERLAY_KEY)
      robot.renderer?.restoreScreenInput?.()
    }
  }

  describePhotoOverlayMountState(overlay, `dismiss exit reason=${reason}`, shellId)
  logPhotoOverlayLifecycle(`dismissPhotoResult exit reason=${reason}`)
  tracePhotoSessionDiag(`dismissPhotoResult exit reason=${reason}`)
  tracePhotoBufferInventory(`dismissPhotoResult exit reason=${reason}`)
  tracePhotoDrawSummary(`dismissPhotoResult exit reason=${reason}`)
  tracePhotoPreviewPhase('dismissPhotoResult-exit', `reason=${reason}`)

  if (reason === 'replace') {
    releasePhotoCaptureBuffers('replace dismiss')
  } else if (reason !== 'replace') {
    tracePhotoPhase('obscureMain', 'false (dismiss → main visible)')
    robot.renderer?.obscureMainForPhotoPreview?.(false)
    if (pendingPhotoSave) {
      flushPendingPhotoSave()
    }
    // Freeze usually cleared previewFrame; touch dismiss must confirm snapshot refs are gone.
    releasePreviewFrame(`dismiss ${reason}`)
    releaseRgb565PreviewCopyPool(`dismiss ${reason}`)
    clearPhotoUiResumeOverlayBlock()
    trace('[PhotoUiTrace] photoUiResume RUN (overlay dismissed)\n')
    tracePhotoPhase('photoUiResume', 'before dismiss-touch')
    tracePhotoSessionDiag('photoUiResume before (dismiss touch path)')
    photoUiResume?.()
    tracePhotoPhase('photoUiResume', 'after dismiss-touch')
    tracePhotoSessionDiag('photoUiResume after (dismiss touch path)')
    triggerGcIfAvailable()
    tracePhotoGfxCheckpointAtDismiss('dismiss-exit-post-gc', bundleAtEnter, overlay)
    void cameraTeardownChain.then(() => {
      triggerGcIfAvailable()
      tracePhotoGfxCheckpointAtDismiss('dismiss-exit-post-teardown-gc', bundleAtEnter, overlay)
    })
  }
  tracePhotoUiLayers(robot.renderer, `dismissPhotoResult.exit reason=${reason}`, PHOTO_RESULT_OVERLAY_KEY)
  trace(
    `[PhotoWinTrace] dismissPhotoResult.exit reason=${reason} overlay=${photoResultOverlay ? 1 : 0} backdrop=${photoCaptureBackdrop ? 1 : 0}\n`,
  )
}

export function showCapturedPhoto(robot: CapturePhotoRobot, frame: CameraFrame) {
  trace('[PhotoCycle] enter showCapturedPhoto\n')
  logPhotoCycle('show-enter')
  tracePhotoUiLayers(robot.renderer, 'showCapturedPhoto.enter', PHOTO_RESULT_OVERLAY_KEY)
  const traceOriginMs = Date.now()
  photoPreviewShowAtMs = traceOriginMs
  removeCapturingBackdrop(robot.renderer, 'showCapturedPhoto')
  resetPhotoFlushSendStats()
  try {
    installPhotoFlushSendTrace()
  } catch (err) {
    trace(`[PhotoFlush] showCapturedPhoto install error ${String(err)} (ignored)\n`)
  }
  resetPhotoPostFlushBaseline()
  setPhotoLcdPaintTraceActive(true)
  setPhotoLcdOverwriteTrace(true)
  tracePhotoKnownCorruptionSymptomsOnce()
  tracePhotoPreviewPhase('showCapturedPhoto-enter', `${frame.width}x${frame.height}`)
  trace(`[PhotoCap] showCapturedPhoto enter ${frame.width}x${frame.height} fw=${PHOTO_FW_TRACE_TAG}\n`)
  tracePhotoTimeline('showCapturedPhoto enter')
  tracePhotoSessionDiag('preview before showCapturedPhoto')
  logPhotoOverlayLifecycle('showCapturedPhoto enter')
  tracePhotoOverlayHeap('showCapturedPhoto enter')
  trace(`[Photo] showCapturedPhoto ${frame.width}x${frame.height} centered${photoElapsed(traceOriginMs)}\n`)

  if (!robot.renderer?.showScreenOverlay && !robot.renderer?.addDecorator) {
    trace('[Photo] showCapturedPhoto: no renderer, disposing frame\n')
    logPhotoCycle('capture-fail-show-no-renderer')
    disposeCameraPreviewFrame(frame)
    return
  }

  if (photoResultOverlay && !photoResultDismissed) {
    trace('[Photo] showCapturedPhoto: replacing prior preview (replace dismiss)\n')
    describePhotoOverlayMountState(
      photoResultOverlay,
      'showCapturedPhoto prior overlay',
      photoResultOverlayBundle?.shellId,
    )
    dismissPhotoResult(robot, 'replace', 'showCapturedPhoto.replace-prior')
  } else if (photoResultOverlay || photoResultOverlayBundle) {
    trace(
      `[Photo] showCapturedPhoto: stale refs dismissed=${photoResultDismissed} overlay=${!!photoResultOverlay} bundle=${!!photoResultOverlayBundle}\n`,
    )
    photoResultOverlay = null
    photoResultOverlayBundle = null
    photoPreviewPixelsFrozen = false
  } else {
    photoResultOverlay = null
    photoResultOverlayBundle = null
    photoPreviewPixelsFrozen = false
  }
  photoOverlayRobot = robot
  photoResultDismissed = false
  previewFrame = frame

  const requestDismiss = (source: string) => {
    trace(
      `[PhotoUiTrace] requestDismiss enter source=${source} dismissed=${photoResultDismissed ? 1 : 0} overlay=${photoResultOverlay ? 1 : 0}\n`,
    )
    if (photoResultDismissed) {
      trace(`[PhotoUiTrace] requestDismiss skip (photoResultDismissed) source=${source}\n`)
      trace(`[Photo] requestDismiss ignored (photoResultDismissed) source=${source}\n`)
      return
    }
    dismissPhotoResult(robot, 'touch', source)
  }

  const bundle = obtainPhotoResultOverlay(frame, {
    traceOriginMs,
    onRender: (mode) => {
      trace(`[Photo] preview on screen mode=${mode}${photoElapsed(traceOriginMs)}\n`)
      freezePhotoPreviewPixels()
    },
    onDismiss: (source) => requestDismiss(source),
  })
  const { overlay, refreshDisplay, shellId } = bundle

  photoResultOverlay = overlay
  photoResultOverlayBundle = bundle
  armPhotoFlushIliTrace(true, {
    x: bundle.displayLeft,
    y: bundle.displayTop,
    w: bundle.displayWidth,
    h: bundle.displayHeight,
  })

  const renderer = robot.renderer
  tracePhotoPhase('obscureMain', 'true (preview overlay)')
  renderer?.obscureMainForPhotoPreview?.(true)
  tracePhotoUiLayers(renderer, 'showCapturedPhoto.before-showScreenOverlay', PHOTO_RESULT_OVERLAY_KEY)
  if (renderer?.showScreenOverlay) {
    trace(
      `[SHOWSCREENOVERLAY_CALL] renderer=${
        renderer?.constructor?.name ?? '(null)'
      } hasMethod=${typeof renderer?.showScreenOverlay}\n`,
    )
    renderer.showScreenOverlay(overlay, PHOTO_RESULT_OVERLAY_KEY)
    photoResultUsesScreenOverlay = !!(overlay as PiuContent & { container?: unknown }).container
    describePhotoOverlayMountState(overlay, 'after showScreenOverlay', shellId)
    trace(
      `[Photo] showScreenOverlay mounted=${photoResultUsesScreenOverlay} shell#${shellId}${photoElapsed(traceOriginMs)}\n`,
    )
    tracePhotoUiLayers(renderer, 'showCapturedPhoto.after-showScreenOverlay', PHOTO_RESULT_OVERLAY_KEY)
    renderer?.tracePhotoOverlayHitState?.('showCapturedPhoto.after-showScreenOverlay', PHOTO_RESULT_OVERLAY_KEY)
    trace(
      `[PhotoWinTrace] photoResultOverlay shell#=${shellId} screen=320x240 blitAt=${bundle.displayLeft},${bundle.displayTop} size=${bundle.displayWidth}x${bundle.displayHeight} mounted=${photoResultUsesScreenOverlay ? 1 : 0}\n`,
    )
    logPhotoCycle(
      photoResultUsesScreenOverlay ? 'capture-success-overlay-mounted' : 'capture-fail-overlay-not-mounted',
      `shell#=${shellId}`,
    )
  } else if (renderer?.addDecorator) {
    renderer.addDecorator(overlay, PHOTO_RESULT_OVERLAY_KEY)
    photoResultUsesScreenOverlay = false
    describePhotoOverlayMountState(overlay, 'after addDecorator', shellId)
    logPhotoCycle('capture-success-overlay-decorator', `shell#=${shellId}`)
  }
  const shell = overlay as PiuContent & { active?: boolean; visible?: boolean }
  shell.active = true
  shell.visible = true
  tracePhotoPreviewLayerStack('showCapturedPhoto before refresh', overlay, bundle.previewPort)
  schedulePhotoPostFlushWatch(bundle, shellId)
  refreshDisplay(renderer?.application ?? undefined)
  invalidatePhotoApplication(renderer, 'showCapturedPhoto.refreshDisplay')
  tracePhotoFlushNote('showCapturedPhoto refreshDisplay (invalidate → onDraw → ili.doSend or screen.send)')
  Timer.set(() => {
    refreshDisplay(renderer?.application ?? undefined)
    invalidatePhotoApplication(renderer, 'showCapturedPhoto.refreshDisplay+100ms')
    const flush = getPhotoFlushSendStats()
    const ili = getPhotoFlushIliStats()
    tracePhotoFlushNote(
      `showCapturedPhoto refreshDisplay +100ms jsSend.calls=${flush.calls} jsSend.bytes=${flush.bytes} ili.begin=${ili.begin} ili.doSend=${ili.send} ili.bytes=${ili.bytes}`,
    )
  }, 100)
  tracePhotoBufferInventory('showCapturedPhoto after refreshDisplay')
  tracePhotoPreviewLayerStack('showCapturedPhoto after refresh', overlay, bundle.previewPort)
  tracePhotoGraphicsForPhase('capture-preview-mounted', bundle.previewPort, undefined, shellId)
  schedulePreviewHeapWatch()
  schedulePhotoOverlayMountWatch(overlay, bundle, shellId)
  const disp = getPhotoPreviewDisplayingStats()
  trace(
    `[PhotoDisplay] showCapturedPhoto-done (sync, before PIU onDraw) shell#${shellId} onDraw=${disp.onDraw} shellDisp=${disp.shellDisplaying} portDisp=${disp.portDisplaying}\n`,
  )
  tracePhotoFw('showCapturedPhoto-done', `shell#${shellId} onDraw=${disp.onDraw}`)
  tracePhotoDrawSummary('showCapturedPhoto after refresh')
  logPhotoOverlayLifecycle(`showCapturedPhoto exit shell#${shellId}`)
  tracePhotoOverlayHeap('showCapturedPhoto exit', shellId)
  tracePhotoTimeline('showCapturedPhoto exit')
  tracePhotoTouchTimeline('showCapturedPhoto exit', `shell#${shellId}`)
  trace(
    `[PhotoCap] showCapturedPhoto exit shell#${shellId} onDraw=${getPhotoPortOnDrawCount()} fw=${PHOTO_FW_TRACE_TAG}\n`,
  )
  tracePhotoPreviewPhase('showCapturedPhoto-exit-sync', `shell#${shellId} await-onDraw`)
  tracePhotoDrawSummary('showCapturedPhoto exit (sync)')
  startPhotoPreviewTouchGuard()
  logPhotoCycle('capture-success-after-show', `shell#=${shellId} onDraw=${disp.onDraw}`)
  blockPhotoUiResumeUntilOverlayDismissed()
  tracePhotoOverlayMilestone(renderer, 'capture-success-after-show')
  tracePhotoOverlayRuntimeSnapshot(renderer, 'capture-success-after-show')
  tracePhotoInputState(renderer, 'capture-success-after-show')
  tracePhotoUiLayers(renderer, 'showCapturedPhoto.exit', PHOTO_RESULT_OVERLAY_KEY)
}

/**
 * Capture still → copy once → teardown camera → preview and/or SD save.
 */
export async function capturePhoto(
  robot: CapturePhotoRobot,
  options: CapturePhotoOptions = {},
): Promise<CapturePhotoResult> {
  if (captureInFlight || isPhotoSessionBusy()) {
    trace('[Photo] capture already running or overlay alive (skip)\n')
    logPhotoCycle('capture-fail-in-flight')
    return { ok: false }
  }

  captureInFlight = true
  photoPathReset('capturePhoto')
  logPhotoCycle('attempt-begin', `ordinal=${successfulPhotoCaptureCount + 1}`)
  tracePhotoHeapCapture('capturePhoto.enter', `capture#=${successfulPhotoCaptureCount + 1}`)
  tracePhotoTakeStep(
    4,
    `capturePhoto() enter showPreview=${options.showPreview !== false} playShutter=${options.playShutter !== false}`,
  )
  trace(`[PhotoCap] capturePhoto enter fw=${PHOTO_FW_TRACE_TAG} showPreview=${options.showPreview !== false}\n`)
  trace(
    `[PhotoUiTrace] capturePhoto.enter build=${PHOTO_UI_TRACE_BUILD_ID} ordinal=${successfulPhotoCaptureCount + 1}\n`,
  )
  const { playShutter = true, showPreview = true, save = true, ...captureOverrides } = options
  photoPathStep('photoUiPause.before')
  tracePhotoSessionDiag('photoUiPause before')
  photoUiPause?.()
  photoPathStep('photoUiPause.after')
  tracePhotoSessionDiag('photoUiPause after')
  // 찰칵 소리는 실제로 찍힌 직후(camera.capture 뒤)에 냄 — 앞에서 내면 사진이 약 2초 늦게 보이는 느낌
  if (playShutter === false) {
    photoPathStep('playPhotoShutterClick.skipped')
  }
  if (showPreview !== false) {
    photoPathStep('showCapturingBackdrop.before')
    showCapturingBackdrop(robot)
    photoPathStep('showCapturingBackdrop.after')
  } else {
    photoPathStep('showCapturingBackdrop.skipped')
  }
  await waitForCameraTeardown()
  try {
    const captureOptions: CameraCaptureOptions = { ...PHOTO_CAPTURE_OPTIONS, ...captureOverrides }

    if (!isCameraAvailable()) {
      trace('[Photo] camera module unavailable\n')
      logPhotoCycle('capture-fail-no-camera')
      return { ok: false }
    }

    let snapshot: CameraFrame | undefined
    let result: CapturePhotoResult = { ok: false }

    try {
      const captureOrdinal = successfulPhotoCaptureCount + 1
      photoPathStep('capture-block >>> ENTER')
      tracePhotoTimeline('capture begin')
      tracePhotoHeapCapture('capture.begin', `capture#=${successfulPhotoCaptureCount + 1}`)
      photoPathStep('capture.begin PhotoTime-logged')
      trace(`[Photo] capture begin #${captureOrdinal} (${PHOTO_CAPTURE_BUILD_ID}) overlay=${PHOTO_OVERLAY_BUILD_ID}\n`)
      photoPathStep('tracePhotoGraphicsForPhase >>> BEFORE', `phase=capture-${captureOrdinal}-begin`)
      tracePhotoGraphicsForPhase(`capture-${captureOrdinal}-begin`)
      photoPathStep('tracePhotoGraphicsForPhase <<< AFTER')
      releasePhotoCaptureBuffers('capture begin')
      const captureBlockStartMs = Date.now()
      trace('[PhotoCycle] enter camera.start\n')
      logPhotoCycle('before-camera.start', `ordinal=${captureOrdinal}`)
      const startAwaitT0 = photoPathAwaitBegin('camera.start')
      await robot.camera.start(captureOptions)
      const startDoneMs = Date.now()
      logPhotoCycle('after-camera.start', `ordinal=${captureOrdinal}`)
      trace('[PhotoCycle] exit camera.start\n')
      photoPathAwaitEnd('camera.start', startAwaitT0, `blockMs=${startDoneMs - captureBlockStartMs}`)
      trace(
        `[CameraCap] photo-path camera.start() +${startDoneMs - captureBlockStartMs}ms total-from-capture-begin=+${startDoneMs - captureBlockStartMs}ms\n`,
      )
      const captureAwaitT0 = photoPathAwaitBegin('camera.capture')
      const captureAtMs = Date.now()
      trace('[PhotoCycle] enter camera.capture\n')
      logPhotoCycle('before-camera.capture', `ordinal=${captureOrdinal}`)
      const raw = await robot.camera.capture(captureOptions)
      const captureDoneMs = Date.now()
      if (raw && playShutter !== false) {
        await playPhotoShutterClick(robot)
      }
      trace(`[PhotoCycle] exit camera.capture raw=${raw ? `${raw.width}x${raw.height}` : 'none'}\n`)
      logPhotoCycle(
        raw ? 'after-camera.capture' : 'capture-fail-after-camera.capture',
        raw ? `${raw.width}x${raw.height}` : 'no-frame',
        captureOrdinal,
      )
      photoPathAwaitEnd(
        'camera.capture',
        captureAwaitT0,
        `blockMs=${captureDoneMs - captureBlockStartMs} directMs=${captureDoneMs - captureAtMs}`,
      )
      photoPathStep('camera.capture.promise-continued', `directMs=${captureDoneMs - captureAtMs}`)
      trace(
        `[CameraCap] photo-path camera.capture() +${captureDoneMs - captureAtMs}ms total-from-capture-begin=+${captureDoneMs - captureBlockStartMs}ms\n`,
      )
      trace(`[Photo] hardware frame acquired +${captureDoneMs - captureAtMs}ms\n`)

      photoPathStep('tracePhotoBufferInventory >>> BEFORE', 'after camera.capture raw')
      tracePhotoBufferInventory('after camera.capture raw')
      photoPathStep('tracePhotoBufferInventory <<< AFTER')

      if (raw) {
        photoPathStep('raw.frame.log', `${raw.width}x${raw.height} bytes=${raw.buffer.byteLength}`)
        trace(`[Photo] raw ${raw.width}x${raw.height} buffer=${raw.buffer.byteLength}\n`)
        photoPathStep('prepareCameraPreviewDisplayFrame >>> BEFORE')
        snapshot = prepareCameraPreviewDisplayFrame(raw)
        photoPathStep('prepareCameraPreviewDisplayFrame <<< AFTER', `${snapshot.width}x${snapshot.height}`)
        photoPathStep('tracePhotoBufferInventory >>> BEFORE', 'after prepare')
        tracePhotoBufferInventory('after prepareCameraPreviewDisplayFrame')
        photoPathStep('tracePhotoBufferInventory <<< AFTER')
        photoPathStep('sampleRgb565LeMeanLuma >>> BEFORE')
        const meanLuma = sampleRgb565LeMeanLuma(snapshot)
        photoPathStep('sampleRgb565LeMeanLuma <<< AFTER', `meanLuma=${meanLuma}`)
        trace(`[Photo] snapshot copied before stop (${snapshot.buffer.byteLength} bytes) meanLuma=${meanLuma}\n`)
        if (meanLuma < 2) {
          trace('[Photo] WARNING: snapshot nearly black\n')
        }
        result = { ok: true, width: snapshot.width, height: snapshot.height, frame: snapshot }
        photoPathStep('capture.complete >>> BEFORE PhotoTime')
        tracePhotoTimeline('capture complete')
        notePhotoCaptureCompleteMilestone()
        tracePhotoHeapCapture('capture.complete', `meanLuma=${meanLuma} poolGen=${getRgb565PoolCopyGeneration()}`)
        tracePhotoBufferInventory('capture.complete')
        photoPathEmitSummary('capture.complete')
        tracePhotoLatencyMilestone('capture-complete-marked')
        photoPathStep('capture.complete <<< AFTER PhotoTime')
        logPhotoCycle('capture-success-after-capture', `meanLuma=${meanLuma}`, captureOrdinal)
      } else {
        photoPathStep('camera.capture.no-frame')
        trace('[Photo] no frame from camera.capture\n')
        logPhotoCycle('capture-fail-no-frame', `ordinal=${captureOrdinal}`)
      }
      photoPathStep('capture-block <<< EXIT', 'grep camera.capture AWAIT-END awaitMs + copy.set.after')
    } catch (error) {
      photoPathStep('capture-block ERROR', errorMessage(error))
      trace(`[Photo] capture error: ${errorMessage(error)}\n`)
      logPhotoCycle('capture-fail-error', errorMessage(error))
      result = { ok: false }
    }

    if (result.ok && snapshot) {
      photoPathStep('deliver >>> BEGIN')
      tracePhotoHeapCapture('deliver.begin', `capture#=${successfulPhotoCaptureCount + 1}`)
      successfulPhotoCaptureCount += 1
      const shouldSoftRestart = successfulPhotoCaptureCount >= PHOTO_CAPTURES_BEFORE_SOFT_RESTART
      trace(
        `[Photo] deliver result to user (capture #${successfulPhotoCaptureCount}${shouldSoftRestart ? ', restart pending' : ''})\n`,
      )
      tracePhotoGraphicsForPhase(`capture-${successfulPhotoCaptureCount}-deliver`)
      photoPathStep('deliver.after-tracePhotoGraphicsForPhase')
      tracePhotoBufferInventory('after capture deliver')
      photoPathStep('deliver.after-tracePhotoBufferInventory')

      if (save !== false && showPreview !== false) {
        photoPathStep('deliver.save-skipped-showPreview')
        trace('[Photo] save skipped: showPreview avoids SD mount (heap)\n')
      } else if (save !== false && !isPhotoSdMountUnavailable()) {
        photoPathStep('deliver.pendingPhotoSave-set')
        pendingPhotoSave = {
          snapshot,
          onSaved: (savedPath) => {
            if (savedPath) {
              result.savedPath = savedPath
            }
          },
        }
      } else if (save !== false && isPhotoSdMountUnavailable()) {
        photoPathStep('deliver.save-skipped-sd-unavailable')
        trace('[Photo] save skipped: SD unavailable this boot\n')
      }
      if (pendingPhotoSave && showPreview === false) {
        photoPathStep('deliver.flushPendingPhotoSave >>> BEFORE')
        flushPendingPhotoSave({ disposeSnapshot: true })
        photoPathStep('deliver.flushPendingPhotoSave <<< AFTER')
      }

      if (shouldSoftRestart) {
        photoPathStep('deliver.softRestart-branch')
        disposeCameraPreviewFrame(snapshot)
        result.frame = undefined
        scheduleCameraTeardown(robot)
        schedulePhotoSoftRestart(robot)
      } else if (showPreview !== false) {
        photoPathStep('showCapturedPhoto >>> BEFORE')
        logPhotoCycle('capture-success-before-show', `capture#=${successfulPhotoCaptureCount}`)
        tracePhotoUiLayers(robot.renderer, 'capturePhoto.before-showCapturedPhoto', PHOTO_RESULT_OVERLAY_KEY)
        tracePhotoLatencyMilestone('showCapturedPhoto-before', `capture#=${successfulPhotoCaptureCount + 1}`)
        trace(`[PhotoCap] capturePhoto deliver preview ${snapshot.width}x${snapshot.height} fw=${PHOTO_FW_TRACE_TAG}\n`)
        showCapturedPhoto(robot, snapshot)
        notePhotoShowCapturedMilestone()
        tracePhotoLatencyMilestone('showCapturedPhoto-after-sync')
        tracePhotoHeapCapture('showCapturedPhoto.after-sync', `capture#=${successfulPhotoCaptureCount}`)
        photoPathStep('showCapturedPhoto <<< AFTER')
        result.frame = undefined
        scheduleCameraTeardownDeferred(robot, 'after showCapturedPhoto')
        photoPathStep('deliver.after-scheduleCameraTeardownDeferred')
      } else if (save !== false) {
        result.frame = undefined
        scheduleCameraTeardown(robot)
      } else {
        disposeCameraPreviewFrame(snapshot)
        result.frame = undefined
        scheduleCameraTeardown(robot)
      }
      photoPathStep('deliver <<< END')
      tracePhotoHeapCapture('deliver.end', `capture#=${successfulPhotoCaptureCount}`)
      tracePhotoSessionHealth('deliver-end')
      logPhotoCycle('capture-success-deliver-end')
    } else {
      logPhotoCycle('capture-fail-deliver-skipped', `ok=${result.ok ? 1 : 0} snapshot=${snapshot ? 1 : 0}`)
      scheduleCameraTeardown(robot)
      removeCapturingBackdrop(robot.renderer, 'showCapturedPhoto')
      if (snapshot) {
        disposeCameraPreviewFrame(snapshot)
      }
    }

    return result
  } finally {
    captureInFlight = false
    photoPathStep('capturePhoto.finally.enter')
    tracePhotoHeapCapture('capturePhoto.finally.enter', `capture#=${successfulPhotoCaptureCount}`)
    if (!photoResultOverlay && !photoResultDismissed && photoCaptureBackdrop) {
      removeCapturingBackdrop(robot.renderer, 'showCapturedPhoto')
      robot.renderer?.obscureMainForPhotoPreview?.(false)
      photoPathStep('capturePhoto.finally.removed-backdrop')
    }
    if (photoRestartScheduled) {
      photoPathStep('photoUiResume.skipped', `restart=${photoRestartScheduled ? 1 : 0}`)
      tracePhotoPhase('photoUiResume', 'SKIP soft-restart scheduled')
    } else if (shouldHoldPhotoUiPaused()) {
      photoPathStep(
        'photoUiResume.blocked',
        `hold=${photoUiResumeBlockedForOverlay ? 1 : 0} overlay=${photoResultOverlay ? 1 : 0}`,
      )
      trace('[PhotoUiTrace] photoUiResume BLOCKED (photo overlay alive)\n')
      tracePhotoOverlayMilestone(robot.renderer, 'capturePhoto.finally.overlay-alive')
      tracePhotoUiLayers(robot.renderer, 'capturePhoto.finally.photoUiResume-blocked', PHOTO_RESULT_OVERLAY_KEY)
      tracePhotoPhase(
        'photoUiResume',
        `BLOCKED hold=${photoUiResumeBlockedForOverlay ? 1 : 0} overlay=${photoResultOverlay ? 1 : 0} dismissed=${photoResultDismissed ? 1 : 0}`,
      )
    } else {
      photoPathStep('photoUiResume.before')
      tracePhotoPhase('photoUiResume', 'capture-finally before')
      tracePhotoSessionDiag('photoUiResume before')
      photoUiResume?.()
      photoPathStep('photoUiResume.after')
      tracePhotoPhase('photoUiResume', 'capture-finally after')
      tracePhotoSessionDiag('photoUiResume after')
      tracePhotoUiLayers(robot.renderer, 'capturePhoto.finally.after-photoUiResume', PHOTO_RESULT_OVERLAY_KEY)
    }
    photoPathStep('capturePhoto.finally.exit')
    tracePhotoHeapCapture('capturePhoto.finally.exit', `capture#=${successfulPhotoCaptureCount}`)
    logPhotoCycle('attempt-finally')
    trace(`[PhotoPath] DONE seq=${photoPathSeqCount()} (grep !GAP! !AWAIT-SLOW! AWAIT-BEGIN AWAIT-END)\n`)
    photoPathClear()
    trace('[Photo] busy cleared\n')
  }
}

/** @internal Test hook */
export function resetPhotoCaptureBusyForTest(): void {
  captureInFlight = false
  photoResultOverlay = null
  photoResultOverlayBundle = null
  previewFrame = null
  photoResultUsesScreenOverlay = false
  photoOverlayRobot = null
  photoPreviewPixelsFrozen = false
  photoResultDismissed = false
  pendingPhotoSave = null
  successfulPhotoCaptureCount = 0
  photoRestartScheduled = false
  photoUiResumeBlockedForOverlay = false
  previewHeapWatchScheduled = false
  clearPreviewHeapWatch('resetPhotoCaptureBusyForTest')
}
