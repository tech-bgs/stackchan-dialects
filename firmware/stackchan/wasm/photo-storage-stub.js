/*
 * ESP32 targets without CoreS3 microSD — save is skipped, no throw.
 */

export function isPhotoStorageAvailable() {
  return false
}

export function ensurePhotoStorageMounted() {
  return false
}

export function writePhotoStorageFile() {
  throw new Error('photo storage not available on this platform')
}
