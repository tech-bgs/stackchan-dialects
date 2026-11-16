// @ts-nocheck
/** Heap + Moddable timer instrumentation for photo preview memory diagnosis. */

let timersInstrumentationKey: number | undefined

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

export function getActiveTimerCount(): number | undefined {
  const key = timersInstrumentationKey ?? instrumentationMap('Timers')
  if (timersInstrumentationKey === undefined && key !== undefined) {
    timersInstrumentationKey = key
  }
  if (key == null) {
    return undefined
  }
  return instrumentationGet(key)
}

export function traceActiveTimers(phase: string): void {
  const count = getActiveTimerCount()
  trace(`[PhotoDiag] timers ${phase}: active=${count ?? '?'}\n`)
}

export function getXsChunkHeapUsed(): number | undefined {
  const chunkKey = instrumentationMap('XS Chunk Heap Used')
  return chunkKey != null ? instrumentationGet(chunkKey) : undefined
}

export function getXsSlotHeapUsed(): number | undefined {
  const slotKey = instrumentationMap('XS Slot Heap Used')
  return slotKey != null ? instrumentationGet(slotKey) : undefined
}

export type PhotoHeapMetrics = {
  slot: number | undefined
  chunk: number | undefined
  sysFree: number | undefined
}

export function getPhotoHeapMetrics(): PhotoHeapMetrics {
  const slotKey = instrumentationMap('XS Slot Heap Used')
  const chunkKey = instrumentationMap('XS Chunk Heap Used')
  const sysFreeKey = instrumentationMap('System Free Memory')
  return {
    slot: slotKey != null ? instrumentationGet(slotKey) : undefined,
    chunk: chunkKey != null ? instrumentationGet(chunkKey) : undefined,
    sysFree: sysFreeKey != null ? instrumentationGet(sysFreeKey) : undefined,
  }
}

let photoHeapCaptureBaseline: PhotoHeapMetrics | undefined

function formatHeapDelta(current: PhotoHeapMetrics, baseline: PhotoHeapMetrics | undefined): string {
  if (!baseline) {
    return 'dSlot=? dChunk=? dSysFree=?'
  }
  const dSlot = current.slot != null && baseline.slot != null ? String(current.slot - baseline.slot) : '?'
  const dChunk = current.chunk != null && baseline.chunk != null ? String(current.chunk - baseline.chunk) : '?'
  const dSysFree =
    current.sysFree != null && baseline.sysFree != null ? String(current.sysFree - baseline.sysFree) : '?'
  return `dSlot=${dSlot} dChunk=${dChunk} dSysFree=${dSysFree}`
}

/** Reset at take requested — grep: PhotoHeap baseline */
export function resetPhotoHeapCaptureBaseline(phase: string): void {
  photoHeapCaptureBaseline = getPhotoHeapMetrics()
  const m = photoHeapCaptureBaseline
  trace(`[PhotoHeap] baseline ${phase} slot=${m.slot ?? '?'} chunk=${m.chunk ?? '?'} sysFree=${m.sysFree ?? '?'}\n`)
}

/** Heap + delta from capture baseline — grep: PhotoHeap */
export function tracePhotoHeapCapture(phase: string, detail = ''): PhotoHeapMetrics {
  const m = getPhotoHeapMetrics()
  const delta = formatHeapDelta(m, photoHeapCaptureBaseline)
  const extra = detail ? ` ${detail}` : ''
  trace(
    `[PhotoHeap] ${phase} slot=${m.slot ?? '?'} chunk=${m.chunk ?? '?'} sysFree=${m.sysFree ?? '?'} ${delta}${extra}\n`,
  )
  return m
}

let photoLatencyCaptureCompleteMs: number | undefined
let photoLatencyShowCapturedMs: number | undefined

export function notePhotoCaptureCompleteMilestone(): void {
  photoLatencyCaptureCompleteMs = getPhotoCaptureTimelineElapsedMs()
}

export function notePhotoShowCapturedMilestone(): void {
  photoLatencyShowCapturedMs = getPhotoCaptureTimelineElapsedMs()
}

/** Grep: PhotoLatency — compare capture.complete vs LCD onDraw/flush */
export function tracePhotoLatencyMilestone(label: string, detail = ''): void {
  const photoTimeMs = getPhotoCaptureTimelineElapsedMs()
  const sinceCaptureComplete = photoLatencyCaptureCompleteMs != null ? photoTimeMs - photoLatencyCaptureCompleteMs : -1
  const sinceShowCaptured = photoLatencyShowCapturedMs != null ? photoTimeMs - photoLatencyShowCapturedMs : -1
  const extra = detail ? ` ${detail}` : ''
  trace(
    `[PhotoLatency] ${label} photoTime=+${photoTimeMs}ms sinceCaptureComplete=+${sinceCaptureComplete}ms sinceShowCaptured=+${sinceShowCaptured}ms${extra}\n`,
  )
}

