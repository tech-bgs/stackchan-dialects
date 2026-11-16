// @ts-nocheck
/** BlitCore → Poco FB → PiuView flush → ILI9341 doSend (grep PhotoFb / PhotoFlush). */

const armPhotoFlushIliTraceNative = native('xs_stackchan_photo_flush_arm')
const getPhotoFlushIliStatsNative = native('xs_stackchan_photo_flush_get_stats')

/** Keep in sync with camera-preview PHOTO_FW_TRACE_TAG. */
const PHOTO_FW_TRACE_TAG = 'v22-photo-phase-trace'

let photoFbTraceCount = 0
const PHOTO_FB_TRACE_MAX = 32

let photoFlushTraceCount = 0
const PHOTO_FLUSH_TRACE_MAX = 64

/** @type {'none' | 'instance' | 'global-proxy'} */
let flushSendHookMode = 'none'
let flushSendInstalled = false
let flushSendCalls = 0
let flushSendBytes = 0
let flushSendLastCount = 0
/** @type {((pixels: unknown, offset?: number, count?: number) => void) | null} */
let flushSendOriginal = null
/** @type {object | null} */
let flushSendProxyTarget = null

export function tracePhotoFbNote(message: string): void {
  if (photoFbTraceCount >= PHOTO_FB_TRACE_MAX) {
    return
  }
  photoFbTraceCount += 1
  trace(`[PhotoFb] ${message}\n`)
}

export function tracePhotoFlushNote(message: string): void {
  if (photoFlushTraceCount >= PHOTO_FLUSH_TRACE_MAX) {
    return
  }
  photoFlushTraceCount += 1
  trace(`[PhotoFlush] ${message}\n`)
}

export function getPhotoFlushSendStats(): { calls: number; bytes: number; lastCount: number } {
  return { calls: flushSendCalls, bytes: flushSendBytes, lastCount: flushSendLastCount }
}

/**
 * Arm native ili trace. Optional blit rect samples SPI rows inside preview (not chunk head).
 * Path: PiuView → PocoDrawingEnd(displayList→scratch) → ili9341Send_16LE(SPI).
 */
export function armPhotoFlushIliTrace(armed = true, blit?: { x: number; y: number; w: number; h: number }): void {
  try {
    if (blit) {
      armPhotoFlushIliTraceNative.call(undefined, !!armed, blit.x | 0, blit.y | 0, blit.w | 0, blit.h | 0)
    } else {
      armPhotoFlushIliTraceNative.call(undefined, !!armed)
    }
    tracePhotoFlushNote(
      `ili trace armed=${armed ? 1 : 0} blit=${blit ? `${blit.w}x${blit.h}@${blit.x},${blit.y}` : 'none'}`,
    )
  } catch (err) {
    tracePhotoFlushNote(`ili trace arm failed ${String(err)}`)
  }
}

export function getPhotoFlushIliStats(): { begin: number; send: number; bytes: number } {
  const d = getPhotoFlushIliDetail()
  return { begin: d.begin, send: d.send, bytes: d.bytes }
}

/** Last ili.begin window + SPI chunk luma (flush payload, not Poco FB). */
export function getPhotoFlushIliDetail(): {
  begin: number
  send: number
  bytes: number
  windowX: number
  windowY: number
  windowW: number
  windowH: number
  firstSendMeanLuma: number
  lastSendMeanLuma: number
  maxSendMeanLuma: number
  blitRowSendMeanLuma: number
} {
  try {
    const s = getPhotoFlushIliStatsNative.call()
    return {
      begin: s?.begin ?? 0,
      send: s?.send ?? 0,
      bytes: s?.bytes ?? 0,
      windowX: s?.x ?? 0,
      windowY: s?.y ?? 0,
      windowW: s?.width ?? 0,
      windowH: s?.height ?? 0,
      firstSendMeanLuma: s?.value ?? -1,
      lastSendMeanLuma: s?.delta ?? -1,
      maxSendMeanLuma: s?.max ?? -1,
      blitRowSendMeanLuma: s?.min ?? -1,
    }
  } catch (_) {
    return {
      begin: 0,
      send: 0,
      bytes: 0,
      windowX: 0,
      windowY: 0,
      windowW: 0,
      windowH: 0,
      firstSendMeanLuma: -1,
      lastSendMeanLuma: -1,
      maxSendMeanLuma: -1,
      blitRowSendMeanLuma: -1,
    }
  }
}

