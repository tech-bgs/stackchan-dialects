// @ts-nocheck
import { loadChatSessionConfig, type ChatSession, type ChatSessionConfig } from 'default-mods/chat-config'
import { createRealtimeChatSession } from 'default-mods/chat-session-realtime'
import Modules from 'modules'
import type { Robot } from 'robot'

export type { ChatSession } from 'default-mods/chat-config'

type ChatSessionOptions = {
  drawerButtonKey?: string
}

type OpenAIChatSessionModule = {
  createOpenAIChatSession: (robot: Robot, chatConfig: ChatSessionConfig, options?: ChatSessionOptions) => ChatSession
}

export function createChatSession(robot: Robot, options: ChatSessionOptions = {}): ChatSession | null {
  const chatConfig = loadChatSessionConfig()
  if (!chatConfig) return null

  trace(
    `[ChatSession] loaded chatType=${chatConfig.type} modelID=${chatConfig.modelID ?? '(unset)'} maxRecordMs=${chatConfig.maxRecordMs}\n`,
  )

  if (chatConfig.type === 'openAI') {
    const mod = Modules.importNow('default-mods/chat-session-openai') as OpenAIChatSessionModule
    return mod.createOpenAIChatSession(robot, chatConfig, options)
  }

  return createRealtimeChatSession(robot, chatConfig, options)
}
