/*
 * Stack-chan CoreS3 tuning for Moddable ChatAudioIO.
 * Smaller audio/worker buffers leave headroom for m5stackchan servos during Realtime chat.
 */

import AudioIn from 'embedded:io/audio/in'
import AudioOut from 'embedded:io/audio/out'
import Worker from 'worker'

/** Ring buffer in JSONBase64Parser requires a power-of-two byte length. */
const INPUT_BUFFER_SIZE = 128 * 1024
const OUTPUT_BUFFER_SIZE = 128 * 1024
const PLAYBACK_SILENCE_CHUNK = 2048
const WORKER_STATIC = 320 * 1024
const WORKER_CHUNK_INITIAL = 48 * 1024

function zeroSharedBuffer(buffer) {
  new Uint8Array(buffer).fill(0)
}

function computeLevel(buffer) {
  return native('xs_computeLevel').call(this, buffer)
}

class ChatAudioIO {
  static FAILED = -1
  static DISCONNECTED = 0
  static DISCONNECTING = 1
  static CONNECTING = 2
  static CONNECTED = 3
  static SPEAKING = 4
  static LISTENING = 5
  static WAITING = 6
  static states = ['DISCONNECTED', 'DISCONNECTING', 'CONNECTING', 'CONNECTED', 'SPEAKING', 'LISTENING', 'WAITING']
  static {
    ChatAudioIO.states[-1] = 'FAILED'
    Object.freeze(ChatAudioIO.states)
  }

  constructor(options) {
    this.error = ''
    this.state = ChatAudioIO.DISCONNECTED

    this.input = null
    this.inputBufferOffset = 0
    this.inputBufferSize = INPUT_BUFFER_SIZE
    this.inputBuffer = new SharedArrayBuffer(this.inputBufferSize)
    zeroSharedBuffer(this.inputBuffer)
    this.inputSampleRate = 24000
    this.ready = false

    this.output = null
    this.outputBufferSize = OUTPUT_BUFFER_SIZE
    this.outputBuffer = new SharedArrayBuffer(this.outputBufferSize)
    zeroSharedBuffer(this.outputBuffer)
    this.outputSampleRate = 24000
    this.outputBufferHead = 0
    this.outputBufferTail = 0
    this.barrier = new Int32Array(new SharedArrayBuffer(4))
    this._playbackSilence = new Uint8Array(PLAYBACK_SILENCE_CHUNK)

    this.level = 0
    this.microphone = 1
    this.volume = 1

    const callback = () => {}
    this.onFunctionCall = options.onFunctionCall ?? callback
    this.onInputLevelChanged = options.onInputLevelChanged ?? callback
    this.onInputTranscript = options.onInputTranscript ?? callback
    this.onOutputLevelChanged = options.onOutputLevelChanged
    this.onOutputTranscript = options.onOutputTranscript ?? callback
    this.onStateChanged = options.onStateChanged ?? callback

    trace('[AUDIO_TRACE_TEST_BEFORE]\n')
    this.createWorker(
      options.specifier,
      options.instructions,
      options.functions,
      options.voiceID,
      options.providerID,
      options.modelID,
      options.apiKey,
    )
    trace('[AUDIO_TRACE_TEST_AFTER]\n')
  }
  close() {
    this.worker?.terminate()
    this.worker = null
    this.output?.close()
    this.output = null
    this.input?.close()
    this.input = null
  }
  changeMicrophone(microphone) {
    this.microphone = microphone
  }
  changeVolume(volume) {
    this.volume = volume
    if (this.output) this.output.volume = volume
  }
  resetOutputBuffer() {
    this.outputBufferHead = 0
    this.outputBufferTail = 0
    Atomics.store(this.barrier, 0, 0)
    zeroSharedBuffer(this.outputBuffer)
  }
  createWorker(specifier, instructions, functions, voiceID, providerID, modelID, apiKey) {
    this.worker = new Worker(specifier, {
      static: WORKER_STATIC,
      chunk: {
        initial: WORKER_CHUNK_INITIAL,
        incremental: 8 * 1024,
      },
      heap: {
        initial: 1024,
        incremental: 256,
      },
      stack: 1024,
    })
    this.worker.onmessage = (message) => {
      try {
        const handler = this[message.id]
        if (handler) handler.call(this, message)
      } catch (error) {
        const text = error?.message ? String(error.message) : String(error)
        trace(`[ChatAudioIO] worker message error ${text}\n`)
        this.failed({ string: text })
      }
    }
    this.worker.postMessage({
      id: 'configure',
      instructions,
      functions,
      voiceID,
      providerID,
      modelID,
      apiKey,
    })
    this.ensureInput()
  }
  configureAudio(message) {
    const inputSampleRate = message.inputSampleRate ?? 24000
    if (this.inputSampleRate !== inputSampleRate) {
      this.inputSampleRate = inputSampleRate
      if (this.input) {
        this.input.close()
        this.input = null
        this.ensureInput()
      }
    }
    const outputSampleRate = message.outputSampleRate ?? 24000
    if (this.outputSampleRate !== outputSampleRate) {
      this.outputSampleRate = outputSampleRate
      if (this.output) {
        this.output.close()
        this.output = null
        this.ensureOutput()
      }
    }
  }
  connect() {
    this.state = ChatAudioIO.CONNECTING
    this.inputBufferOffset = 0
    this.resetOutputBuffer()
    this.worker.postMessage({
      id: 'connect',
      inputBuffer: this.inputBuffer,
      outputBuffer: this.outputBuffer,
      barrier: this.barrier,
    })
    this.onStateChanged(this.state)
  }
  connected() {
    this.state = ChatAudioIO.CONNECTED
    this.onStateChanged(this.state)
    this.state = ChatAudioIO.SPEAKING
    if (this.ready) this.onStateChanged(this.state)
  }
  disconnect() {
    this.state = ChatAudioIO.DISCONNECTING
    this.worker.postMessage({ id: 'disconnect' })
    this.onStateChanged(this.state)
  }
  disconnected() {
    this.error = ''
    this.state = ChatAudioIO.DISCONNECTED
    this.output?.close()
    this.output = null
    this.resetOutputBuffer()
    this.ensureInput()
    this.onStateChanged(this.state)
  }
  failed(message) {
    this.error = message.string
    this.state = ChatAudioIO.FAILED
    this.output?.close()
    this.output = null
    this.resetOutputBuffer()
    this.ensureInput()
    this.onStateChanged(this.state)
    trace(`[ChatAudioIO] FAILED ${this.error}\n`)
  }
  listen() {
    trace(`[ChatAudioIO] listen enter state=${this.state}\n`)
    if (this.state === ChatAudioIO.SPEAKING) {
      this.resetOutputBuffer()
      this.state = ChatAudioIO.LISTENING
      this.ensureOutput()
      this.onStateChanged(this.state)
    }
  }
  receiveAudio(message) {
    this.outputBufferHead = message.offset + message.size
  }
  receiveFunctionCall(message) {
    this.onFunctionCall(message.call, message.name, message.parameters)
  }
  receiveInputText(message) {
    this.onInputTranscript(message.text, message.more)
  }
  receiveOutputText(message) {
    this.onOutputTranscript(message.text, message.more)
  }
  sendFunctionResult(call, name, result) {
    this.worker.postMessage({ id: 'sendFunctionResult', call, name, result })
  }
  sendText(text) {
    if (this.state < ChatAudioIO.CONNECTED) throw new Error('not connected')
    if (this.state > ChatAudioIO.SPEAKING) throw new Error('listening')
    this.worker.postMessage({ id: 'sendText', text })
  }
  speak() {
    trace(`[ChatAudioIO] speak enter state=${this.state}\n`)
    this.state = ChatAudioIO.WAITING
  }

