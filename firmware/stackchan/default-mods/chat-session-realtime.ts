// @ts-nocheck
import { ChatService, type ChatConfig, type ChatState, type ChatTool } from 'chat-service'
import { clearChatStatusLed, updateChatStatusLed } from 'default-mods/chat-status-led'
import type { ChatSession, ChatSessionConfig } from 'default-mods/chat-config'
import { Emotion } from 'face-context'
import { tracePhotoSessionDiag } from 'photo-session-diagnostics'

import isNetworkReady from 'isNetworkReady'
import { ensureNetworkTime } from 'ensure-network-time'
import type { Robot } from 'robot'
import type { Rotation } from 'stackchan-util'
import Timer from 'timer'

const MOUTH_UPDATE_INTERVAL_MS = 200
const MOUTH_QUANTIZE_STEP = 0.1
const MOUTH_MAX_STEP = Math.round(1 / MOUTH_QUANTIZE_STEP)
const MOUTH_LEVEL_STEP_DIVISOR = Math.round(MOUTH_QUANTIZE_STEP / (1 / 2000))
const DEBUG_TRANSCRIPT = true
const MAX_RECONNECT_ATTEMPTS = 15
const RECONNECT_BASE_DELAY_MS = 800

const REALTIME_CHAT_TYPES = new Set([
  'openAIRealtime',
  'deepgramAgent',
  'elevenLabsAgent',
  'googleGeminiLive',
  'humeAIEVI',
])

type ChatSessionOptions = {
  drawerButtonKey?: string
}

type LookDirection = 'center' | 'left' | 'right' | 'up' | 'down'

const HEAD_ROTATION_BY_DIRECTION: Record<LookDirection, Rotation> = {
  center: { y: 0, p: 0, r: 0 },
  left: { y: Math.PI / 6, p: 0, r: 0 },
  right: { y: -Math.PI / 6, p: 0, r: 0 },
  up: { y: 0, p: -Math.PI / 6, r: 0 },
  down: { y: 0, p: Math.PI / 32, r: 0 },
}

const LOOK_DIRECTION_ALIASES: Record<string, LookDirection> = {
  center: 'center',
  forward: 'center',
  straight: 'center',
  front: 'center',
  left: 'left',
  right: 'right',
  up: 'up',
  down: 'down',
  가운데: 'center',
  정면: 'center',
  앞: 'center',
  왼쪽: 'left',
  좌: 'left',
  우측: 'right',
  오른쪽: 'right',
  우: 'right',
  위: 'up',
  아래: 'down',
}

const LOOK_DIRECTION_TOOL_HINT = `
When the user asks you to look or turn the head in a direction (for example "look right", "우측을 바라봐", "고개 돌려"), you MUST call the look_direction tool before saying you did it.
Never claim the head moved unless look_direction was called in that turn.
`.trim()

function resolveLookDirection(raw: unknown): LookDirection | null {
  if (typeof raw !== 'string') return null
  const key = raw.trim().toLowerCase()
  return LOOK_DIRECTION_ALIASES[key] ?? null
}

function isRecoverableConnectionError(error?: string): boolean {
  if (!error) return true
  const lower = error.toLowerCase()
  return (
    lower.includes('recordprotocol') ||
    lower.includes('record protocol') ||
    lower.includes('auth failed') ||
    lower.includes('network') ||
    lower.includes('tls') ||
    lower.includes('socket') ||
    lower.includes('connection') ||
    lower.includes('closed') ||
    lower.includes('reset')
  )
}

function createRealtimeChatTools(robot: Robot): Record<string, ChatTool> {
  return {
    look_direction: {
      name: 'look_direction',
      description:
        'Turn the robot head to look in a direction. Use when the user asks to look left, right, center, up, or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            description: 'One of: center, left, right, up, down',
          },
        },
        required: ['direction'],
      },
      execute: async ({ direction }) => {
        const resolved = resolveLookDirection(direction)
        if (!resolved) {
          return `Invalid direction: ${String(direction)}`
        }
        await robot.lookTowardsRotation(HEAD_ROTATION_BY_DIRECTION[resolved], {
          duration: 0.8,
          releaseTorque: true,
        })
        if (resolved === 'center') {
          robot.lookAway()
        }
        return `Looking ${resolved}`
      },
    },
    get_current_time: {
      name: 'get_current_time',
      description: 'Get the current time in Korea. Call this when the user asks what time it is.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
      execute: async () => {
        const now = new Date()
        const h = (now.getHours() + 9) % 24
        const m = now.getMinutes()
        trace(`[Time] current getHours=${h} getMinutes=${m}\n`)
        return `현재 시각: ${h}시 ${m}분`
      },
    },
  }
}

