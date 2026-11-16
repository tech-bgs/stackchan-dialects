// @ts-nocheck
import WebSocket from 'WebSocket'

export type STTWebSocketConfig = {
  host: string
  port?: number
}

export type STTMessage = {
  role: string
  message?: string
  type?: string
}

export default class STTWebSocket {
  #ws: InstanceType<typeof WebSocket> | null = null
  #onUserMessage?: (message: string) => void
  #onStreamResult?: (message: string) => void
  host: string
  port: number

  constructor(config: STTWebSocketConfig) {
    this.host = config.host
    this.port = config.port ?? 8080
  }

  connect(onUserMessage: (message: string) => void): void {
    this.#onUserMessage = onUserMessage
    this.#onStreamResult = undefined
    const ws = new WebSocket(`ws://${this.host}:${this.port}/`)
    this.#ws = ws
    ws.addEventListener('open', () => {
      trace(`[STT] connected ws://${this.host}:${this.port}/\n`)
    })
    ws.addEventListener('message', (payload) => {
      this.#handleMessage(payload.data)
    })
    ws.addEventListener('close', () => {
      trace('[STT] disconnected\n')
    })
  }

  #handleMessage(data: string | ArrayBuffer | undefined): void {
    if (data == null) return
    if (typeof data !== 'string') return
    if (data.length <= 1) return
    try {
      const parsed = JSON.parse(data) as STTMessage
      if (parsed.role === 'user' && typeof parsed.message === 'string' && parsed.message.length > 0) {
        if (this.#onStreamResult) {
          const handler = this.#onStreamResult
          this.#onStreamResult = undefined
          handler(parsed.message)
        } else {
          this.#onUserMessage?.(parsed.message)
        }
      }
    } catch (error) {
      trace(`[STT] invalid message: ${String(error)}\n`)
    }
  }

  sendAssistantMessage(message: string): void {
    this.#ws?.send(JSON.stringify({ role: 'assistant', message }))
  }

  beginAudioStream(sampleRate: number, channels: number, bitsPerSample = 16): void {
    this.#ws?.send(
      JSON.stringify({
        type: 'audioStart',
        sampleRate,
        channels,
        bitsPerSample,
      }),
    )
  }

  sendAudioChunk(chunk: ArrayBuffer): void {
    this.#ws?.send(chunk)
  }

  endAudioStream(onResult?: (message: string) => void): void {
    if (onResult) this.#onStreamResult = onResult
    this.#ws?.send(JSON.stringify({ type: 'audioEnd' }))
  }

  close(): void {
    this.#ws?.close()
    this.#ws = null
    this.#onUserMessage = undefined
    this.#onStreamResult = undefined
  }
}
