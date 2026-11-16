// @ts-nocheck
import AudioIn from 'embedded:io/audio/in'

const WAV_HEADER_SIZE = 44
const MAX_READ_CHUNK = 512
const MIN_PTT_MS = 300

export type PushToTalkSampleFormat = {
  sampleRate: number
  channels: number
  bitsPerSample: number
}

export type PushToTalkRecording = PushToTalkSampleFormat & {
  pcm: Uint8Array
}

export default class Microphone {
  recording: boolean
  #audioIn: AudioIn | null
  #pttPcm: Uint8Array | null = null
  #pttWriteOffset = 0
  #pttFormat: PushToTalkSampleFormat | null = null
  #pttStreamHandler: ((chunk: ArrayBuffer) => void) | null = null
  #pttMaxBytes = 0
  #pttTarget: Uint8Array | null = null
  onReadable?: (this: AudioIn, byteLength: number, sampleCount?: number) => void

  constructor() {
    this.recording = false
    this.#audioIn = null
  }

  start() {
    if (this.recording) {
      throw new Error('already recording')
    }
    const self = this
    this.#audioIn = new AudioIn({
      onReadable(size, sampleCount) {
        if (self.onReadable) {
          self.onReadable.call(this, size, sampleCount)
        }
      },
    })
    this.#audioIn.start()
    this.recording = true
  }

  stop() {
    this.#audioIn?.close()
    this.#audioIn = null
    this.recording = false
  }

  beginPushToTalkInto(target: Uint8Array): PushToTalkSampleFormat {
    if (this.recording) {
      throw new Error('already recording')
    }
    if (target.byteLength === 0) {
      throw new Error('target buffer is empty')
    }
    this.recording = true
    this.#pttWriteOffset = 0
    this.#pttFormat = null
    this.#pttPcm = null
    this.#pttTarget = target

    const self = this
    const audioin = new AudioIn({
      onReadable(size) {
        const pcm = self.#pttTarget
        if (!pcm) return
        const remaining = pcm.byteLength - self.#pttWriteOffset
        const chunkSize = Math.min(size, remaining, MAX_READ_CHUNK)
        const chunk = this.read(chunkSize)
        if (!chunk) return
        pcm.set(new Uint8Array(chunk), self.#pttWriteOffset)
        self.#pttWriteOffset += chunkSize
        if (self.#pttWriteOffset >= pcm.byteLength) {
          self.#finishPushToTalkCapture()
        }
      },
    })

    const format = {
      sampleRate: audioin.sampleRate,
      channels: audioin.channels,
      bitsPerSample: audioin.bitsPerSample,
    }
    this.#pttFormat = format
    this.#audioIn = audioin
    audioin.start()
    return format
  }

  endPushToTalkInto(): { format: PushToTalkSampleFormat; pcmBytes: number } | null {
    this.#finishPushToTalkCapture()
    const format = this.#pttFormat
    const pcmBytes = this.#pttWriteOffset
    this.#pttTarget = null
    this.#pttFormat = null
    this.#pttWriteOffset = 0
    this.recording = false

    if (!format || pcmBytes === 0) return null
    const minBytes = Math.ceil((MIN_PTT_MS / 1000) * format.sampleRate * format.channels * (format.bitsPerSample >> 3))
    if (pcmBytes < minBytes) return null

    return { format, pcmBytes }
  }

  beginPushToTalk(maxDurationMs: number): void {
    if (this.recording) {
      throw new Error('already recording')
    }
    this.recording = true
    this.#pttWriteOffset = 0
    this.#pttFormat = null

    const self = this
    const audioin = new AudioIn({
      onReadable(size) {
        const pcm = self.#pttPcm
        if (!pcm) return
        const remaining = pcm.byteLength - self.#pttWriteOffset
        const chunkSize = Math.min(size, remaining, MAX_READ_CHUNK)
        const chunk = this.read(chunkSize)
        if (!chunk) return
        pcm.set(new Uint8Array(chunk), self.#pttWriteOffset)
        self.#pttWriteOffset += chunkSize
        if (self.#pttWriteOffset >= pcm.byteLength) {
          self.#finishPushToTalkCapture()
        }
      },
    })

    const { sampleRate, channels, bitsPerSample } = audioin
    const byteRate = sampleRate * channels * (bitsPerSample >> 3)
    const maxBytes = Math.ceil((maxDurationMs / 1000) * byteRate)
    this.#pttFormat = { sampleRate, channels, bitsPerSample }
    this.#pttPcm = new Uint8Array(maxBytes)
    this.#audioIn = audioin
    audioin.start()
  }

  beginPushToTalkStream(maxDurationMs: number, onChunk: (chunk: ArrayBuffer) => void): PushToTalkSampleFormat {
    if (this.recording) {
      throw new Error('already recording')
    }
    this.recording = true
    this.#pttWriteOffset = 0
    this.#pttFormat = null
    this.#pttPcm = null
    this.#pttStreamHandler = onChunk

    const self = this
    const audioin = new AudioIn({
      onReadable(size) {
        const remaining = self.#pttMaxBytes - self.#pttWriteOffset
        if (remaining <= 0) {
          self.#finishPushToTalkCapture()
          return
        }
        const chunkSize = Math.min(size, remaining, MAX_READ_CHUNK)
        const chunk = this.read(chunkSize)
        if (!chunk) return
        self.#pttStreamHandler?.(chunk)
        self.#pttWriteOffset += chunkSize
        if (self.#pttWriteOffset >= self.#pttMaxBytes) {
          self.#finishPushToTalkCapture()
        }
      },
    })

    const { sampleRate, channels, bitsPerSample } = audioin
    const byteRate = sampleRate * channels * (bitsPerSample >> 3)
    this.#pttMaxBytes = Math.ceil((maxDurationMs / 1000) * byteRate)
    this.#pttFormat = { sampleRate, channels, bitsPerSample }
    this.#audioIn = audioin
    audioin.start()
    return this.#pttFormat
  }

  endPushToTalkStream(): boolean {
    this.#finishPushToTalkCapture()
    const format = this.#pttFormat
    const bytes = this.#pttWriteOffset
    this.#pttFormat = null
    this.#pttStreamHandler = null
    this.#pttMaxBytes = 0
    this.#pttWriteOffset = 0
    this.recording = false
    if (!format || bytes === 0) return false
    const minBytes = Math.ceil((MIN_PTT_MS / 1000) * format.sampleRate * format.channels * (format.bitsPerSample >> 3))
    return bytes >= minBytes
  }

  endPushToTalk(): PushToTalkRecording | null {
    this.#finishPushToTalkCapture()
    const format = this.#pttFormat
    const pcm = this.#pttPcm
    this.#pttPcm = null
    this.#pttFormat = null
    this.#pttWriteOffset = 0
    this.recording = false

    if (!format || !pcm || pcm.byteLength === 0) return null

    const minBytes = Math.ceil((MIN_PTT_MS / 1000) * format.sampleRate * format.channels * (format.bitsPerSample >> 3))
    if (pcm.byteLength < minBytes) return null

    return {
      ...format,
      pcm,
    }
  }

  cancelPushToTalk(): void {
    this.#finishPushToTalkCapture()
    this.#pttPcm = null
    this.#pttTarget = null
    this.#pttFormat = null
    this.#pttStreamHandler = null
    this.#pttMaxBytes = 0
    this.#pttWriteOffset = 0
    this.recording = false
  }

  isPushToTalkActive(): boolean {
    return this.#audioIn != null
  }

  #finishPushToTalkCapture(): void {
    if (!this.#audioIn) return
    this.#audioIn.close()
    this.#audioIn = null
    if (this.#pttPcm && this.#pttWriteOffset > 0 && this.#pttWriteOffset < this.#pttPcm.byteLength) {
      this.#pttPcm = this.#pttPcm.subarray(0, this.#pttWriteOffset)
    }
  }

  async record(durationMilliSec = 2000): Promise<ArrayBuffer> {
    if (this.recording) {
      throw new Error('already recording')
    }
    this.recording = true

    return new Promise((resolve) => {
      let writeOffset = 0
      const audioin = new AudioIn({
        onReadable(size) {
          const remaining = dataView.byteLength - writeOffset
          const chunkSize = Math.min(size, remaining, MAX_READ_CHUNK)
          const chunk = this.read(chunkSize)

          if (!chunk) {
            this.close()
            self.recording = false
            resolve(wavBuffer)
          } else {
            dataView.set(new Uint8Array(chunk), writeOffset)
            writeOffset += chunkSize
            if (writeOffset >= dataView.byteLength) {
              this.close()
              self.recording = false
              resolve(wavBuffer)
            }
          }
        },
      })

      const self = this
      const { sampleRate, channels, bitsPerSample } = audioin
      const byteRate = sampleRate * channels * (bitsPerSample >> 3)
      const contentLength = (durationMilliSec / 1000) * byteRate
      const wavBuffer = new ArrayBuffer(WAV_HEADER_SIZE + contentLength)
      const headerView = new DataView(wavBuffer)
      const dataView = new Uint8Array(wavBuffer, WAV_HEADER_SIZE)

      headerView.setUint8(0, 'R'.charCodeAt(0))
      headerView.setUint8(1, 'I'.charCodeAt(0))
      headerView.setUint8(2, 'F'.charCodeAt(0))
      headerView.setUint8(3, 'F'.charCodeAt(0))
      headerView.setUint8(8, 'W'.charCodeAt(0))
      headerView.setUint8(9, 'A'.charCodeAt(0))
      headerView.setUint8(10, 'V'.charCodeAt(0))
      headerView.setUint8(11, 'E'.charCodeAt(0))
      headerView.setUint8(12, 'f'.charCodeAt(0))
      headerView.setUint8(13, 'm'.charCodeAt(0))
      headerView.setUint8(14, 't'.charCodeAt(0))
      headerView.setUint8(15, ' '.charCodeAt(0))
      headerView.setUint32(16, 16, true)
      headerView.setUint16(20, 1, true)
      headerView.setUint16(22, channels, true)
      headerView.setUint32(24, sampleRate, true)
      headerView.setUint32(28, byteRate, true)
      headerView.setUint16(32, (channels * bitsPerSample) >> 3, true)
      headerView.setUint16(34, bitsPerSample, true)
      headerView.setUint8(36, 'd'.charCodeAt(0))
      headerView.setUint8(37, 'a'.charCodeAt(0))
      headerView.setUint8(38, 't'.charCodeAt(0))
      headerView.setUint8(39, 'a'.charCodeAt(0))
      headerView.setUint32(4, 36 + contentLength, true)
      headerView.setUint32(40, contentLength, true)

      audioin.start()
    })
  }
}
