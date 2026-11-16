// @ts-nocheck
import Modules from 'modules'
import { sampleRgb565LeMeanLumaSafe } from './camera-preview-utils.js'
import { photoPathAwaitBegin, photoPathAwaitEnd, photoPathStep } from './photo-session-diagnostics.js'
import { finalizeCameraBus, finalizeCameraBusAsync } from './camera-i2c-bus.js'
import Timer from 'timer'

type CameraI2CBusModule = {
  prepareCameraBus: () => boolean
  releaseCameraBusForCapture: () => void
  finalizeCameraBus: () => void
}

function loadCameraI2CBus(): CameraI2CBusModule | null {
  if (!Modules.has('camera-i2c-bus')) {
    return null
  }
  return Modules.importNow('camera-i2c-bus') as CameraI2CBusModule
}

function prepareCameraBus(): boolean {
  return loadCameraI2CBus()?.prepareCameraBus() ?? true
}

function releaseCameraBusForCapture(): void {
  loadCameraI2CBus()?.releaseCameraBusForCapture()
}

function finalizeCameraBusSync(): void {
  finalizeCameraBus()
}

export type CameraImageType = 'rgb565le' | 'yuv422' | 'jpeg'

export type CameraFrame = {
  width: number
  height: number
  imageType: CameraImageType
  buffer: ArrayBuffer
  close?: () => void
}

export type CameraCaptureOptions = {
  width?: number
  height?: number
  imageType?: CameraImageType
  useBrowserCamera?: boolean
}

export interface RobotCamera {
  start(options?: CameraCaptureOptions): Promise<void> | void
  stop(): Promise<void> | void
  capture(options?: CameraCaptureOptions): Promise<CameraFrame | undefined>
  /** Stop stream and drain; keep Esp32Camera open for next capture (Plan B — no close). */
  teardownAfterCapture(): Promise<void>
  /** Full shutdown: stop, close device, restore PY32 bus. */
  release(): void
}

type DisposableHostBuffer = ArrayBuffer & {
  byteLength: number
  close?: () => void
}

type Esp32CameraDevice = {
  width: number
  height: number
  start(): void
  stop(): void
  read(): DisposableHostBuffer | undefined
  close(): void
}

type Esp32CameraCtor = new (options: {
  width: number
  height: number
  imageType: number
  format: string
  onReadable: () => void
}) => Esp32CameraDevice

const CAPTURE_TIMEOUT_MS = 5000
/** After device.stop() — let the native task leave esp_camera_fb_get and apply kStateStopping. */
const STREAM_STOP_SETTLE_MS = 50
const TEARDOWN_DRAIN_ROUNDS = 2
const TEARDOWN_DRAIN_ROUND_MS = 20
/** Discard early frames so sensor AEC/exposure can settle (ESP32 often needs 2+). */
const CAPTURE_WARMUP_FRAMES = 2
/** After at least one successful capture this boot, sensor is warm — skip extra warmups. */
const CAPTURE_WARMUP_FRAMES_REUSE = 0
/** Extra readable callbacks while mean luma is still very low after warmup. */
const CAPTURE_DARK_FRAME_RETRIES = 2
const CAPTURE_AEC_RETRY_MIN_LUMA = 10

type CapturePendingHandler = (frame: CameraFrame | undefined) => boolean

/** Host disposable buffers from Esp32Camera.read() — diagnostic counters. */
let cameraHostFramesLive = 0
let cameraHostFramesCreated = 0
let cameraHostFramesClosed = 0
let cameraHostFramesDrainedWhileDetached = 0
let cameraLastStaleDrainCount = 0
let cameraReadableDetached = false
/** Successful still frames delivered this boot — reuse path skips warmup discards. */
let cameraSuccessfulCaptures = 0

export function getCameraHostFrameStats() {
  return {
    live: cameraHostFramesLive,
    created: cameraHostFramesCreated,
    closed: cameraHostFramesClosed,
    drainedWhileDetached: cameraHostFramesDrainedWhileDetached,
    lastStaleDrainCount: cameraLastStaleDrainCount,
    readableDetached: cameraReadableDetached,
  }
}