let photoPostFlushTraceCount = 0
const PHOTO_POST_FLUSH_TRACE_MAX = 48
let photoPostFlushBaselineSend = 0

export function resetPhotoPostFlushBaseline(): void {
  photoPostFlushBaselineSend = getPhotoFlushIliDetail().send
}

/**
 * After ili.doSend: overwrite / window / black SPI / layer stack (grep PhotoPostFlush).
 */
export function tracePhotoPostFlush(
  phase: string,
  blit?: { x: number; y: number; w: number; h: number },
  extra?: { pocoMeanLuma?: number; onDraw?: number; repaints?: number; afterOnDraw1?: number },
): void {
  if (photoPostFlushTraceCount >= PHOTO_POST_FLUSH_TRACE_MAX) {
    return
  }
  photoPostFlushTraceCount += 1
  const ili = getPhotoFlushIliDetail()
  const extraSend = ili.send - photoPostFlushBaselineSend
  const blitPart = blit ? ` blit=${blit.w}x${blit.h}@${blit.x},${blit.y}` : ''
  const winPart = ` iliWindow=${ili.windowW}x${ili.windowH}@${ili.windowX},${ili.windowY}`
  const lumaPart = ` flushHead first=${ili.firstSendMeanLuma} last=${ili.lastSendMeanLuma} max=${ili.maxSendMeanLuma} blitRow=${ili.blitRowSendMeanLuma}`
  const pocoPart = extra?.pocoMeanLuma !== undefined ? ` pocoMean=${extra.pocoMeanLuma}(pre-PocoDrawingEnd)` : ''
  const repaintPart =
    extra?.repaints !== undefined
      ? ` repaints=${extra.repaints} afterOnDraw1=${extra.afterOnDraw1 ?? 0} onDraw=${extra.onDraw ?? 0}`
      : ''
  const hint =
    ili.blitRowSendMeanLuma >= 40
      ? 'HINT=spi-has-image-at-blit-row'
      : ili.blitRowSendMeanLuma >= 0 && ili.blitRowSendMeanLuma < 8
        ? 'HINT=black-spi-at-blit-row'
        : ili.firstSendMeanLuma >= 0 && ili.firstSendMeanLuma < 8 && ili.maxSendMeanLuma >= 40
          ? 'HINT=margin-rows-black-chunkHead-misleading'
          : ili.maxSendMeanLuma >= 0 && ili.maxSendMeanLuma < 8
            ? 'HINT=black-flush-all-rows'
            : extraSend > 0 && (extra?.onDraw ?? 0) <= 1
              ? 'HINT=extra-ili-after-onDraw1'
              : ili.windowW === 320 && ili.windowH === 240 && blit && (blit.w < 320 || blit.h < 240)
                ? 'HINT=full-window-partial-blit'
                : 'ok'
  trace(
    `[PhotoPostFlush] ${phase}${blitPart}${winPart} ili.begin=${ili.begin} ili.send=${ili.send}(+${extraSend}) bytes=${ili.bytes}${lumaPart}${pocoPart}${repaintPart} ${hint}\n`,
  )
}

export function getPhotoFlushHookMode(): string {
  return flushSendHookMode
}

export function resetPhotoFlushSendStats(): void {
  flushSendCalls = 0
  flushSendBytes = 0
  flushSendLastCount = 0
}

function recordFlushSend(pixels: unknown, offset: number | undefined, count: number | undefined) {
  flushSendCalls += 1
  const byteCount = count ?? 0
  flushSendLastCount = byteCount
  flushSendBytes += byteCount
  if (photoFlushTraceCount < PHOTO_FLUSH_TRACE_MAX) {
    tracePhotoFlushNote(
      `screen.send#${flushSendCalls} offset=${offset ?? 0} count=${byteCount} totalBytes=${flushSendBytes}`,
    )
  }
  return flushSendOriginal(pixels, offset, count)
}

