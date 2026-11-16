// @ts-nocheck
import AudioOut from 'pins/audioout'

export type ToneProperty = {
  volume?: number
}

export default class Tone {
  volume: number
  #audio: InstanceType<typeof AudioOut> | undefined
  #busy = false

  constructor(props: ToneProperty) {
    this.volume = props.volume ?? 0.5
  }

  async tone(hz: number, duration: number, volume?: number): Promise<void> {
    trace(`[ShutterTrace] Tone.tone hz=${hz} duration=${duration} volume=${volume ?? this.volume}\n`)
    if (this.#busy) {
      trace('[Tone] busy, skip overlapping tone\n')
      return
    }
    this.#busy = true
    const audio = new AudioOut({
      streams: 1,
      sampleRate: 24000,
      bitsPerSample: 16,
    })
    return new Promise((resolve) => {
      audio.enqueue(0, AudioOut.Flush)
      audio.enqueue(0, AudioOut.Volume, Math.round((volume ?? this.volume) * 256))
      audio.enqueue(0, AudioOut.Tone, hz, (audio.sampleRate * duration) / 1000)
      audio.enqueue(0, AudioOut.Callback, 1)
      audio.callback = () => {
        this.#busy = false
        audio.close()
        resolve()
      }
      audio.start()
    })
  }

  /** Short dual-tone burst mimicking a camera shutter click. */
  async shutterClick(volume?: number): Promise<void> {
    trace(`[ShutterTrace] Tone.shutterClick volume=${volume ?? this.volume}\n`)
    if (!this.#audio) {
      this.#audio = new AudioOut({
        streams: 1,
        sampleRate: 24000,
        bitsPerSample: 16,
      })
    }
    if (this.#busy) {
      trace('[Tone] busy, skip overlapping shutterClick\n')
      return
    }
    const audio = this.#audio
    this.#busy = true
    const vol = volume ?? this.volume
    const sampleRate = audio.sampleRate

    return new Promise((resolve) => {
      audio.enqueue(0, AudioOut.Flush)
      audio.enqueue(0, AudioOut.Volume, Math.round(vol * 256))
      audio.enqueue(0, AudioOut.Tone, 3600, (sampleRate * 10) / 1000)
      audio.enqueue(0, AudioOut.Volume, Math.round(vol * 0.55 * 256))
      audio.enqueue(0, AudioOut.Tone, 1300, (sampleRate * 20) / 1000)
      audio.enqueue(0, AudioOut.Callback, 1)

      audio.callback = () => {
        this.#busy = false
        resolve()
      }

      trace('[ShutterTrace] BEFORE shutterClick audio.start\n')
      audio.start()
      trace('[ShutterTrace] AFTER shutterClick audio.start\n')
    })
  }
}
