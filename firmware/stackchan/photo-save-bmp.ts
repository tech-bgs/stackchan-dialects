// @ts-nocheck
/** BMP filename and RGB565 → 24-bit BMP encoding (no I/O). */

/** Relative path on the SD mount (no leading slash). */
export const PHOTO_STORAGE_RELATIVE_DIR = 'app/StackChan/photos'

export function photoStorageRelativePath(filename: string): string {
  return `${PHOTO_STORAGE_RELATIVE_DIR}/${filename}`
}

export function formatPhotoFilename(now = new Date()): string {
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  return `${y}${mo}${d}_${h}${mi}${s}.bmp`
}

export function encodeRgb565LeToBmp24(width: number, height: number, rgb565Le: ArrayBuffer): ArrayBuffer {
  const rowBytes = width * 3
  const rowPadded = (rowBytes + 3) & ~3
  const pixelBytes = rowPadded * height
  const fileSize = 14 + 40 + pixelBytes
  const out = new Uint8Array(fileSize)
  const view = new DataView(out.buffer)
  let o = 0

  view.setUint8(o++, 0x42)
  view.setUint8(o++, 0x4d)
  view.setUint32(o, fileSize, true)
  o += 4
  view.setUint32(o, 0, true)
  o += 4
  view.setUint32(o, 54, true)
  o += 4

  view.setUint32(o, 40, true)
  o += 4
  view.setInt32(o, width, true)
  o += 4
  view.setInt32(o, height, true)
  o += 4
  view.setUint16(o, 1, true)
  o += 2
  view.setUint16(o, 24, true)
  o += 2
  view.setUint32(o, 0, true)
  o += 4
  view.setUint32(o, pixelBytes, true)
  o += 4
  for (let i = 0; i < 4; i++) {
    view.setInt32(o, 0, true)
    o += 4
  }

  const src = new Uint16Array(rgb565Le)
  let dst = 54
  for (let y = height - 1; y >= 0; y--) {
    const rowStart = y * width
    for (let x = 0; x < width; x++) {
      const px = src[rowStart + x] ?? 0
      const r5 = (px >> 11) & 0x1f
      const g6 = (px >> 5) & 0x3f
      const b5 = px & 0x1f
      out[dst++] = (b5 << 3) | (b5 >> 2)
      out[dst++] = (g6 << 2) | (g6 >> 4)
      out[dst++] = (r5 << 3) | (r5 >> 2)
    }
    const pad = rowPadded - rowBytes
    for (let p = 0; p < pad; p++) out[dst++] = 0
  }
  return out.buffer
}