function logPhotoCycleCamera(phase: string, detail = ''): void {
  const cam = getCameraHostFrameStats()
  const suffix = detail ? ` ${detail}` : ''
  trace(`[PhotoCycle] ${phase} readableDetached=${cam.readableDetached ? 1 : 0} hostLive=${cam.live}${suffix}\n`)
}

function trackHostFrameOpened(): void {
  cameraHostFramesLive += 1
  cameraHostFramesCreated += 1
}

function trackHostFrameClosed(): void {
  if (cameraHostFramesLive > 0) {
    cameraHostFramesLive -= 1
  }
  cameraHostFramesClosed += 1
}

function wrapHostFrameClose(closeFn?: () => void): () => void {
  let closed = false
  return () => {
    if (closed) {
      return
    }
    closed = true
    trackHostFrameClosed()
    try {
      closeFn?.()
    } catch (error) {
      traceCameraError('buffer close failed', error)
    }
  }
}

/** Default when options omit size (non-photo paths). */
const DEFAULT_CAPTURE_WIDTH = 320
const DEFAULT_CAPTURE_HEIGHT = 240

export function isCameraAvailable(): boolean {
  return Modules.has('embedded:io/image/in/camera')
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function traceCameraError(label: string, error: unknown) {
  trace(`[Camera] ${label}: ${errorMessage(error)}\n`)
}

function loadEsp32CameraCtor(): Esp32CameraCtor {
  return Modules.importNow('embedded:io/image/in/camera') as unknown as Esp32CameraCtor
}

function loadRgb565Le(): number {
  const Bitmap = Modules.importNow('commodetto/Bitmap') as { RGB565LE: number }
  return Bitmap.RGB565LE
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const normalized = value | 0
  return normalized > 0 ? normalized : fallback
}

function safeCloseDevice(device: Esp32CameraDevice | null | undefined) {
  if (!device) return
  try {
    trace('[Camera] device.close()\n')
    device.close()
    trace('[Camera] device.close() done\n')
  } catch (error) {
    traceCameraError('close failed', error)
  }
}

async function drainDeviceFramesAggressively(
  drain: (device: Esp32CameraDevice | null | undefined) => number,
  device: Esp32CameraDevice | null | undefined,
): Promise<number> {
  let total = 0
  for (let round = 0; round < TEARDOWN_DRAIN_ROUNDS; round++) {
    const drained = drain(device)
    total += drained
    if (drained === 0 && round >= 2) {
      break
    }
    await delayMs(TEARDOWN_DRAIN_ROUND_MS)
  }
  return total
}

function safeStopDevice(device: Esp32CameraDevice | null | undefined) {
  if (!device) return
  try {
    trace('[Camera] device.stop()\n')
    device.stop()
    trace('[Camera] device.stop() done\n')
  } catch (error) {
    traceCameraError('stop failed', error)
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    Timer.set(() => resolve(), ms)
  })
}

/** Per-capture path trace — grep: [CameraCap] */
type CapturePathTrace = {
  t0: number
  lastStepMs: number
  warmupBudget: number
  darkRetryBudget: number
  timeoutMs: number
  priorCaptures: number
  warmupDiscarded: number
  darkRetryDiscarded: number
  emptyReadable: number
  framesReceived: number
  drainedAtStart: number
  timedOut: boolean
  deviceStartMs: number | null
  firstReadableMs: number | null
  lastReadableMs: number | null
  acceptedLuma: number
}

function captureTraceStep(path: CapturePathTrace, label: string, detail = ''): void {
  const now = Date.now()
  const stepMs = now - path.lastStepMs
  const totalMs = now - path.t0
  path.lastStepMs = now
  const detailPart = detail ? ` ${detail}` : ''
  trace(`[CameraCap] ${label} step=+${stepMs}ms total=+${totalMs}ms${detailPart}\n`)
}

