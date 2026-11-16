// @ts-nocheck
/** Trace who repaints / fills the LCD while photo preview is on screen (overlay onDraw ok but LCD black). */

/** Keep in sync with camera-preview PHOTO_FW_TRACE_TAG. */
const PHOTO_FW_TRACE_TAG = 'v13-dismiss-source'

let lcdTraceActive = false
let lcdRepaintSeq = 0
let lcdBlackFillSeq = 0
let lcdOnDrawSeq = 0
let lcdUnexpectedFaceUpdate = 0

export function setPhotoLcdOverwriteTrace(active: boolean): void {
  lcdTraceActive = active
  if (!active) {
    lcdRepaintSeq = 0
    lcdBlackFillSeq = 0
    lcdOnDrawSeq = 0
    lcdUnexpectedFaceUpdate = 0
  }
}

export function isPhotoLcdOverwriteTraceActive(): boolean {
  return lcdTraceActive
}

export function noteLcdRepaint(source: string, detail = ''): void {
  if (!lcdTraceActive) return
  lcdRepaintSeq += 1
  const extra = detail ? ` ${detail}` : ''
  trace(`[PhotoLcd] repaint#${lcdRepaintSeq} ${source}${extra} fw=${PHOTO_FW_TRACE_TAG}\n`)
}

export function noteLcdBlackFill(source: string, detail = ''): void {
  if (!lcdTraceActive) return
  lcdBlackFillSeq += 1
  const extra = detail ? ` ${detail}` : ''
  trace(`[PhotoLcd] blackFill#${lcdBlackFillSeq} ${source}${extra} fw=${PHOTO_FW_TRACE_TAG}\n`)
}

export function noteLcdPhotoPortOnDraw(phase: string, detail = ''): void {
  if (!lcdTraceActive) return
  if (phase === 'enter') lcdOnDrawSeq += 1
  const n = lcdOnDrawSeq
  const extra = detail ? ` ${detail}` : ''
  trace(`[PhotoLcd] photoPortOnDraw#${n} ${phase}${extra} fw=${PHOTO_FW_TRACE_TAG}\n`)
}

export function noteLcdUnexpectedFaceUpdate(source: string): void {
  if (!lcdTraceActive) return
  lcdUnexpectedFaceUpdate += 1
  trace(`[PhotoLcd] UNEXPECTED faceUpdate#${lcdUnexpectedFaceUpdate} ${source} fw=${PHOTO_FW_TRACE_TAG}\n`)
}

export function traceLcdCompositorSnapshot(phase: string, detail: string): void {
  if (!lcdTraceActive) return
  trace(
    `[PhotoLcd] compositor ${phase}: ${detail} repaints=${lcdRepaintSeq} blackFills=${lcdBlackFillSeq} onDraws=${lcdOnDrawSeq} fw=${PHOTO_FW_TRACE_TAG}\n`,
  )
}

export function getPhotoLcdOverwriteStats(): {
  repaints: number
  blackFills: number
  onDraws: number
  unexpectedFaceUpdates: number
} {
  return {
    repaints: lcdRepaintSeq,
    blackFills: lcdBlackFillSeq,
    onDraws: lcdOnDrawSeq,
    unexpectedFaceUpdates: lcdUnexpectedFaceUpdate,
  }
}
