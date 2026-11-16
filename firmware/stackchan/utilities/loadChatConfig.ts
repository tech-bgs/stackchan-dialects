// @ts-nocheck
import type { ChatConfig } from 'chat-service'
import loadPreferences from 'loadPreference'
import config from 'mc/config'
import Modules from 'modules'

type ConfigRecord = Record<string, unknown>

function readString(source: ConfigRecord | undefined, key: string): string | undefined {
  if (!source) return undefined
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readLegacyNested(source: ConfigRecord | undefined): Partial<ChatConfig> {
  if (!source) return {}
  const section = source.chat
  if (!section || typeof section !== 'object') return {}
  const record = section as ConfigRecord
  return {
    type: readString(record, 'type') as ChatConfig['type'] | undefined,
    instructions: readString(record, 'instructions'),
    voiceID: readString(record, 'voiceID'),
    providerID: readString(record, 'providerID'),
    modelID: readString(record, 'modelID'),
  }
}

function readFlat(source: ConfigRecord | undefined): Partial<ChatConfig> {
  if (!source) return {}
  return {
    type: (readString(source, 'chatType') ?? readString(source, 'realtimeChatType')) as ChatConfig['type'] | undefined,
    instructions: readString(source, 'chatInstructions') ?? readString(source, 'realtimeChatInstructions'),
    voiceID: readString(source, 'chatVoiceID') ?? readString(source, 'realtimeChatVoiceID'),
    providerID: readString(source, 'chatProviderID') ?? readString(source, 'realtimeChatProviderID'),
    modelID: readString(source, 'chatModelID') ?? readString(source, 'realtimeChatModelID'),
  }
}

function mergeChatConfig(host: ConfigRecord, mod: ConfigRecord): Partial<ChatConfig> {
  return {
    ...readLegacyNested(host),
    ...readLegacyNested(mod),
    ...readFlat(host),
    ...readFlat(mod),
  }
}

export default function loadChatConfig(): Partial<ChatConfig> {
  const host = config as ConfigRecord
  const mod: ConfigRecord = Modules.has('mod/config') ? (Modules.importNow('mod/config') as ConfigRecord) : {}
  const merged = mergeChatConfig(host, mod)

  if (!merged.providerID) {
    merged.providerID = readString(host, 'openAIKey')
  }
  if (!merged.apiKey) {
    merged.apiKey = merged.providerID
  }
  if (!merged.providerID) {
    const ttsPrefs = loadPreferences('tts')
    if (typeof ttsPrefs.token === 'string' && ttsPrefs.token.length > 0) {
      merged.providerID = ttsPrefs.token
    }
  }

  return merged
}
