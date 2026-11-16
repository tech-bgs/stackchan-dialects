import type { CameraFrame } from './camera.js'
import { photoPathStep } from './photo-session-diagnostics.js'

export type MosaicBlock = {
  x: number
  y: number
  width: number
  height: number
  color: number
}

export type MosaicOptions = {
  width: number
  height: number
  blockSize: number
}

export type Rgb565LeFrameCheck = {
  ok: boolean
  reason?: string
}

const RGB565LE_BYTES_PER_PIXEL = 2

export function checkRgb565LeFrame(frame: CameraFrame | null | undefined): Rgb565LeFrameCheck {
  if (!frame) {
    return { ok: false, reason: 'no frame' }
  }
  if (frame.width <= 0 || frame.height <= 0) {
    return { ok: false, reason: `invalid size ${frame.width}x${frame.height}` }
  }
  if (frame.imageType !== 'rgb565le') {
    return { ok: false, reason: `imageType=${String(frame.imageType)} (need rgb565le)` }
  }
  const buffer = frame.buffer
  if (buffer == null) {
    return { ok: false, reason: 'buffer is null' }
  }
  const byteLength = getRgb565BufferByteLength(buffer)
  const need = frame.width * frame.height * RGB565LE_BYTES_PER_PIXEL
  if (byteLength < need) {
    return { ok: false, reason: `buffer ${byteLength}b < ${need}b for ${frame.width}x${frame.height}` }
  }
  return { ok: true }
}

/** Byte length for ArrayBuffer, TypedArray, or Moddable DisposableHostBuffer (`buffer/disposable`). */
export function getRgb565BufferByteLength(raw: unknown): number {
  if (raw == null) {
    return 0
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength | 0
  }
  if (ArrayBuffer.isView(raw)) {
    return (raw as ArrayBufferView).byteLength | 0
  }
  if (typeof raw === 'object' && 'byteLength' in raw) {
    return ((raw as { byteLength: number }).byteLength | 0) >>> 0
  }
  return 0
}

/**
 * Readable byte view for ArrayBuffer, TypedArray, or Moddable DisposableHostBuffer.
 * Always use single-arg `new Uint8Array(raw)` — never `new Uint8Array(raw, 0, len)`.
 */
export function readRgb565LeBytes(raw: unknown): Uint8Array | undefined {
  if (raw == null) {
    return undefined
  }
  try {
    return new Uint8Array(raw as ArrayBuffer)
  } catch {
    return undefined
  }
}

/** Full-buffer scan — ~2s on CoreS3 @ 153600 B. Use copyRgb565LeFrameBytesReport / tests only. */
export function rgb565BufferChecksum(view: Uint8Array, byteLength: number): number {
  const n = Math.min(byteLength | 0, view.length | 0)
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum = (sum + view[i]!) & 0xffffff
  }
  return sum
}

const RGB565_CHECKSUM_SAMPLE_STRIDE = 512

/** Sampled checksum for optional dev verify (~300 bytes vs 153600). */
export function rgb565BufferChecksumSampled(
  view: Uint8Array,
  byteLength: number,
  stride = RGB565_CHECKSUM_SAMPLE_STRIDE,
): number {
  const n = Math.min(byteLength | 0, view.length | 0)
  if (n <= 0) {
    return 0
  }
  const step = stride > 0 ? stride : RGB565_CHECKSUM_SAMPLE_STRIDE
  let sum = 0
  for (let i = 0; i < n; i += step) {
    sum = (sum + view[i]!) & 0xffffff
  }
  return sum
}

export function getRgb565LePixelBuffer(frame: CameraFrame): ArrayBuffer | undefined {
  const raw = frame.buffer
  if (raw == null) {
    return undefined
  }
  if (raw instanceof ArrayBuffer) {
    return raw
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView
    const parent = view.buffer
    if (!(parent instanceof ArrayBuffer)) {
      return undefined
    }
    const byteOffset = view.byteOffset | 0
    const byteLength = view.byteLength | 0
    if (byteOffset === 0 && byteLength === parent.byteLength) {
      return parent
    }
    return parent.slice(byteOffset, byteOffset + byteLength)
  }
  return undefined
}

