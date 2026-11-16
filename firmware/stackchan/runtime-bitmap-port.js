import { Port } from 'piu/MC'
import {
  notePhotoPortBitmapBind,
  notePhotoPortBitmapClear,
  tracePhotoNativeNote,
} from 'photo-graphics-diagnostics'

const drawNative = native('xs_stackchan_runtime_bitmap_port_draw')
const scaleRgb565Le2xNative = native('xs_stackchan_scale_rgb565_le_2x')
const samplePocoFbNative = native('xs_stackchan_runtime_bitmap_port_sample_poco_fb')

/** Read Poco view framebuffer mean luma in blit rect (post-invalidate probe). Returns -1 if unavailable. */
export function sampleRuntimeBitmapPortPocoFb(port, x, y, sw, sh) {
  return samplePocoFbNative.call(port, x | 0, y | 0, sw | 0, sh | 0)
}

export default class RuntimeBitmapPort extends Port {
  drawBitmap(bitmap, x, y, sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height) {
    tracePhotoNativeNote('ENTER drawBitmap')
    notePhotoPortBitmapBind()
    this._runtimeBitmap = bitmap
    this._runtimeBitmapSX = sx
    this._runtimeBitmapSY = sy
    this._runtimeBitmapSW = sw
    this._runtimeBitmapSH = sh
    const drew = drawNative.call(this, x, y, sx, sy, sw, sh)
    tracePhotoNativeNote(`EXIT drawBitmap drew=${drew ? 1 : 0}`)
    return drew
  }

  clearRuntimeBitmapBinding() {
    notePhotoPortBitmapClear()
    this._runtimeBitmap = undefined
    this._runtimeBitmapSX = 0
    this._runtimeBitmapSY = 0
    this._runtimeBitmapSW = 0
    this._runtimeBitmapSH = 0
  }
}

/** @param {ArrayBuffer | ArrayBufferView | { byteLength?: number }} buffer */
function asArrayBuffer(buffer) {
  if (buffer instanceof ArrayBuffer) {
    return buffer
  }
  if (ArrayBuffer.isView(buffer)) {
    const view = buffer
    const parent = view.buffer
    if (!(parent instanceof ArrayBuffer)) {
      throw new TypeError('invalid buffer')
    }
    const byteOffset = view.byteOffset | 0
    const byteLength = view.byteLength | 0
    if (byteOffset === 0 && byteLength === parent.byteLength) {
      return parent
    }
    return parent.slice(byteOffset, byteOffset + byteLength)
  }
  const byteLength = buffer?.byteLength | 0
  if (byteLength <= 0) {
    throw new TypeError('invalid buffer')
  }
  const copy = new ArrayBuffer(byteLength)
  const src = new Uint8Array(buffer)
  const dst = new Uint8Array(copy)
  for (let i = 0; i < byteLength; i++) {
    dst[i] = src[i]
  }
  return copy
}

/** Native 2× nearest-neighbor upscale (e.g. 160×120 → 320×240). */
export function scaleRgb565Le2x(buffer, sourceWidth, sourceHeight) {
  return scaleRgb565Le2xNative.call(asArrayBuffer(buffer), sourceWidth, sourceHeight)
}
