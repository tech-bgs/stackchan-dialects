// @ts-nocheck
import { ChatGPTDialogue } from 'dialogue-chatgpt'
import { clearChatStatusLed, updateChatStatusLed } from 'default-mods/chat-status-led'
import type { ChatSession, ChatSessionConfig } from 'default-mods/chat-config'
import type { ChatState } from 'chat-service'
import isNetworkReady from 'isNetworkReady'
import type { PushToTalkSampleFormat } from 'microphone'
import type { Robot } from 'robot'
import STT, { type WhisperUploadLayout } from 'stt-whisper'
import Timer from 'timer'

const DEFAULT_SAMPLE_RATE = 16000
const DEFAULT_CHANNELS = 1
const DEFAULT_BITS = 16
const LOOP_GAP_MS = 200

type ChatSessionOptions = {
  drawerButtonKey?: string
}

/**
 * Robot mic -> Whisper API -> ChatGPT -> OpenAI TTS (auto record loop).
 * Uses one pre-allocated upload buffer (multipart + WAV + PCM) to avoid duplicate allocations.
 */
export function createOpenAIChatSession(
  robot: Robot,
  chatConfig: ChatSessionConfig,
  options: ChatSessionOptions = {},
): ChatSession {
  const drawerButtonKey = options.drawerButtonKey ?? 'toggleSpeech'
  const app = robot.renderer?.application as
    | { distribute?: (event: string, payload?: unknown, error?: unknown) => void }
    | undefined

  const dialogue = new ChatGPTDialogue({
    apiKey: chatConfig.apiKey,
    model: chatConfig.modelID ?? 'gpt-4o-mini',
    instructions: chatConfig.instructions,
  })
  const stt = new STT({
    apiKey: chatConfig.apiKey,
    language: 'ko',
  })

  let active = false
  const stateListeners = new Set<(state: ChatState) => void>()
  let pipelineBusy = false
  let speaking = false
  let talking = false
  let uploadLayout: WhisperUploadLayout | null = null
  let captureFormat: PushToTalkSampleFormat | null = null
  let recordTimer: ReturnType<typeof Timer.set> | undefined
  let loopTimer: ReturnType<typeof Timer.set> | undefined

  const setChatState = (state: ChatState, error?: string) => {
    trace(`[ChatSession] state=${state}${error ? ` error=${error}` : ''}\n`)
    updateChatStatusLed(robot, state, 'openai')
    for (const listener of stateListeners) {
      listener(state)
    }
    app?.distribute?.('onChatState', state, error)
    if (state !== 'SPEAKING') {
      app?.distribute?.('onChatInputLevel', 0)
    }
  }

  const setDrawerActive = (nextActive: boolean) => {
    robot.application.setDrawerButtonState(drawerButtonKey, nextActive)
  }

  const clearLoopTimers = () => {
    if (recordTimer !== undefined) {
      Timer.clear(recordTimer)
      recordTimer = undefined
    }
    if (loopTimer !== undefined) {
      Timer.clear(loopTimer)
      loopTimer = undefined
    }
  }

  const releaseCapture = () => {
    uploadLayout = null
    captureFormat = null
    talking = false
  }

  const isInteractionLocked = () => pipelineBusy || speaking

  const fail = (message: string) => {
    trace(`[ChatSession] ${message}\n`)
    setChatState('FAILED', message)
    active = false
    pipelineBusy = false
    speaking = false
    clearLoopTimers()
    robot.cancelPushToTalk()
    releaseCapture()
    setDrawerActive(false)
  }

  const ensureUploadLayout = (): WhisperUploadLayout => {
    if (uploadLayout) return uploadLayout
    const format = {
      sampleRate: DEFAULT_SAMPLE_RATE,
      channels: DEFAULT_CHANNELS,
      bitsPerSample: DEFAULT_BITS,
    }
    const maxPcmBytes = stt.pcmBytesForDuration(chatConfig.maxRecordMs, format)
    uploadLayout = stt.createUploadLayout(maxPcmBytes)
    return uploadLayout
  }

  const scheduleNextTurn = () => {
    if (!active || speaking) return
    clearLoopTimers()
    loopTimer = Timer.set(() => {
      loopTimer = undefined
      startAutoRecord()
    }, LOOP_GAP_MS)
  }

  const finishSpeaking = () => {
    speaking = false
    if (!active) return
    setChatState('CONNECTED')
    scheduleNextTurn()
  }

  const respond = async (userText: string) => {
    if (!active) return
    const trimmed = userText.trim()
    if (trimmed.length === 0) {
      scheduleNextTurn()
      return
    }

    try {
      trace(`[ChatSession] user=${trimmed}\n`)
      setChatState('WAITING')

      const reply = await dialogue.post(trimmed)
      if (!active) return
      if (!reply.success) {
        fail(`chat error: ${'reason' in reply ? reply.reason : 'unknown'}`)
        return
      }

      const assistantText = reply.value?.trim() ?? ''
      if (assistantText.length === 0) {
        scheduleNextTurn()
        return
      }

      trace(`[ChatSession] assistant=${assistantText}\n`)
      speaking = true
      setChatState('SPEAKING')

      const spoken = await robot.say(assistantText)
      if (!active) return
      if (!spoken.success) {
        speaking = false
        const reason = 'reason' in spoken ? spoken.reason : 'unknown'
        const reasonText = String(reason ?? 'unknown')
        if (reasonText === 'already playing') {
          trace('[ChatSession] ignored concurrent TTS\n')
          finishSpeaking()
          return
        }
        fail(`tts error: ${reasonText}`)
        return
      }

      finishSpeaking()
    } catch (error) {
      speaking = false
      const message = error instanceof Error ? error.message : String(error)
      if (message === 'already playing') {
        trace('[ChatSession] ignored concurrent TTS\n')
        finishSpeaking()
        return
      }
      fail(message)
    }
  }

  const processCapture = async () => {
    if (!active || isInteractionLocked()) return
    if (recordTimer !== undefined) {
      Timer.clear(recordTimer)
      recordTimer = undefined
    }
    if (!robot.microphone || !uploadLayout || !captureFormat) {
      releaseCapture()
      scheduleNextTurn()
      return
    }
    if (!isNetworkReady()) {
      fail('Wi-Fi not ready for chat')
      return
    }

    pipelineBusy = true
    try {
      const captured = robot.endPushToTalkInto()
      talking = false
      if (!active) return
      if (!captured) {
        scheduleNextTurn()
        return
      }

      setChatState('WAITING')
      const payload = stt.buildUploadPayload(uploadLayout, captured.format, captured.pcmBytes)
      captureFormat = null
      uploadLayout = null

      const transcript = await stt.transcribeUpload(payload)
      if (!active) return
      if (!transcript.success) {
        fail(`stt error: ${'reason' in transcript ? transcript.reason : 'unknown'}`)
        return
      }

      await respond(transcript.value ?? '')
    } catch (error) {
      uploadLayout = null
      captureFormat = null
      const message = error instanceof Error ? error.message : String(error)
      fail(message)
    } finally {
      pipelineBusy = false
      talking = false
    }
  }

  const startAutoRecord = () => {
    if (!active || talking || isInteractionLocked()) return
    if (!robot.microphone) {
      fail('microphone unavailable')
      return
    }
    if (!isNetworkReady()) {
      fail('Wi-Fi not ready for chat')
      return
    }

    try {
      const layout = ensureUploadLayout()
      const pcmView = layout.buffer.subarray(layout.pcmOffset, layout.pcmOffset + layout.maxPcmBytes)
      trace(`[ChatSession] auto record ${chatConfig.maxRecordMs}ms buf=${layout.buffer.byteLength}\n`)
      talking = true
      setChatState('LISTENING')
      captureFormat = robot.beginPushToTalkInto(pcmView)
      recordTimer = Timer.set(() => {
        recordTimer = undefined
        void processCapture()
      }, chatConfig.maxRecordMs)
    } catch (error) {
      talking = false
      const message = error instanceof Error ? error.message : String(error)
      trace(`[ChatSession] record skipped: ${message}\n`)
      robot.cancelPushToTalk()
      releaseCapture()
      if (active) {
        scheduleNextTurn()
      }
    }
  }

  const start = () => {
    if (active) return
    if (!isNetworkReady()) {
      trace('[ChatSession] Wi-Fi not ready for chat\n')
      return
    }
    if (!robot.microphone) {
      trace('[ChatSession] microphone unavailable\n')
      return
    }
    trace(`[ChatSession] start auto loop max=${chatConfig.maxRecordMs}ms\n`)
    active = true
    setDrawerActive(true)
    setChatState('CONNECTED')
    startAutoRecord()
  }

  const stop = () => {
    if (!active) return
    trace('[ChatSession] stop auto chat\n')
    active = false
    pipelineBusy = false
    speaking = false
    clearLoopTimers()
    robot.cancelPushToTalk()
    releaseCapture()
    dialogue.clear()
    clearChatStatusLed(robot)
    setDrawerActive(false)
    setChatState('DISCONNECTED')
  }

  return {
    isActive: () => active,
    usesPushToTalk: () => false,
    canAcceptPushToTalk: () => false,
    start,
    stop,
    beginTalk: () => {},
    endTalk: () => {},
    onStateChange: (listener: (state: ChatState) => void) => {
      stateListeners.add(listener)
      return () => {
        stateListeners.delete(listener)
      }
    },
    toggle: () => {
      if (active) stop()
      else start()
    },
  }
}
