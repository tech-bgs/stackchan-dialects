// @ts-nocheck
import type { ChatConfig } from 'chat-service'
import loadPreferences from 'loadPreference'
import config from 'mc/config'

export type ChatSession = {
  isActive: () => boolean
  usesPushToTalk: () => boolean
  canAcceptPushToTalk: () => boolean
  start: () => void
  stop: () => void
  toggle: () => void
  beginTalk: () => void
  endTalk: () => void
  onStateChange?: (listener: (state: import('chat-service').ChatState) => void) => () => void
  /** Pause mouth/UI timers during camera capture (reduces PIU main-loop stalls). */
  pauseHeavyUi?: () => void
  resumeHeavyUi?: () => void
}

export type ChatSessionConfig = {
  type: string
  instructions: string
  voiceID: string
  modelID?: string
  apiKey: string
  maxRecordMs: number
}

export const DEFAULT_CHAT_INSTRUCTIONS = `
You are Stack-chan, a robot created by an open-source community.
Speak in polite, friendly, short sentences.
Keep each response brief and conversational.
`.trim()

type McChatConfig = {
  chatType?: string
  chatModelID?: string
  chatInstructions?: string
  chatVoiceID?: string
  chatProviderID?: string
  chatRecordMs?: number
  displayListLength?: number
  commandListLength?: number
  openAIKey?: string
}

const DEFAULT_RECORD_MS = 1200
const MIN_RECORD_MS = 800
const MAX_RECORD_MS = 2000

function readMaxRecordMs(mc: McChatConfig): number {
  const value = mc.chatRecordMs
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_RECORD_MS
  }
  if (value < MIN_RECORD_MS) return MIN_RECORD_MS
  if (value > MAX_RECORD_MS) return MAX_RECORD_MS
  return Math.round(value)
}

function readApiKey(mc: McChatConfig, ttsToken?: string): string | undefined {
  if (typeof mc.chatProviderID === 'string' && mc.chatProviderID.length > 0) {
    return mc.chatProviderID
  }
  if (typeof mc.openAIKey === 'string' && mc.openAIKey.length > 0) {
    return mc.openAIKey
  }
  if (typeof ttsToken === 'string' && ttsToken.length > 0) {
    return ttsToken
  }
  return undefined
}

export function loadChatSessionConfig(): ChatSessionConfig | null {
  const mc = config as McChatConfig
  const ttsPrefs = loadPreferences('tts')
  const ttsToken = typeof ttsPrefs.token === 'string' ? ttsPrefs.token : undefined
  const apiKey = readApiKey(mc, ttsToken)
  const type = typeof mc.chatType === 'string' ? mc.chatType : undefined

  if (!type || type.length === 0) {
    trace(
      `[ChatSession] config.chatType is required (got=${String(mc.chatType)}). Set manifest_local.json config.chatType\n`,
    )
    return null
  }
  if (!apiKey) {
    trace('[ChatSession] config.chatProviderID or config.openAIKey is required\n')
    return null
  }

  return {
    type,
    instructions: typeof mc.chatInstructions === 'string' ? mc.chatInstructions : DEFAULT_CHAT_INSTRUCTIONS,
    voiceID: typeof mc.chatVoiceID === 'string' ? mc.chatVoiceID : 'marin',
    modelID: typeof mc.chatModelID === 'string' ? mc.chatModelID : undefined,
    apiKey,
    maxRecordMs: readMaxRecordMs(mc),
  }
}

export function toRealtimeChatConfig(config: ChatSessionConfig): ChatConfig {
  return {
    type: config.type as ChatConfig['type'],
    instructions: config.instructions,
    voiceID: config.voiceID,
    modelID: config.modelID,
    providerID: config.apiKey,
    apiKey: config.apiKey,
  }
}