function captureTraceSummary(path: CapturePathTrace, outcome: string): void {
  const totalMs = Date.now() - path.t0
  const firstReadableWaitMs =
    path.firstReadableMs != null && path.deviceStartMs != null ? path.firstReadableMs - path.deviceStartMs : -1
  trace(
    `[CameraCap] SUMMARY outcome=${outcome} total=${totalMs}ms frameWaitTimeoutMs=${path.timeoutMs}${path.timedOut ? ' TIMED_OUT=1' : ''}\n`,
  )
  trace(
    `[CameraCap] SUMMARY budgets warmup=${path.warmupBudget} darkRetry=${path.darkRetryBudget} aecMinLuma=${CAPTURE_AEC_RETRY_MIN_LUMA} priorCaptures=${path.priorCaptures}\n`,
  )
  trace(
    `[CameraCap] SUMMARY discards warmup=${path.warmupDiscarded} darkRetry=${path.darkRetryDiscarded} emptyReadable=${path.emptyReadable} drainedAtStart=${path.drainedAtStart}\n`,
  )
  trace(
    `[CameraCap] SUMMARY frames received=${path.framesReceived} firstReadableAfterDeviceStart=${firstReadableWaitMs >= 0 ? `${firstReadableWaitMs}ms` : 'never'} acceptedLuma=${path.acceptedLuma >= 0 ? path.acceptedLuma : 'n/a'}\n`,
  )
}

class Esp32RobotCamera implements RobotCamera {
  device: Esp32CameraDevice | null = null
  pending: CapturePendingHandler | null = null
  captureTimer: ReturnType<typeof Timer.set> | undefined
  /** True only after release() — full native close. */
  #released = false
  #streamStopped = false
  /** After teardown: ignore native onReadable (stop does not unregister the callback). */
  #readableDetached = false
  #captureFinish: ((frame: CameraFrame | undefined) => void) | null = null
  #capturePath: CapturePathTrace | null = null

  clearCaptureTimer() {
    if (this.captureTimer === undefined) return
    Timer.clear(this.captureTimer)
    this.captureTimer = undefined
  }