export function tracePhotoSessionHeap(phase: string): void {
  const slotKey = instrumentationMap('XS Slot Heap Used')
  const chunkKey = instrumentationMap('XS Chunk Heap Used')
  const sysFreeKey = instrumentationMap('System Free Memory')
  const slot = slotKey != null ? instrumentationGet(slotKey) : undefined
  const chunk = chunkKey != null ? instrumentationGet(chunkKey) : undefined
  const sysFree = sysFreeKey != null ? instrumentationGet(sysFreeKey) : undefined
  trace(`[PhotoDiag] heap ${phase}: slot=${slot ?? '?'} chunk=${chunk ?? '?'} sysFree=${sysFree ?? '?'}\n`)
}

/** Heap + active timer count (Instrumentation "Timers"). */
export function tracePhotoSessionDiag(phase: string): void {
  tracePhotoSessionHeap(phase)
  traceActiveTimers(phase)
}

let photoCaptureTimelineOriginMs: number | undefined

/** Reset at drawer Camera press — grep: PhotoTime */
export function resetPhotoCaptureTimeline(originMs?: number): void {
  photoCaptureTimelineOriginMs = originMs ?? Date.now()
  photoLatencyCaptureCompleteMs = undefined
  photoLatencyShowCapturedMs = undefined
  photoHeapCaptureBaseline = undefined
}

export function tracePhotoTimeline(phase: string): void {
  const now = Date.now()
  if (photoCaptureTimelineOriginMs == null) {
    photoCaptureTimelineOriginMs = now
  }
  const elapsed = now - photoCaptureTimelineOriginMs
  trace(`[PhotoTime] ${phase} +${elapsed}ms t=${now}\n`)
}

export function getPhotoCaptureTimelineOriginMs(): number | undefined {
  return photoCaptureTimelineOriginMs
}

export function getPhotoCaptureTimelineElapsedMs(now = Date.now()): number {
  const origin = photoCaptureTimelineOriginMs
  return origin == null ? 0 : now - origin
}

let photoPathOriginMs = 0
let photoPathLastMs = 0
let photoPathSeq = 0
const PHOTO_PATH_SLOW_STEP_MS = 500
const PHOTO_PATH_GAP_MS = 2000
const PHOTO_PATH_TOP_STEPS = 8
type PhotoPathSlowEntry = { seq: number; label: string; stepMs: number }
let photoPathSlowSteps: PhotoPathSlowEntry[] = []

function recordPhotoPathSlowStep(seq: number, label: string, stepMs: number): void {
  if (stepMs < PHOTO_PATH_SLOW_STEP_MS) {
    return
  }
  photoPathSlowSteps.push({ seq, label, stepMs })
  if (photoPathSlowSteps.length > 32) {
    photoPathSlowSteps.shift()
  }
}

/** Reset step clock once at capturePhoto() enter — do not reset mid-flight. */
export function photoPathReset(label: string): void {
  photoPathSeq = 0
  photoPathSlowSteps = []
  const now = Date.now()
  photoPathOriginMs = now
  photoPathLastMs = now
  photoPathStep(`${label}.enter`, '(path-reset)')
}

/** Step ms since previous photoPathStep; photoTime aligns with [PhotoTime] origin. */
export function photoPathStep(label: string, detail = ''): void {
  photoPathSeq += 1
  const now = Date.now()
  if (photoPathLastMs === 0) {
    photoPathOriginMs = now
    photoPathLastMs = now
  }
  const stepMs = now - photoPathLastMs
  photoPathLastMs = now
  const pathTotalMs = now - photoPathOriginMs
  const photoTimeMs = getPhotoCaptureTimelineElapsedMs(now)
  const detailPart = detail ? ` ${detail}` : ''
  trace(
    `[PhotoPath] #${photoPathSeq} ${label} step=+${stepMs}ms pathTotal=+${pathTotalMs}ms photoTime=+${photoTimeMs}ms${detailPart}\n`,
  )
  recordPhotoPathSlowStep(photoPathSeq, label, stepMs)
  if (stepMs >= PHOTO_PATH_SLOW_STEP_MS && stepMs < PHOTO_PATH_GAP_MS) {
    trace(`[PhotoPath] !STEP-SLOW! #${photoPathSeq} ${label} step=+${stepMs}ms (>=${PHOTO_PATH_SLOW_STEP_MS}ms)\n`)
  }
  if (stepMs >= PHOTO_PATH_GAP_MS) {
    trace(
      `[PhotoPath] !GAP! #${photoPathSeq} ${label} step=+${stepMs}ms (>=${PHOTO_PATH_GAP_MS}ms since previous PhotoPath step)\n`,
    )
  }
}