/**
 * Copy RGB565 bytes into a new ArrayBuffer.
 * Moddable `buffer/disposable` host buffers are not `ArrayBuffer` — use `new Uint8Array(source)` only (no offset/length).
 * `ArrayBuffer.transfer` does not apply to host buffers; byte copy is required before `frame.close()`.
 */
export type Rgb565CopyReport = {
  byteLength: number
  copied: number
  hostByteLength: number
  srcViewLength: number
  srcChecksum: number
  destChecksum: number
  match: boolean
}

/** Full LCD RGB565 copy (320×240×2) — allocated once, kept for app lifetime (avoid per-capture realloc OOM). */
export const RGB565_PREVIEW_COPY_POOL_BYTES = 320 * 240 * 2
/** @deprecated Use RGB565_PREVIEW_COPY_POOL_BYTES */
export const RGB565_PREVIEW_COPY_POOL_QQVGA_BYTES = RGB565_PREVIEW_COPY_POOL_BYTES

/** Permanent copy target; frame.close() only drops refs, never frees this buffer. */
let rgb565PreviewCopyPool: ArrayBuffer | null = null
let rgb565PoolCopyGeneration = 0

export function getRgb565PoolCopyGeneration(): number {
  return rgb565PoolCopyGeneration
}

export function isRgb565PreviewCopyPoolHeld(): boolean {
  return rgb565PreviewCopyPool != null
}

/** Allocate the pool once during app startup (before first capture fragments the heap). */
export function initRgb565PreviewCopyPoolAtStartup(): void {
  if (rgb565PreviewCopyPool) {
    trace(`[CameraPreview] rgb565 copy pool startup: already ${rgb565PreviewCopyPool.byteLength} bytes\n`)
    return
  }
  rgb565PreviewCopyPool = new ArrayBuffer(RGB565_PREVIEW_COPY_POOL_BYTES)
  trace(`[CameraPreview] rgb565 copy pool permanent alloc ${RGB565_PREVIEW_COPY_POOL_BYTES} bytes\n`)
}

/** No-op on device — pool stays allocated between captures and after dismiss. */
export function releaseRgb565PreviewCopyPool(reason: string): void {
  trace(
    `[CameraPreview] rgb565 copy pool retain (${reason}): ${rgb565PreviewCopyPool?.byteLength ?? 0} bytes permanent\n`,
  )
}

export function releaseRgb565PreviewCopyPoolIfBuffer(_buffer: ArrayBuffer | null | undefined, reason: string): void {
  releaseRgb565PreviewCopyPool(reason)
}

export function releaseRgb565PreviewCopyPoolForNextCapture(reason: string): void {
  releaseRgb565PreviewCopyPool(reason)
}

export function acquireRgb565LeCopyBuffer(byteLength: number): ArrayBuffer {
  const need = byteLength | 0
  if (need <= 0) {
    return new ArrayBuffer(0)
  }
  if (!rgb565PreviewCopyPool) {
    initRgb565PreviewCopyPoolAtStartup()
  }
  const pool = rgb565PreviewCopyPool as ArrayBuffer
  if (pool.byteLength < need) {
    throw new RangeError(`[CameraPreview] permanent pool ${pool.byteLength}b < need ${need}b`)
  }
  trace(`[CameraPreview] rgb565 copy pool reuse ${need}/${pool.byteLength} bytes\n`)
  return pool
}

/** @internal Test hook — drop pooled preview bytes. */
export function resetRgb565PreviewCopyPoolForTest(): void {
  rgb565PreviewCopyPool = null
}

/** Owned RGB565 copy with `close()` so embedded XS can drop refs (pool buffer is reused). */
export function wrapOwnedRgb565LeFrame(
  width: number,
  height: number,
  imageType: CameraFrame['imageType'],
  buffer: ArrayBuffer,
): CameraFrame {
  let closed = false
  const frame: CameraFrame = {
    width,
    height,
    imageType,
    buffer,
    close() {
      if (closed) return
      closed = true
      // Permanent pool buffer is reused; only drop the frame reference.
      frame.buffer = null as unknown as ArrayBuffer
    },
  }
  return frame
}

