// @ts-nocheck
import type { CameraFrame } from './camera.js'
import { enableCoreS3PhotoSdPower } from './photo-sd-power.js'
import {
  encodeRgb565LeToBmp24,
  formatPhotoFilename,
  PHOTO_STORAGE_RELATIVE_DIR,
  photoStorageRelativePath,
} from './photo-save-bmp.js'

const PHOTO_DIR_LOG = '/app/StackChan/photos'

export { encodeRgb565LeToBmp24, formatPhotoFilename, photoStorageRelativePath } from './photo-save-bmp.js'

/**
 * @returns Error message from native code, or `undefined` on success.
 * Native must not use xsUnknownError — those are not catchable in JS.
 */
function writePhotoToSd(relativePath: string, buffer: ArrayBuffer): string | undefined {
  try {
    const fn = native('xs_photo_storage_write')
    // First .call() arg is xsThis — pass undefined so xsArg(0)=path, xsArg(1)=buffer.
    const result = fn.call(undefined, relativePath, buffer) as string | undefined
    if (typeof result === 'string' && result.length > 0) {
      return result
    }
    return undefined
  } catch (_e) {
    trace(`[Photo] native photo-storage not linked, skipping SD write\n`)
    return undefined
  }
}

function isNativeSdWriteMissing(message: string): boolean {
  return /not found|undefined|unbound|no function/i.test(message)
}

let photoSdMountUnavailable = false

function releasePhotoSdMountNative() {
  try {
    native('xs_photo_storage_release_mount').call(undefined)
  } catch {
    /* photo-storage not linked */
  }
}

function notePhotoSdMountFailure(message: string) {
  if (!/0x107|263|timeout|mount|open failed/i.test(message)) {
    trace(`[Photo] SD error not treated as mount failure: ${message}\n`)
    return
  }
  if (photoSdMountUnavailable) {
    return
  }
  photoSdMountUnavailable = true
  releasePhotoSdMountNative()
  trace('[Photo] SD mount failed — native bus cleanup + skip further saves this boot\n')
}

/** True after mount/write failed with timeout/mount errors this boot. */
export function isPhotoSdMountUnavailable(): boolean {
  return photoSdMountUnavailable
}

/** @internal Test hook */
export function resetPhotoSdMountStateForTest(): void {
  photoSdMountUnavailable = false
}

/**
 * Create `app/StackChan/photos` on the SD card when the native photo-storage module is linked.
 * No-op when native is missing (same pattern as {@link writePhotoToSd}).
 */
function ensurePhotoStorageDirectory(): string | undefined {
  try {
    const result = native('xs_photo_storage_ensure_directory').call(undefined, PHOTO_STORAGE_RELATIVE_DIR) as
      | string
      | undefined
    if (typeof result === 'string' && result.length > 0) {
      return result
    }
    return undefined
  } catch {
    trace('[Photo] ensure directory skipped: native photo-storage not linked\n')
    return undefined
  }
}

/**
 * Save a captured frame as 24-bit BMP under `/app/StackChan/photos` on the SD card.
 * @returns Log path on success (e.g. `/app/StackChan/photos/20260601_183501.bmp`), or `null`.
 */
export function savePhoto(frame: CameraFrame, now = new Date()): string | null {
  if (photoSdMountUnavailable) {
    trace('[Photo] save skipped: SD mount unavailable this boot (no mount retry)\n')
    return null
  }

  const filename = formatPhotoFilename(now)
  const logPath = `${PHOTO_DIR_LOG}/${filename}`
  const relativePath = photoStorageRelativePath(filename)

  try {
    enableCoreS3PhotoSdPower()
    const dirError = ensurePhotoStorageDirectory()
    if (dirError) {
      notePhotoSdMountFailure(dirError)
      trace(`[Photo] save failed ${logPath}: ${dirError}\n`)
      return null
    }
    const bmp = encodeRgb565LeToBmp24(frame.width, frame.height, frame.buffer)
    const nativeError = writePhotoToSd(relativePath, bmp)
    if (nativeError) {
      notePhotoSdMountFailure(nativeError)
      trace(`[Photo] save failed ${logPath}: ${nativeError}\n`)
      return null
    }
    trace(`[Photo] saved ${logPath}\n`)
    return logPath
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isNativeSdWriteMissing(message)) {
      trace(`[Photo] save skipped ${logPath}: SD native not linked (${message})\n`)
    } else {
      trace(`[Photo] save failed ${logPath}: ${message}\n`)
    }
    return null
  }
}
