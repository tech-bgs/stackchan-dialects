// @ts-nocheck
/** JS-only firmware fingerprint (no native / I2C). Must match deploy verification logs. */
export const PHOTO_STORAGE_BUILD_TAG = 'photo-storage boot-fix native-I2C-power'

export function tracePhotoStorageBuildTag(): void {
  trace(`[SD] build ${PHOTO_STORAGE_BUILD_TAG}\n`)
}
