// @ts-nocheck
/* eslint-disable prefer-const */
import AudioOut from 'pins/audioout'
import ElevenLabsStreamer from 'elevenlabsstreamer'
import calculatePower from 'calculate-power'

export type TTSProperty = {
  onPlayed?: (number) => void
  onDone?: () => void
  token: string
  voice?: string
  latency?: number
  format?: string
  model?: string
  voice_settings?: { similarity_boost: number; stability: number }
  volume?: number
}

export class TTS {
  audio?: AudioOut
  onPlayed?: (number) => void
  onDone?: () => void
  token: string
  model: string
  voice: string
  latency: number
  format: string
  volume: number
  streaming: boolean

  constructor(props: TTSProperty) {
    this.onPlayed = props.onPlayed
    this.onDone = props.onDone
    this.streaming = false
    this.token = props.token
    this.latency = props.latency ?? 2
    this.format = props.format ?? 'mp3_22050_32'
    this.model = props.model ?? 'eleven_multilingual_v2'
    this.voice = props.voice ?? 'AZnzlk1XvdvUeBnXmlld'
    this.volume = props.volume ?? 0.8
  }

  async stream(text: string, volume?: number): Promise<void> {
    if (this.streaming) {
      trace('[TTS] already playing, skip\n')
      return Promise.resolve()
    }
    this.streaming = true
    const { onPlayed, onDone } = this
    return new Promise((resolve, reject) => {
      this.audio = new AudioOut({})
      this.audio.enqueue(0, AudioOut.Volume, Math.round((volume ?? this.volume) * 256))
      const audio = this.audio
      const streamer = new ElevenLabsStreamer({
        key: this.token,
        voice: this.voice,
        model: this.model,
        latency: this.latency,
        format: this.format,
        voice_settings: { stability: 0.85, similarity_boost: 0.75, speed: 0.9 },
        text,
        audio: {
          out: audio,
          stream: 0,
        },
        onPlayed(buffer) {
          const power = calculatePower(buffer)
          onPlayed?.(power)
        },
        onReady(state) {
          trace(`Ready: ${state}\n`)
          if (state) {
            audio.start()
          } else {
            audio.stop()
          }
        },
        onError: (e) => {
          trace('ERROR: ', e, '\n')
          this.streaming = false
          streamer?.close()
          this.audio?.close()
          this.audio = undefined
          reject(e)
        },
        onDone: () => {
          trace('DONE\n')
          this.streaming = false
          streamer?.close()
          this.audio?.close()
          this.audio = undefined
          onDone?.()
          resolve()
        },
      })
    })
  }
}