export function createRealtimeChatSession(
  robot: Robot,
  sessionConfig: ChatSessionConfig,
  options: ChatSessionOptions = {},
): ChatSession | null {
  if (!REALTIME_CHAT_TYPES.has(sessionConfig.type)) {
    trace(`[ChatSession] unsupported realtime chatType=${sessionConfig.type}\n`)
    return null
  }

  const drawerButtonKey = options.drawerButtonKey ?? 'toggleSpeech'
  const chatConfig: ChatConfig = {
    type: sessionConfig.type as ChatConfig['type'],
    instructions: `${sessionConfig.instructions}\n\n${LOOK_DIRECTION_TOOL_HINT}`,
    voiceID: sessionConfig.voiceID,
    modelID: sessionConfig.modelID,
    providerID: sessionConfig.apiKey,
    apiKey: sessionConfig.apiKey,
  }
  const tools = createRealtimeChatTools(robot)

  const app = robot.renderer?.application as
    | { distribute?: (event: string, payload?: unknown, error?: unknown) => void }
    | undefined

  let active = false
  const stateListeners = new Set<(state: ChatState) => void>()
  let userStopRequested = false
  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof Timer.set> | undefined
  let _chatLedState: ChatState = 'DISCONNECTED'
  let mouthUpdateTimer: ReturnType<typeof Timer.repeat> | undefined
  let pendingMouthStep = 0
  let lastMouthStep = 0

  const clampMouthStep = (step: number) => {
    if (step <= 0) return 0
    if (step >= MOUTH_MAX_STEP) return MOUTH_MAX_STEP
    return step
  }

  const flushMouthOpen = () => {
    if (pendingMouthStep === lastMouthStep) return
    lastMouthStep = pendingMouthStep
    robot.setMouthOpen(lastMouthStep * MOUTH_QUANTIZE_STEP)
  }

  const queueMouthStep = (step: number, immediate = false) => {
    const nextStep = clampMouthStep(step)
    if (nextStep === pendingMouthStep && !immediate) return
    pendingMouthStep = nextStep
    if (immediate) flushMouthOpen()
  }

  const queueMouthLevel = (level: number) => {
    const step = clampMouthStep(Math.round(level / MOUTH_LEVEL_STEP_DIVISOR))
    queueMouthStep(step)
  }

  const queueMouthOpen = (value: number, immediate = false) => {
    const step = clampMouthStep(Math.round(value / MOUTH_QUANTIZE_STEP))
    queueMouthStep(step, immediate)
  }

  const startUiTimers = () => {
    if (mouthUpdateTimer !== undefined) {
      tracePhotoSessionDiag('ChatSession.startUiTimers skip (already running)')
      return
    }
    mouthUpdateTimer = Timer.repeat(flushMouthOpen, MOUTH_UPDATE_INTERVAL_MS)
    tracePhotoSessionDiag('ChatSession.startUiTimers started mouthUpdateTimer')
  }

  const stopUiTimers = () => {
    tracePhotoSessionDiag('ChatSession.stopUiTimers before')
    if (mouthUpdateTimer === undefined) {
      tracePhotoSessionDiag('ChatSession.stopUiTimers after (already stopped)')
      return
    }
    Timer.clear(mouthUpdateTimer)
    mouthUpdateTimer = undefined
    tracePhotoSessionDiag('ChatSession.stopUiTimers after')
  }

  const resetSessionUi = () => {
    stopUiTimers()
    pendingMouthStep = 0
    lastMouthStep = 0
  }

  const setDrawerActive = (nextActive: boolean) => {
    robot.application.setDrawerButtonState(drawerButtonKey, nextActive)
  }

  const clearReconnectTimer = () => {
    if (reconnectTimer === undefined) return
    Timer.clear(reconnectTimer)
    reconnectTimer = undefined
  }

  const teardownSession = (error?: string) => {
    trace('[ChatSessionTrace] teardownSession\n')
    active = false
    reconnectAttempts = 0
    clearReconnectTimer()
    _chatLedState = 'DISCONNECTED'
    robot.setChatLoadReduction(false)
    clearChatStatusLed(robot)
    setDrawerActive(false)
    resetSessionUi()
    chat.stop()
    chat.release()
    queueMouthOpen(0, true)
    if (error) {
      trace(`[ChatSession] ${error}\n`)
    }
  }

  const connectChat = () => {
    void ensureNetworkTime()
      .then(() => {
        if (!active || userStopRequested) return
        chat.start()
      })
      .catch((error) => {
        trace(`[ChatSession] network time sync failed: ${String(error)}\n`)
        scheduleReconnect(String(error))
      })
  }

  const attemptReconnect = () => {
    if (!active || userStopRequested) return
    if (!isNetworkReady()) {
      scheduleReconnect('network not ready')
      return
    }
    trace(`[ChatSession] reconnect attempt=${reconnectAttempts}\n`)
    connectChat()
  }

  const scheduleReconnect = (reason: string) => {
    trace('[ChatSessionTrace] scheduleReconnect\n')
    if (!active || userStopRequested || reconnectTimer !== undefined) return
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      trace(`[ChatSession] reconnect gave up after ${reconnectAttempts} attempts\n`)
      teardownSession('reconnect failed')
      return
    }
    reconnectAttempts += 1
    const delay = RECONNECT_BASE_DELAY_MS * reconnectAttempts
    trace(`[ChatSession] schedule reconnect in ${delay}ms reason=${reason}\n`)
    queueMouthOpen(0, true)
    clearChatStatusLed(robot)
    chat.stop()
    chat.release()
    trace(`[ChatSession] reconnecting (${reconnectAttempts})...\n`)
    reconnectTimer = Timer.set(() => {
      reconnectTimer = undefined
      void ensureNetworkTime().then(() => attemptReconnect())
    }, delay)
  }

  const handleConnectionLoss = (error?: string) => {
    trace('[ChatSessionTrace] handleConnectionLoss\n')
    if (!active || userStopRequested) return
    if (!isRecoverableConnectionError(error)) {
      teardownSession(error ?? 'chat failed')
      return
    }
    scheduleReconnect(error ?? 'connection lost')
  }

  const chat = new ChatService({
    config: chatConfig,
    tools,
    callbacks: {
      onStateChanged: (state: ChatState, error?: string) => {
        trace(`[ChatSession] state=${state}${error ? ` error=${error}` : ''}\n`)
        _chatLedState = state
        if (state === 'DISCONNECTING' || state === 'DISCONNECTED') {
          robot.setEmotion(Emotion.NEUTRAL)
          robot.setMouthOpen(0)
          robot.renderer?.removeDecorator?.({ name: 'emotion' } as any)
        }
        if (active) {
          updateChatStatusLed(robot, state, 'realtime')
        }
        for (const listener of stateListeners) {
          listener(state)
        }
        app?.distribute?.('onChatState', state, error)
        if (state === 'CONNECTED' || state === 'SPEAKING') {
          if (reconnectAttempts > 0) {
            trace('[ChatSession] reconnect succeeded\n')
            reconnectAttempts = 0
            clearReconnectTimer()
          }
          // camera warmup removed — causes audio stutter during speech
        }
        if (state !== 'SPEAKING') {
          app?.distribute?.('onChatInputLevel', 0)
        }
        if (state !== 'LISTENING') {
          queueMouthOpen(0, true)
        }
        if (state === 'FAILED') {
          trace(
            `[ChatSessionTrace] connectionLoss state=${state} active=${active ? 1 : 0} error=${error ?? '(none)'}\n`,
          )
          handleConnectionLoss(error)
          return
        }
        if (state === 'DISCONNECTED' && active) {
          trace(
            `[ChatSessionTrace] connectionLoss state=${state} active=${active ? 1 : 0} error=${error ?? '(none)'}\n`,
          )
          handleConnectionLoss(error)
        }
      },
      onInputLevelChanged: (level: number) => {
        app?.distribute?.('onChatInputLevel', level)
      },
      onOutputLevelChanged: (level: number) => {
        queueMouthLevel(level)
      },
      onInputTranscript: (text: string, more: boolean) => {
        trace(`[UserTranscript] text="${text ?? ''}" more=${more}\n`)
      },
      onOutputTranscript: (text: string, more: boolean) => {
        if (!DEBUG_TRANSCRIPT) return
        trace(`[ChatSession] transcript chunk="${text ?? ''}" more=${more}\n`)
      },
      onFunctionCall: async (call, name, params) => {
        trace(`[ChatSession] functionCall name=${name} params=${JSON.stringify(params ?? {})}\n`)
        const tool = tools[name]
        if (!tool?.execute) {
          chat.sendFunctionResult(call, name, `Tool not found: ${name}`)
          return
        }
        try {
          const result = await tool.execute(params ?? {})
          chat.sendFunctionResult(call, name, result)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          chat.sendFunctionResult(call, name, message)
        }
      },
    },
  })

  const start = () => {
    trace('[ChatSessionTrace] start\n')
    if (active) return
    if (!isNetworkReady()) {
      trace('[ChatSession] network not ready (check Wi-Fi IP and default netif)\n')
      return
    }
    trace(`[ChatSession] start realtime modelID=${sessionConfig.modelID ?? '(default)'}\n`)
    active = true
    userStopRequested = false
    reconnectAttempts = 0
    clearReconnectTimer()
    robot.setChatLoadReduction(true)
    setDrawerActive(true)
    startUiTimers()
    chat.setVolume(0.5)
    queueMouthOpen(0, true)
    connectChat()
  }

  const stop = () => {
    trace('[ChatSessionTrace] stop\n')
    if (!active) return
    trace('[ChatSession] stop realtime\n')
    userStopRequested = true
    active = false
    clearReconnectTimer()
    _chatLedState = 'DISCONNECTED'
    robot.setChatLoadReduction(false)
    clearChatStatusLed(robot)
    setDrawerActive(false)
    resetSessionUi()
    chat.stop()
    chat.release()
    queueMouthOpen(0, true)
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
    pauseHeavyUi: stopUiTimers,
    resumeHeavyUi: () => {
      tracePhotoSessionDiag(`ChatSession.startUiTimers before active=${active}`)
      if (active) startUiTimers()
      tracePhotoSessionDiag('ChatSession.startUiTimers after')
    },
  }
}