  ensureInput() {
    trace(`[ChatAudioIO] ensureInput enter state=${this.state} hasInput=${this.input ? 1 : 0}\n`)
    if (this.input) return
    this.output?.close()
    this.output = null
    const when = Date.now() + 500
    this.input = new AudioIn({
      sampleRate: this.inputSampleRate,
      onReadable: (size) => {
        if (!this.ready) {
          if (Date.now() >= when) {
            this.ready = true
            if (this.state !== ChatAudioIO.DISCONNECTED) this.onStateChanged(this.state)
          } else return
        }
        if (!this.microphone) return
        let delta = this.inputBufferSize - this.inputBufferOffset
        if (delta < size) {
          this.inputBufferOffset = 0
          delta = this.inputBufferSize
        }
        const samples = new Uint8Array(this.inputBuffer, this.inputBufferOffset, size)
        this.input.read(samples)
        const level = computeLevel(samples)
        if (this.level !== level) {
          this.level = level
          this.onInputLevelChanged(level)
        }
        if (this.state === ChatAudioIO.SPEAKING) {
          trace(`[SendAudio] size=${size} state=${this.state}\n`)
          this.worker.postMessage({ id: 'sendAudio', offset: this.inputBufferOffset, size })
        }
        this.inputBufferOffset += size
      },
    })
    this.input.start()
  }
  ensureOutput() {
    trace(`[ChatAudioIO] ensureOutput enter state=${this.state} hasOutput=${this.output ? 1 : 0}\n`)
    if (this.output) return
    this.input?.close()
    this.input = null
    this.ready = false
    this.output = new AudioOut({
      sampleRate: this.outputSampleRate,
      onWritable: (size) => {
        let start = this.outputBufferTail
        const stop = this.outputBufferHead
        let level = 0
        if (stop < start) {
          const limit = this.outputBufferSize
          if (start < limit && size > 0) {
            let delta = limit - start
            if (delta > size) delta = size
            const samples = new Uint8Array(this.outputBuffer, start, delta)
            if (this.onOutputLevelChanged) {
              const samplesLevel = computeLevel(samples)
              if (level < samplesLevel) level = samplesLevel
            }
            this.output.write(samples)
            start += delta
            size -= delta
          }
          if (start === limit) start = 0
        }
        if (start < stop && size > 0) {
          let delta = stop - start
          if (delta > size) delta = size
          const samples = new Uint8Array(this.outputBuffer, start, delta)
          if (this.onOutputLevelChanged) {
            const samplesLevel = computeLevel(samples)
            if (level < samplesLevel) level = samplesLevel
          }
          this.output.write(samples)
          start += delta
          size -= delta
        }
        this.outputBufferTail = start
        Atomics.store(this.barrier, 0, start)
        Atomics.notify(this.barrier, 0)

        if (start === stop && this.state === ChatAudioIO.WAITING) {
          this.worker.postMessage({ id: 'listened' })
          this.state = ChatAudioIO.SPEAKING
          this.ensureInput()
        } else if (start === stop && this.state === ChatAudioIO.LISTENING && size > 0) {
          const chunk = size < this._playbackSilence.byteLength ? size : this._playbackSilence.byteLength
          this.output.write(this._playbackSilence.subarray(0, chunk))
        }
        if (this.level !== level) {
          this.level = level
          this.onOutputLevelChanged?.(level)
        }
      },
    })
    this.output.start()
    this.output.volume = this.volume
  }
}

export default ChatAudioIO
