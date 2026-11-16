// @ts-nocheck
import { fetch } from 'fetch'
import Headers from 'headers'
import type { Maybe } from 'stackchan-util'
import type { PushToTalkSampleFormat } from 'microphone'

const WAV_HEADER_SIZE = 44
const BOUNDARY = '----StackChanWhisper'

export type WhisperUploadLayout = {
  buffer: Uint8Array
  pcmOffset: number
  headerLen: number
  footerLen: number
  maxPcmBytes: number
}

export type WhisperUploadPayload = PushToTalkSampleFormat & {
  body: ArrayBuffer
}

function writeAscii(view: Uint8Array, offset: number, text: string): number {
  for (let i = 0; i < text.length; i++) {
    view[offset + i] = text.charCodeAt(i) & 0xff
  }
  return offset + text.length
}

function writeWavHeader(view: Uint8Array, offset: number, format: PushToTalkSampleFormat, pcmBytes: number): number {
  const { sampleRate, channels, bitsPerSample } = format
  const byteRate = sampleRate * channels * (bitsPerSample >> 3)
  const headerView = new DataView(view.buffer, view.byteOffset + offset, WAV_HEADER_SIZE)

  headerView.setUint8(0, 'R'.charCodeAt(0))
  headerView.setUint8(1, 'I'.charCodeAt(0))
  headerView.setUint8(2, 'F'.charCodeAt(0))
  headerView.setUint8(3, 'F'.charCodeAt(0))
  headerView.setUint32(4, 36 + pcmBytes, true)
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
  headerView.setUint32(40, pcmBytes, true)

  return offset + WAV_HEADER_SIZE
}

function multipartHeader(model: string, language: string): string {
  return (
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="language"\r\n\r\n${language}\r\n` +
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="speak.wav"\r\n` +
    'Content-Type: audio/wav\r\n\r\n'
  )
}

const MULTIPART_FOOTER = `\r\n--${BOUNDARY}--\r\n`

export type STTProperty = {
  apiKey: string
  model?: string
  language?: string
}

export default class STT {
  apiKey: string
  model: string
  language: string
  #headerText: string
  #headerLen: number
  #footerLen: number

  constructor(props: STTProperty) {
    this.apiKey = props.apiKey
    this.model = props.model ?? 'whisper-1'
    this.language = props.language ?? 'ko'
    this.#headerText = multipartHeader(this.model, this.language)
    this.#headerLen = this.#headerText.length
    this.#footerLen = MULTIPART_FOOTER.length
  }

  createUploadLayout(maxPcmBytes: number): WhisperUploadLayout {
    const pcmOffset = this.#headerLen + WAV_HEADER_SIZE
    const buffer = new Uint8Array(pcmOffset + maxPcmBytes + this.#footerLen)
    writeAscii(buffer, 0, this.#headerText)
    return {
      buffer,
      pcmOffset,
      headerLen: this.#headerLen,
      footerLen: this.#footerLen,
      maxPcmBytes,
    }
  }

  buildUploadPayload(
    layout: WhisperUploadLayout,
    format: PushToTalkSampleFormat,
    pcmBytes: number,
  ): WhisperUploadPayload {
    const byteLength = layout.headerLen + WAV_HEADER_SIZE + pcmBytes + layout.footerLen
    const bodyView = new Uint8Array(byteLength)
    bodyView.set(layout.buffer.subarray(0, layout.headerLen), 0)
    bodyView.set(
      layout.buffer.subarray(layout.pcmOffset, layout.pcmOffset + pcmBytes),
      layout.headerLen + WAV_HEADER_SIZE,
    )
    writeWavHeader(bodyView, layout.headerLen, format, pcmBytes)
    writeAscii(bodyView, layout.headerLen + WAV_HEADER_SIZE + pcmBytes, MULTIPART_FOOTER)
    return {
      ...format,
      body: bodyView.buffer as ArrayBuffer,
    }
  }

  pcmBytesForDuration(maxDurationMs: number, format: PushToTalkSampleFormat): number {
    const byteRate = format.sampleRate * format.channels * (format.bitsPerSample >> 3)
    return Math.ceil((maxDurationMs / 1000) * byteRate)
  }

  async transcribeUpload(payload: WhisperUploadPayload): Promise<Maybe<string>> {
    try {
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: new Headers([
          ['Content-Type', `multipart/form-data; boundary=${BOUNDARY}`],
          ['Authorization', `Bearer ${this.apiKey}`],
        ]),
        body: payload.body,
      })

      if (response.status !== 200) {
        let detail = ''
        try {
          detail = await response.text()
        } catch {
          detail = response.statusText
        }
        return { success: false, reason: `request error: ${response.status} ${detail}` }
      }

      const obj = await response.json()
      return {
        success: true,
        value: obj.text,
      }
    } catch (error) {
      return { success: false, reason: `Exception occurred: ${error.message}` }
    }
  }

  async transcribe(buffer: ArrayBuffer | HostBuffer): Promise<Maybe<string>> {
    const headerView = new DataView(buffer)
    const _pcmBytes = buffer.byteLength - WAV_HEADER_SIZE
    const bodyView = new Uint8Array(this.#headerLen + buffer.byteLength + this.#footerLen)
    writeAscii(bodyView, 0, this.#headerText)
    bodyView.set(new Uint8Array(buffer), this.#headerLen)
    writeAscii(bodyView, this.#headerLen + buffer.byteLength, MULTIPART_FOOTER)
    return this.transcribeUpload({
      sampleRate: headerView.getUint32(24, true),
      channels: headerView.getUint16(22, true),
      bitsPerSample: headerView.getUint16(34, true),
      body: bodyView.buffer as ArrayBuffer,
    })
  }
}
