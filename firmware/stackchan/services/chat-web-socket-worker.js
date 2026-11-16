/*
 * Stack-chan override of Moddable ChatWebSocketWorker.
 * Increases output audio prebuffer (~375ms vs ~250ms) to reduce playback underruns
 * when the main thread is busy with face rendering and servos.
 * Catches TLS/read errors (e.g. recordProtocol auth failed) and posts failed to the host.
 */

import ChatWorker from 'ChatWorker'
import JSONBase64Parser from 'JSONBase64Parser'
import TextEncoder from 'text/encoder'

const WebSocketClient = device.network.ws.io

const text = Object.freeze({ binary: false })

function errorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message)
  }
  return String(error)
}

class ChatWebSocketWorker extends ChatWorker {
  #buffers = []
  #state = 0
  #writable = 0
  #encoder = new TextEncoder()
  #failed = false

  constructor(options) {
    super(options)
    this.ws = null
    const sampleRate = options.outputSampleRate ?? 24000
    this.outputMinimum = (sampleRate * 3) >> 2
    this.silence = new ArrayBuffer(this.outputMinimum)
    new Uint8Array(this.silence).fill(0)
  }

  reportFailure(message) {
    if (this.#failed) return
    this.#failed = true
    const text = message ? String(message) : 'network error'
    trace(`[ChatWebSocket] failed ${text}\n`)
    try {
      if (this.ws) this.ws.close()
    } catch {}
    this.ws = null
    this.#buffers = []
    this.#state = 0
    this.#writable = 0
    this.postMessage({ id: 'failed', string: text })
  }

  close() {
    try {
      if (this.ws) this.ws.close()
    } catch {}
    this.ws = null
    this.#buffers = []
    this.#state = 0
    this.#writable = 0
  }

  resetOutputParser() {
    if (!this.outputBuffer) return
    const barrier = this.parser?.barrier
    this.parser = new JSONBase64Parser(this, this.outputBuffer, 2, this.outputMinimum)
    if (barrier) this.parser.barrier = barrier
  }

  post(id, param) {
    if (id === 'listen') this.resetOutputParser()
    self.postMessage({ id, ...(param ?? {}) })
  }

  connect(message) {
    super.connect(message)
    this.#failed = false
    this.resetOutputParser()
    this.parser.barrier = message.barrier
    this.ws = new WebSocketClient({
      ...device.network.wss,
      host: this.host,
      path: this.path,
      port: 443,
      headers: this.headers,
      onClose: () => {},
      onControl: (opcode, data) => {
        try {
          switch (opcode) {
            case WebSocketClient.close:
              data = new Uint8Array(data)
              const code = (data[0] << 8) | data[1]
              const reason = String.fromArrayBuffer(data.buffer.slice(2))
              if (code !== 1000) this.reportFailure(reason)
              else {
                this.postMessage({ id: 'disconnected' })
                this.close()
              }
              break
            case WebSocketClient.ping:
              break
            case WebSocketClient.pong:
              break
          }
        } catch (error) {
          this.reportFailure(errorMessage(error))
        }
      },
      onError: () => {
        this.reportFailure('network error')
      },
      onReadable: (count, options) => {
        if (this.#failed || this.#state !== 1 || !this.ws) return
        try {
          const buffer = this.ws.read(count)
          if (buffer) this.read(buffer, options)
        } catch (error) {
          this.reportFailure(errorMessage(error))
        }
      },
      onWritable: (count) => {
        if (this.#failed || !this.ws) return
        try {
          if (!count) return
          this.#writable = count
          if (this.#state === 0) {
            this.onOpen()
            this.#state = 1
            return
          }
          const buffers = this.#buffers
          while (buffers.length) {
            const buffer = buffers[0]
            const options = buffer.options
            const data = buffer.data
            const dataLength = data.byteLength
            const writable = this.#writable
            if (dataLength <= writable) {
              this.#writable = this.ws.write(data, options)
              buffers.shift()
            } else if (0 < writable) {
              const moreOptions = { ...options, more: true }
              this.#writable = this.ws.write(data.slice(0, writable), moreOptions)
              buffer.data = data.slice(writable)
              break
            } else break
          }
        } catch (error) {
          this.reportFailure(errorMessage(error))
        }
      },
    })
  }
  disconnect() {
    const code = 1000
    const data = Uint8Array.of(code >> 8, code & 0xff)
    try {
      this.write(data, { opcode: WebSocketClient.close })
    } catch (error) {
      this.reportFailure(errorMessage(error))
      return
    }
    this.#state = 2
  }
  isBase64(/* result, current, name */) {}
  onBase64(offset, size) {
    this.postMessage({ id: 'receiveAudio', offset, size })
  }
  onJSON(json) {
    const type = json.type
    if (type in this) this[type](json)
  }
  onOpen() {}
  read(data, options) {
    try {
      this.parser.read(data)
      if (options.more) return
      this.onJSON(this.parser.result)
      this.parser.reset()
    } catch (error) {
      this.reportFailure(errorMessage(error))
    }
  }
  sendAudio(message) {
    try {
      const samples = new Uint8Array(this.inputBuffer, message.offset, message.size)
      const string = samples.toBase64()
      const data = new Uint8Array(this.audioPrefix.length + string.length + this.audioSuffix.length)
      data.set(this.audioPrefix)
      this.#encoder.encodeInto(string, data.subarray(this.audioPrefix.length))
      data.set(this.audioSuffix, this.audioPrefix.length + string.length)
      trace(`[SendAudioWS] append size=${message.size} frame=${data.byteLength}\n`)
      this.write(data, text)
    } catch (error) {
      this.reportFailure(errorMessage(error))
    }
  }
  sendJSON(json) {
    try {
      const string = JSON.stringify(json)
      const data = ArrayBuffer.fromString(string)
      this.write(data, text)
    } catch (error) {
      this.reportFailure(errorMessage(error))
    }
  }
  write(data, options) {
    if (this.#failed || !this.ws) return
    try {
      const buffers = this.#buffers
      if (buffers.length) {
        buffers.push({ data, options })
      } else {
        const dataLength = data.byteLength
        const writable = this.#writable
        if (dataLength <= writable) {
          this.#writable = this.ws.write(data, options)
        } else if (0 < writable) {
          const moreOptions = { ...options, more: true }
          this.#writable = this.ws.write(data.slice(0, writable), moreOptions)
          buffers.push({ data: data.slice(writable), options })
        } else {
          buffers.push({ data, options })
        }
      }
    } catch (error) {
      this.reportFailure(errorMessage(error))
    }
  }
}

export default ChatWebSocketWorker
