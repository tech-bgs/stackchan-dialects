// @ts-nocheck
import type { ChatState } from 'chat-service'
import { ensureSharedPY32IOExpander } from 'py32-io-expander'
import type { Robot } from 'robot'

declare const trace: (message: string) => void

export const CHAT_LED_NAME = 'head'
/** Stack-chan's right cheek on the 12-LED head ring (front view). */
export const CHAT_LED_RIGHT_INDEX = 3

export type ChatLedMode = 'realtime' | 'openai'

type ActiveLedMode = 'off' | 'user' | 'ai'

let _activeLedMode: ActiveLedMode = 'off'

function hasChatLed(robot: Robot): boolean {
  return robot.led[CHAT_LED_NAME] != null
}

function applyActiveLed(robot: Robot, mode: ActiveLedMode): void {
  _activeLedMode = mode
  if (!hasChatLed(robot)) return
  try {
    ensureSharedPY32IOExpander()
  } catch (error) {
    trace(`[ChatLed] PY32 unavailable: ${error}\n`)
    return
  }
  if (mode === 'off') {
    robot.lightOff(CHAT_LED_NAME)
    return
  }
  robot.lightOff(CHAT_LED_NAME)
  if (mode === 'user') {
    robot.lightOn(CHAT_LED_NAME, 0, 0, 255, undefined, CHAT_LED_RIGHT_INDEX, 1)
    return
  }
  robot.lightOn(CHAT_LED_NAME, 0, 255, 80, undefined, CHAT_LED_RIGHT_INDEX, 1)
}

function isUserChannel(state: ChatState, _mode: ChatLedMode): boolean {
  return state === 'LISTENING' || state === 'CONNECTED'
}

function isAiChannel(state: ChatState, mode: ChatLedMode): boolean {
  if (mode === 'realtime') {
    return state === 'SPEAKING' || state === 'WAITING'
  }
  return state === 'SPEAKING'
}

function isInactiveState(state: ChatState): boolean {
  return state === 'DISCONNECTED' || state === 'DISCONNECTING' || state === 'FAILED' || state === 'CONNECTING'
}

/**
 * Keep one LED steadily on per chat phase. Updates hardware only when the phase changes.
 */
export function updateChatStatusLed(robot: Robot, state: ChatState, mode: ChatLedMode = 'realtime'): void {
  if (!hasChatLed(robot) || isInactiveState(state)) {
    applyActiveLed(robot, 'off')
    return
  }
  if (isUserChannel(state, mode)) {
    applyActiveLed(robot, 'user')
    return
  }
  if (isAiChannel(state, mode)) {
    applyActiveLed(robot, 'ai')
    return
  }
  applyActiveLed(robot, 'off')
}

export function clearChatStatusLed(robot: Robot): void {
  if (!hasChatLed(robot)) return
  applyActiveLed(robot, 'off')
}