export function copyRgb565LeFrameBytes(source: unknown, byteLength: number): ArrayBuffer {
  const need = byteLength | 0
  if (need <= 0) {
    return new ArrayBuffer(0)
  }
  photoPathStep('copy.readRgb565LeBytes.before', `need=${need}`)
  const src = readRgb565LeBytes(source)
  photoPathStep('copy.readRgb565LeBytes.after', `srcLen=${src?.length ?? 0}`)
  if (!src) {
    throw new RangeError('[CameraPreview] copy: source not readable')
  }
  const hostByteLength = getRgb565BufferByteLength(source)
  const copied = Math.min(need, src.length, hostByteLength > 0 ? hostByteLength : need)
  photoPathStep('copy.acquirePool.before', `copied=${copied}`)
  const copy = acquireRgb565LeCopyBuffer(need)
  photoPathStep('copy.acquirePool.after')
  const dest = new Uint8Array(copy)
  photoPathStep('copy.set.before', `copied=${copied}`)
  dest.set(src.subarray(0, copied))
  photoPathStep('copy.set.after')
  rgb565PoolCopyGeneration += 1
  if (copied !== need) {
    trace(`[CameraPreview] copy mismatch ${copied}/${need}\n`)
    throw new RangeError(`[CameraPreview] copy incomplete ${copied}/${need}`)
  }
  return copy
}

export function copyRgb565LeFrameBytesReport(source: unknown, byteLength: number): Rgb565CopyReport {
  const need = byteLength | 0
  const hostByteLength = getRgb565BufferByteLength(source)
  const src = readRgb565LeBytes(source)
  if (!src || need <= 0) {
    return {
      byteLength: need,
      copied: 0,
      hostByteLength,
      srcViewLength: src?.length ?? 0,
      srcChecksum: 0,
      destChecksum: 0,
      match: false,
    }
  }
  const copied = Math.min(need, src.length, hostByteLength > 0 ? hostByteLength : need)
  const srcChecksum = rgb565BufferChecksumSampled(src, copied)
  const scratch = new Uint8Array(copied)
  scratch.set(src.subarray(0, copied))
  const destChecksum = rgb565BufferChecksumSampled(scratch, copied)
  return {
    byteLength: need,
    copied,
    hostByteLength,
    srcViewLength: src.length,
    srcChecksum,
    destChecksum,
    match: copied === need && srcChecksum === destChecksum,
  }
}

export function rgb565LeToPiuColor(buffer: ArrayBuffer, byteOffset: number): number {
  const view = new Uint8Array(buffer)
  const pixel = view[byteOffset] | (view[byteOffset + 1] << 8)
  const red5 = (pixel >> 11) & 0x1f
  const green6 = (pixel >> 5) & 0x3f
  const blue5 = pixel & 0x1f
  const red = (red5 << 3) | (red5 >> 2)
  const green = (green6 << 2) | (green6 >> 4)
  const blue = (blue5 << 3) | (blue5 >> 2)

  return (red << 16) | (green << 8) | blue
}

export function sampleRgb565LeCenterLuma(frame: CameraFrame): number {
  if (frame.width <= 0 || frame.height <= 0) {
    return -1
  }
  const view = readRgb565LeBytes(frame.buffer)
  if (!view) {
    return -1
  }
  const sampleX = (frame.width / 2) | 0
  const sampleY = (frame.height / 2) | 0
  const byteOffset = (sampleY * frame.width + sampleX) * 2
  const pixel = view[byteOffset]! | (view[byteOffset + 1]! << 8)
  const red5 = (pixel >> 11) & 0x1f
  const green6 = (pixel >> 5) & 0x3f
  const blue5 = pixel & 0x1f
  return ((red5 + (green6 >> 1) + blue5) / 3) | 0
}

/** True when `new Uint8Array(buffer)` would copy the whole frame into the XS heap. */
export function rgb565HostBufferNeedsByteCopy(raw: unknown): boolean {
  if (raw == null) {
    return false
  }
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    return false
  }
  return getRgb565BufferByteLength(raw) > 0
}

/**
 * Mean luma without copying Moddable `buffer/disposable` host frames (153600 B × N captures OOMs).
 * @returns -1 when the buffer is a host disposable — measure after copyRgb565LeFrame instead.
 */
export function sampleRgb565LeMeanLumaSafe(frame: CameraFrame): number {
  if (rgb565HostBufferNeedsByteCopy(frame.buffer)) {
    return -1
  }
  return sampleRgb565LeMeanLuma(frame)
}

