# NOTICE

This folder is a modified copy of the Stack-chan firmware
(https://github.com/stack-chan/stack-chan), licensed under the Apache License 2.0.
See LICENSE in this folder.

Modifications by 방구석 테크랩 (2026):

- Added an ElevenLabs Conversational AI chat session for M5Stack CoreS3
  (`stackchan/services/chat-service.ts`, `stackchan/default-mods/chat-*.ts`,
  `stackchan/utilities/loadChatConfig.ts`) with session release, reconnect and
  reduced screen load during chat.
- Replaced `stackchan/default-mods/on-robot-created.ts` with a small version that
  only sets up the chat (Speech), face and emotion buttons.
- Fixes for the M5Stack CoreS3 Stack-chan body (PY32 LED/servo power handling) and
  other changes made while building the video project, including camera/photo code
  that is not used by the dialect chat.
- Removed personal features (home server links, presence sensor, memory, alarms,
  appliance control) and personal image/sound assets.