function buildSendWrapper() {
  return (pixels: unknown, offset?: number, count?: number) => recordFlushSend(pixels, offset, count)
}

function tryReplaceSendOnObject(obj: object): boolean {
  if (!obj || typeof (obj as { send?: unknown }).send !== 'function') {
    return false
  }
  const target = obj as { send: (pixels: unknown, offset?: number, count?: number) => void }
  flushSendOriginal = target.send.bind(target)
  const wrapper = buildSendWrapper()

  try {
    target.send = wrapper
    if (target.send === wrapper) {
      return true
    }
  } catch (_) {
    /* screen.send often non-writable on device */
  }

  try {
    Object.defineProperty(obj, 'send', {
      value: wrapper,
      writable: true,
      configurable: true,
    })
    return true
  } catch (_) {
    /* frozen host object */
  }

  return false
}

function tryInstallGlobalScreenProxy(screen: object): boolean {
  try {
    flushSendOriginal = screen.send.bind(screen)
    flushSendProxyTarget = screen
    globalThis.screen = new Proxy(screen, {
      get(target, prop, receiver) {
        if (prop === 'send') {
          return buildSendWrapper()
        }
        const value = Reflect.get(target, prop, receiver)
        if (typeof value === 'function') {
          return value.bind(target)
        }
        return value
      },
    })
    return true
  } catch (_) {
    flushSendProxyTarget = null
    return false
  }
}

/**
 * Hook screen.send for [PhotoFlush] (PiuView → ILI9341).
 * Never throws — preview must not fail if send is non-writable.
 * Call as early as possible (main init); PiuView caches send at Application create.
 */
export function installPhotoFlushSendTrace(): void {
  if (flushSendInstalled) {
    return
  }

  const screen = globalThis.screen
  if (!screen || typeof screen.send !== 'function') {
    flushSendInstalled = true
    flushSendHookMode = 'none'
    tracePhotoFlushNote('install SKIP (no global screen.send)')
    return
  }

  if (tryReplaceSendOnObject(screen)) {
    flushSendInstalled = true
    flushSendHookMode = 'instance'
    tracePhotoFlushNote(
      `install OK instance.send ${screen.width}x${screen.height} fmt=${screen.pixelFormat} fw=${PHOTO_FW_TRACE_TAG}`,
    )
    return
  }

  if (tryInstallGlobalScreenProxy(screen)) {
    flushSendInstalled = true
    flushSendHookMode = 'global-proxy'
    tracePhotoFlushNote(
      `install PARTIAL Proxy global.screen (PiuView may use send ref from boot) ${screen.width}x${screen.height} fw=${PHOTO_FW_TRACE_TAG}`,
    )
    return
  }

  flushSendInstalled = true
  flushSendHookMode = 'none'
  tracePhotoFlushNote(
    `install FALLBACK no JS send hook — CoreS3 uses ili.doSend; grep [PhotoFlush] ili.* after armPhotoFlushIliTrace fw=${PHOTO_FW_TRACE_TAG}`,
  )
}

export function uninstallPhotoFlushSendTrace(): void {
  if (!flushSendInstalled) {
    return
  }

  const screen = globalThis.screen

  if (flushSendHookMode === 'global-proxy' && flushSendProxyTarget) {
    globalThis.screen = flushSendProxyTarget
    flushSendProxyTarget = null
  } else if (flushSendHookMode === 'instance' && screen && flushSendOriginal) {
    try {
      screen.send = flushSendOriginal
    } catch (_) {
      try {
        Object.defineProperty(screen, 'send', {
          value: flushSendOriginal,
          writable: true,
          configurable: true,
        })
      } catch (_2) {
        /* leave wrapper in place */
      }
    }
  }

  flushSendOriginal = null
  flushSendInstalled = false
  const mode = flushSendHookMode
  flushSendHookMode = 'none'
  tracePhotoFlushNote(`uninstall mode=${mode} calls=${flushSendCalls} bytes=${flushSendBytes}`)
}