export function sampleRgb565LeMeanLuma(frame: CameraFrame): number {
  if (frame.width <= 0 || frame.height <= 0) {
    return -1
  }
  const view = readRgb565LeBytes(frame.buffer)
  if (!view) {
    return -1
  }
  const w = frame.width | 0
  const h = frame.height | 0
  let sum = 0
  for (let i = 0; i < 9; i++) {
    const x = ((w * (1 + (i % 3))) / 4) | 0
    const y = ((h * (1 + Math.floor(i / 3))) / 4) | 0
    const byteOffset = (y * w + x) * 2
    const pixel = view[byteOffset]! | (view[byteOffset + 1]! << 8)
    const red5 = (pixel >> 11) & 0x1f
    const green6 = (pixel >> 5) & 0x3f
    const blue5 = pixel & 0x1f
    sum += (red5 + (green6 >> 1) + blue5) / 3
  }
  return (sum / 9) | 0
}

function clampSampleCoordinate(value: number, maxExclusive: number): number {
  const coordinate = value | 0
  if (coordinate < 0) return 0
  if (coordinate >= maxExclusive) return maxExclusive - 1
  return coordinate
}

export function computeAspectFit(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number; left: number; top: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || maxWidth <= 0 || maxHeight <= 0) {
    return { width: maxWidth, height: maxHeight, left: 0, top: 0 }
  }

  const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight)
  const width = Math.max(1, (sourceWidth * scale) | 0)
  const height = Math.max(1, (sourceHeight * scale) | 0)
  const left = ((maxWidth - width) / 2) | 0
  const top = ((maxHeight - height) / 2) | 0
  return { width, height, left, top }
}

export function scaleRgb565LeBuffer2x(source: unknown, sourceWidth: number, sourceHeight: number): ArrayBuffer {
  const targetWidth = sourceWidth * 2
  const targetHeight = sourceHeight * 2
  const src = readRgb565LeBytes(source)
  if (!src) {
    throw new RangeError('[CameraPreview] scale2x: no readable RGB565 source')
  }
  const out = new ArrayBuffer(targetWidth * targetHeight * 2)
  const dst = new Uint8Array(out)
  const targetStride = targetWidth * 2

  for (let y = 0; y < sourceHeight; y++) {
    const srcRow = y * sourceWidth * 2
    const dstRow0 = y * 2 * targetStride
    const dstRow1 = dstRow0 + targetStride
    for (let x = 0; x < sourceWidth; x++) {
      const srcOff = srcRow + x * 2
      const lo = src[srcOff]!
      const hi = src[srcOff + 1]!
      const dstX = x * 2
      const d0 = dstRow0 + dstX * 2
      dst[d0] = lo
      dst[d0 + 1] = hi
      dst[d0 + 2] = lo
      dst[d0 + 3] = hi
      const d2 = dstRow1 + dstX * 2
      dst[d2] = lo
      dst[d2 + 1] = hi
      dst[d2 + 2] = lo
      dst[d2 + 3] = hi
    }
  }

  return out
}

export function sampleRgb565LeMosaic(frame: CameraFrame, options: MosaicOptions): MosaicBlock[] {
  if (!checkRgb565LeFrame(frame).ok) {
    return []
  }
  const pixelBuffer = getRgb565LePixelBuffer(frame)
  if (!pixelBuffer) {
    return []
  }

  const blockSize = Math.max(1, options.blockSize | 0)
  const targetWidth = Math.max(1, options.width | 0)
  const targetHeight = Math.max(1, options.height | 0)
  const blocks: MosaicBlock[] = []

  for (let y = 0; y < targetHeight; y += blockSize) {
    const height = Math.min(blockSize, targetHeight - y)
    const sampleY = clampSampleCoordinate(((y + height / 2) * frame.height) / targetHeight, frame.height)

    for (let x = 0; x < targetWidth; x += blockSize) {
      const width = Math.min(blockSize, targetWidth - x)
      const sampleX = clampSampleCoordinate(((x + width / 2) * frame.width) / targetWidth, frame.width)
      const byteOffset = (sampleY * frame.width + sampleX) * 2

      blocks.push({
        x,
        y,
        width,
        height,
        color: rgb565LeToPiuColor(pixelBuffer, byteOffset),
      })
    }
  }

  return blocks
}