  rejectPendingCapture() {
    const finish = this.#captureFinish
    this.pending = null
    this.#captureFinish = null
    this.clearCaptureTimer()
    if (!finish) {
      if (this.#capturePath) {
        captureTraceStep(this.#capturePath, 'capture.rejected-no-finish')
        captureTraceSummary(this.#capturePath, 'rejected')
        this.#capturePath = null
      }
      return
    }
    this.detachReadableListener('rejected')
    finish(undefined)
  }

  detachReadableListener(reason: string) {
    if (this.#readableDetached) {
      return
    }
    this.#readableDetached = true
    cameraReadableDetached = true
    trace(`[Camera] onReadable detached (${reason})\n`)
  }

  attachReadableListener() {
    this.#readableDetached = false
    cameraReadableDetached = false
  }

  /** Native onReadable may still fire after detach — drain and close host buffers. */
  drainReadableWhileDetached(reason: string): number {
    let drained = 0
    while (true) {
      const stale = this.readFrame()
      if (!stale) {
        break
      }
      drained += 1
      try {
        stale.close?.()
      } catch (error) {
        traceCameraError('detached drain close failed', error)
      }
    }
    if (drained > 0) {
      cameraHostFramesDrainedWhileDetached += drained
      cameraLastStaleDrainCount = drained
      trace(`[Camera] drained ${drained} readable frame(s) while detached (${reason})\n`)
      trace(
        `[PhotoSession] detached-drain +${drained} total=${cameraHostFramesDrainedWhileDetached} reason=${reason} hostLive=${cameraHostFramesLive}\n`,
      )
    }
    return drained
  }

  /** Drop one buffered frame and return host buffer to the pool. */
  drainDeviceFrames(device: Esp32CameraDevice | null | undefined): number {
    if (!device) return 0
    let drained = 0
    while (true) {
      let hostBuffer: DisposableHostBuffer | undefined
      try {
        hostBuffer = device.read()
      } catch (error) {
        traceCameraError('drain read failed', error)
        break
      }
      if (!hostBuffer) break
      drained++
      try {
        hostBuffer.close?.()
      } catch (error) {
        traceCameraError('drain frame close failed', error)
      }
    }
    if (drained > 0) {
      trace(`[Camera] drained ${drained} stale frame(s)\n`)
    }
    return drained
  }

  readFrame(): CameraFrame | undefined {
    const device = this.device
    if (!device || this.#released) return undefined

    let hostBuffer: DisposableHostBuffer | undefined
    try {
      hostBuffer = device.read()
    } catch (error) {
      traceCameraError('read failed', error)
      return undefined
    }
    if (!hostBuffer) {
      return undefined
    }

    trackHostFrameOpened()
    trace(`[Camera] readFrame: ok ${hostBuffer.byteLength} bytes (zero-copy) hostLive=${cameraHostFramesLive}\n`)
    return {
      width: device.width,
      height: device.height,
      imageType: 'rgb565le',
      buffer: hostBuffer as unknown as ArrayBuffer,
      close: wrapHostFrameClose(() => {
        hostBuffer?.close?.()
      }),
    }
  }

  delayAfterBusRelease() {
    const delay = (globalThis as { Timer?: { delay: (ms: number) => void } }).Timer?.delay
    if (delay) delay(150)
  }

  async start(options?: CameraCaptureOptions): Promise<void> {
    logPhotoCycleCamera('enter camera.start')
    if (this.device) {
      releaseCameraBusForCapture()
      trace('[Camera] reusing Esp32Camera (stream starts at capture)\n')
      logPhotoCycleCamera('exit camera.start', 'reuse')
      return
    }

    this.#released = false
    this.#streamStopped = false
    this.#readableDetached = false
    this.delayAfterBusRelease()

    const width = normalizeDimension(options?.width, DEFAULT_CAPTURE_WIDTH)
    const height = normalizeDimension(options?.height, DEFAULT_CAPTURE_HEIGHT)

    try {
      if (!prepareCameraBus()) {
        trace('[Camera] internal I2C probe failed, skipping camera init\n')
        return
      }

      const Esp32Camera = loadEsp32CameraCtor()
      const imageType = loadRgb565Le()

      trace(`[Camera] start ${width}x${height}\n`)
      trace('[Camera] constructing device (new Esp32Camera)\n')
      this.device = new Esp32Camera({
        width,
        height,
        imageType,
        format: 'buffer/disposable',
        onReadable: () => {
          if (this.#released || this.#readableDetached) {
            this.drainReadableWhileDetached('onReadable while detached')
            return
          }
          trace('[Camera] onReadable\n')
          try {
            if (!this.device) {
              return
            }
            if (!this.pending) {
              const stale = this.readFrame()
              if (stale) {
                try {
                  stale.close?.()
                } catch (error) {
                  traceCameraError('orphan frame close failed', error)
                }
                trace('[Camera] drained orphan readable frame\n')
              }
              return
            }
            const handler = this.pending
            const frame = this.readFrame()
            if (handler(frame)) {
              this.pending = null
              this.clearCaptureTimer()
            }
          } catch (error) {
            traceCameraError('onReadable failed', error)
            this.rejectPendingCapture()
          }
        },
      })
      trace('[Camera] device ready (stream deferred until capture)\n')
      logPhotoCycleCamera('exit camera.start', 'device-ready')
    } catch (error) {
      const message = errorMessage(error)
      trace(`[Camera] Esp32Camera constructor failed: ${message}\n`)
      traceCameraError('start failed', error)
      safeCloseDevice(this.device)
      this.device = null
      finalizeCameraBusSync()
      logPhotoCycleCamera('exit camera.start', 'constructor-failed')
    }
  }

  async stop(): Promise<void> {
    await this.stopCaptureStream()
  }

  /**
   * End streaming after a still frame: stop native task, drain DMA buffers, settle.
   * Call before copying pixels and again from teardownBeforeClose if needed.
   */
  async stopCaptureStream(device: Esp32CameraDevice | null = this.device): Promise<void> {
    if (this.#streamStopped) {
      return
    }
    this.rejectPendingCapture()
    if (!device) {
      this.#streamStopped = true
      return
    }

    safeStopDevice(device)
    this.drainDeviceFrames(device)
    this.#streamStopped = true
    trace(`[Camera] stream stopped (readableSuppressed, no settle needed)\n`)
  }

  /**
   * Plan B: stop stream only — Esp32Camera stays init for the next capture (no device.close()).
   */
  async teardownAfterCapture(): Promise<void> {
    if (!this.device) {
      trace('[Camera] teardown complete (no device)\n')
      return
    }
    const teardownT0 = photoPathAwaitBegin('camera.teardownAfterCapture')
    this.rejectPendingCapture()
    if (!this.#readableDetached) {
      this.detachReadableListener('teardown')
    }
    await this.stopCaptureStream(this.device)
    this.drainDeviceFrames(this.device)
    this.#streamStopped = false
    photoPathAwaitEnd('camera.teardownAfterCapture', teardownT0, 'device-kept')
    trace('[Camera] teardown complete (device kept for reuse)\n')
  }

  /** Full native shutdown (close + PY32 restore). Not used per photo capture. */
  async shutdownCamera(): Promise<void> {
    if (this.#released) {
      return
    }
    this.#released = true
    this.detachReadableListener('shutdown')
    this.rejectPendingCapture()
    const device = this.device
    this.device = null
    this.#streamStopped = false
    if (device) {
      await this.stopCaptureStream(device)
      safeCloseDevice(device)
      await finalizeCameraBusAsync()
    }
    trace('[Camera] shutdown complete\n')
  }

  close(): void {
    void this.shutdownCamera()
  }

  release(): void {
    void this.shutdownCamera()
  }

  async capture(options: CameraCaptureOptions = {}): Promise<CameraFrame | undefined> {
    const path: CapturePathTrace = {
      t0: Date.now(),
      lastStepMs: Date.now(),
      warmupBudget: cameraSuccessfulCaptures > 0 ? CAPTURE_WARMUP_FRAMES_REUSE : CAPTURE_WARMUP_FRAMES,
      darkRetryBudget: CAPTURE_DARK_FRAME_RETRIES,
      timeoutMs: CAPTURE_TIMEOUT_MS,
      priorCaptures: cameraSuccessfulCaptures,
      warmupDiscarded: 0,
      darkRetryDiscarded: 0,
      emptyReadable: 0,
      framesReceived: 0,
      drainedAtStart: 0,
      timedOut: false,
      deviceStartMs: null,
      firstReadableMs: null,
      lastReadableMs: null,
      acceptedLuma: -1,
    }
    this.#capturePath = path
    captureTraceStep(path, 'capture.enter')
    logPhotoCycleCamera('enter camera.capture')
    trace(
      `[CameraCap] CONFIG warmupBudget=${path.warmupBudget} darkRetryBudget=${path.darkRetryBudget} frameWaitTimeoutMs=${path.timeoutMs} priorCaptures=${path.priorCaptures}\n`,
    )

    try {
      trace('[Camera] capture: begin (fresh stream frame)\n')
      if (!this.device) {
        trace('[Camera] capture: calling start()\n')
        await this.start(options)
        captureTraceStep(path, 'capture.start()')
        trace('[Camera] capture: start() returned\n')
      } else {
        captureTraceStep(path, 'capture.device-reuse')
      }
      if (!this.device) {
        captureTraceSummary(path, 'no-device')
        this.#capturePath = null
        trace('[Camera] capture: no device\n')
        return undefined
      }

      path.drainedAtStart = this.drainDeviceFrames(this.device)
      captureTraceStep(path, 'capture.drain', `drained=${path.drainedAtStart}`)
      this.attachReadableListener()
      captureTraceStep(path, 'capture.attachReadable')

      return await new Promise((resolve) => {
        let settled = false
        let warmupsLeft = path.warmupBudget
        let darkRetriesLeft = path.darkRetryBudget
        const finish = (frame: CameraFrame | undefined, outcome: string) => {
          if (settled) return
          settled = true
          this.pending = null
          this.#captureFinish = null
          this.clearCaptureTimer()
          captureTraceStep(path, `capture.finish.${outcome}`)
          captureTraceSummary(path, outcome)
          photoPathStep('camera.capture.native-finish', `outcome=${outcome}`)
          this.#capturePath = null
          // Stop accepting onReadable only — device.stop() invalidates disposable buffers before JS copy.
          this.detachReadableListener('still-captured')
          trace(
            `[Camera] capture: done ${frame ? `${frame.width}x${frame.height}` : 'no frame'} (copy pixels before teardown)\n`,
          )
          photoPathStep('camera.capture.native-resolve', `outcome=${outcome}`)
          logPhotoCycleCamera(
            'exit camera.capture',
            frame ? `outcome=${outcome} ${frame.width}x${frame.height}` : `outcome=${outcome}`,
          )
          resolve(frame)
        }
        this.#captureFinish = (frame) => finish(frame, frame ? 'accepted' : 'empty')

        this.pending = (frame) => {
          const frameAt = Date.now()
          if (path.deviceStartMs != null) {
            const deltaMs = path.lastReadableMs != null ? frameAt - path.lastReadableMs : frameAt - path.deviceStartMs
            if (path.firstReadableMs == null) {
              path.firstReadableMs = frameAt
              captureTraceStep(path, 'capture.firstReadable', `afterDeviceStart=${frameAt - path.deviceStartMs}ms`)
            }
            path.lastReadableMs = frameAt
            path.framesReceived += 1
            trace(`[CameraCap] frame#${path.framesReceived} delta=+${deltaMs}ms total=+${frameAt - path.t0}ms\n`)
          }

          if (!frame) {
            path.emptyReadable += 1
            trace(`[CameraCap] discard emptyReadable count=${path.emptyReadable} (wait next frame)\n`)
            trace('[Camera] capture: readable without buffer, wait for next frame\n')
            return false
          }

          if (warmupsLeft > 0) {
            warmupsLeft -= 1
            path.warmupDiscarded += 1
            try {
              frame.close?.()
            } catch (error) {
              traceCameraError('warmup frame close failed', error)
            }
            trace(
              `[CameraCap] discard warmup count=${path.warmupDiscarded} budgetLeft=${warmupsLeft} frame#${path.framesReceived}\n`,
            )
            trace(`[Camera] capture warmup discard (${warmupsLeft} left)\n`)
            return false
          }

          const luma = sampleRgb565LeMeanLumaSafe(frame)
          if (luma >= 0 && luma < CAPTURE_AEC_RETRY_MIN_LUMA && darkRetriesLeft > 0) {
            darkRetriesLeft -= 1
            path.darkRetryDiscarded += 1
            try {
              frame.close?.()
            } catch (error) {
              traceCameraError('AEC retry frame close failed', error)
            }
            trace(
              `[CameraCap] discard darkRetry/AEC count=${path.darkRetryDiscarded} meanLuma=${luma} minLuma=${CAPTURE_AEC_RETRY_MIN_LUMA} budgetLeft=${darkRetriesLeft} frame#${path.framesReceived}\n`,
            )
            trace(`[Camera] capture AEC retry (meanLuma=${luma}, ${darkRetriesLeft} left)\n`)
            return false
          }

          path.acceptedLuma = luma
          trace(
            `[CameraCap] accept frame#${path.framesReceived} meanLuma=${luma >= 0 ? luma : 'deferred'} warmupDiscarded=${path.warmupDiscarded} darkRetryDiscarded=${path.darkRetryDiscarded}\n`,
          )
          trace(`[Camera] capture frame ${luma >= 0 ? `meanLuma=${luma}` : 'meanLuma=deferred (host buffer)'}\n`)
          cameraSuccessfulCaptures += 1
          finish(frame, 'accepted')
          return true
        }

        this.captureTimer = Timer.set(() => {
          path.timedOut = true
          trace(
            `[CameraCap] TIMEOUT after ${path.timeoutMs}ms frames=${path.framesReceived} warmupDiscarded=${path.warmupDiscarded} darkRetryDiscarded=${path.darkRetryDiscarded}\n`,
          )
          trace(
            `[PhotoSession] capture-TIMEOUT ${path.timeoutMs}ms frames=${path.framesReceived} priorCaptures=${path.priorCaptures} (center ????? unlikely — no overlay)\n`,
          )
          trace('[Camera] capture timed out\n')
          finish(undefined, 'timeout')
        }, path.timeoutMs)
        captureTraceStep(path, 'capture.timer-armed', `timeoutMs=${path.timeoutMs}`)

        trace('[Camera] capture: BEFORE device.start()\n')
        path.deviceStartMs = Date.now()
        this.device.start()
        captureTraceStep(path, 'capture.device.start()')
        trace('[Camera] stream started — waiting onReadable only (no sync read)\n')
      })
    } catch (error) {
      captureTraceStep(path, 'capture.error')
      captureTraceSummary(path, 'error')
      this.#capturePath = null
      traceCameraError('capture failed', error)
      logPhotoCycleCamera('exit camera.capture', 'error')
      await this.teardownAfterCapture()
      return undefined
    }
  }
}

class NullRobotCamera implements RobotCamera {
  start(_options?: CameraCaptureOptions): void {
    void _options
  }

  stop(): void {}

  async teardownAfterCapture(): Promise<void> {}

  release(): void {}

  async capture(_options?: CameraCaptureOptions): Promise<CameraFrame | undefined> {
    void _options
    return undefined
  }
}

export default class Camera implements RobotCamera {
  impl: RobotCamera

  constructor(_options?: unknown) {
    void _options
    this.impl = isCameraAvailable() ? new Esp32RobotCamera() : new NullRobotCamera()
    if (!isCameraAvailable()) {
      trace('[Camera] embedded camera module unavailable\n')
    }
  }

  async start(options?: CameraCaptureOptions) {
    logPhotoCycleCamera('enter camera.start (wrapper)')
    try {
      await this.impl.start(options)
      logPhotoCycleCamera('exit camera.start (wrapper)')
    } catch (error) {
      traceCameraError('start failed', error)
      logPhotoCycleCamera('exit camera.start (wrapper)', 'error')
    }
  }

  async stop() {
    try {
      await this.impl.stop()
    } catch (error) {
      traceCameraError('stop failed', error)
    }
  }

  async teardownAfterCapture() {
    try {
      await this.impl.teardownAfterCapture()
    } catch (error) {
      traceCameraError('teardown failed', error)
    }
  }

  release() {
    try {
      this.impl.release()
    } catch (error) {
      traceCameraError('release failed', error)
    }
  }

  async capture(options?: CameraCaptureOptions) {
    logPhotoCycleCamera('enter camera.capture (wrapper)')
    try {
      const frame = await this.impl.capture(options)
      logPhotoCycleCamera('exit camera.capture (wrapper)', frame ? `${frame.width}x${frame.height}` : 'no-frame')
      return frame
    } catch (error) {
      traceCameraError('capture failed', error)
      logPhotoCycleCamera('exit camera.capture (wrapper)', 'error')
      try {
        await this.impl.teardownAfterCapture()
      } catch (teardownError) {
        traceCameraError('teardown after capture failed', teardownError)
      }
      return undefined
    }
  }
}