/** Mark async boundary — grep AWAIT-BEGIN / AWAIT-END */
export function photoPathAwaitBegin(label: string): number {
  const t0 = Date.now()
  photoPathStep(`${label} >>> AWAIT-BEGIN`, `t=${t0}`)
  return t0
}

export function photoPathAwaitEnd(label: string, t0: number, detail = ''): void {
  const now = Date.now()
  const awaitMs = now - t0
  const extra = detail ? ` ${detail}` : ''
  photoPathStep(`${label} <<< AWAIT-END`, `awaitMs=${awaitMs} t=${now}${extra}`)
  if (awaitMs >= 2000) {
    trace(`[PhotoPath] !AWAIT-SLOW! ${label} awaitMs=${awaitMs}ms\n`)
  }
}

export function photoPathClear(): void {
  photoPathOriginMs = 0
  photoPathLastMs = 0
  photoPathSeq = 0
  photoPathSlowSteps = []
}

export function photoPathSeqCount(): number {
  return photoPathSeq
}

/** Grep: !SUMMARY! — top slow steps before capture.complete (sorted by stepMs desc). */
export function photoPathEmitSummary(phase: string): void {
  const pathTotalMs = photoPathLastMs > photoPathOriginMs ? photoPathLastMs - photoPathOriginMs : 0
  const photoTimeMs = getPhotoCaptureTimelineElapsedMs()
  const sorted = photoPathSlowSteps.slice().sort((a, b) => b.stepMs - a.stepMs)
  const top = sorted.slice(0, PHOTO_PATH_TOP_STEPS)
  const topPart = top.length > 0 ? top.map((e) => `#${e.seq}:${e.label}=+${e.stepMs}ms`).join(' ') : '(none >=500ms)'
  trace(
    `[PhotoPath] !SUMMARY! ${phase} pathTotal=+${pathTotalMs}ms photoTime=+${photoTimeMs}ms slowSteps=${sorted.length} top: ${topPart}\n`,
  )
}

/** Stale-touch vs drawer correlation — grep: PhotoTouch (ms from take requested). */
export function tracePhotoTouchTimeline(phase: string, detail = ''): void {
  const now = Date.now()
  if (photoCaptureTimelineOriginMs == null) {
    photoCaptureTimelineOriginMs = now
  }
  const elapsed = now - photoCaptureTimelineOriginMs
  const extra = detail ? ` ${detail}` : ''
  trace(`[PhotoTouch] ${phase} +${elapsed}ms t=${now}${extra}\n`)
}

let photoTakeTraceFwTag = 'v22-photo-phase-trace'

/** Grep: PhotoPhase — overlay vs dismiss vs main resume (+ms from take requested). */
export function tracePhotoPhase(phase: string, detail = ''): void {
  const elapsed = getPhotoCaptureTimelineElapsedMs()
  const extra = detail ? ` ${detail}` : ''
  trace(`[PhotoPhase] +${elapsed}ms ${phase}${extra}\n`)
}

export function setPhotoTakeTraceFwTag(tag: string): void {
  photoTakeTraceFwTag = tag
}

/** Grep: PhotoTake — drawer → bubble → onRobotCreated → capturePhoto. */
export function tracePhotoTakeStep(step: 0 | 1 | 2 | 3 | 4, detail: string): void {
  trace(`[PhotoTake] step${step} ${detail} fw=${photoTakeTraceFwTag}\n`)
}

/** Grep: PhotoCycle — buffer/state snapshot at capture success/failure boundaries. */
export type PhotoCycleSnapshot = {
  captureCount: number
  readableDetached: boolean
  hostLive: number
  portLocked: boolean
  portFrame: boolean
  previewFrame: number
  pendingSave: number
}

export function tracePhotoCycle(phase: string, snap: PhotoCycleSnapshot, extra = ''): void {
  const suffix = extra ? ` ${extra}` : ''
  trace(
    `[PhotoCycle] ${phase} captureCount=${snap.captureCount} readableDetached=${snap.readableDetached ? 1 : 0} hostLive=${snap.hostLive} portLocked=${snap.portLocked ? 1 : 0} portFrame=${snap.portFrame ? 1 : 0} previewFrame=${snap.previewFrame} pendingSave=${snap.pendingSave}${suffix}\n`,
  )
}
