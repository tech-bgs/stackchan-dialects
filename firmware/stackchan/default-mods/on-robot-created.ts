// @ts-nocheck
import { DogFace, ImageFace, SimpleFace } from 'behaviors/face'
import { createChatSession } from 'default-mods/chat-session'
import { clearChatStatusLed } from 'default-mods/chat-status-led'
import type { StackchanMod } from 'default-mods/mod'
import { Emoticon, type EmoticonKey } from 'effects/emoticon'
import { Emotion } from 'face-context'
import type { Content as PiuContent } from 'piu/MC'

// Dialect chat build: only the conversation feature and a few face buttons.
export const onRobotCreated: StackchanMod['onRobotCreated'] = (robot) => {
  const emotions = [Emotion.HAPPY, Emotion.ANGRY, Emotion.SAD, Emotion.HOT, Emotion.SLEEPY, Emotion.NEUTRAL]
  let emotionIndex = 0
  let emoticonEffect: PiuContent | null = null

  let faceMode: 'simple' | 'dog' | 'image' = 'simple'
  const syncFaceMode = (
    app = robot.renderer?.application as { distribute?: (event: string, payload: unknown) => void } | undefined,
  ) => {
    robot.application.setDrawerButtonState('toggleFace', faceMode !== 'simple')
    app?.distribute?.('onFaceMode', faceMode)
  }
  const closeDrawer = () =>
    (robot.renderer?.application as { distribute?: (event: string) => void } | undefined)?.distribute?.('onDrawerClose')
  const createCurrentFace = () =>
    faceMode === 'dog' ? new DogFace({}) : faceMode === 'image' ? new ImageFace({}) : new SimpleFace({})

  clearChatStatusLed(robot)
  const chatSession = createChatSession(robot, {
    drawerButtonKey: 'toggleSpeech',
    chatConfig: robot.config,
  })

  robot.application.addDrawerButton({
    key: 'toggleSpeech',
    label: 'Speech',
    kind: 'toggle',
    initialState: false,
    callback: () => {
      trace('[onRobotCreated] toggleSpeech pressed\n')
      if (!chatSession) {
        trace('[onRobotCreated] chat not configured (set chatType and chatProviderID)\n')
        return
      }
      chatSession.toggle()
      closeDrawer()
    },
  })

  robot.application.addDrawerButton({
    key: 'toggleFace',
    label: 'Face',
    kind: 'toggle',
    initialState: false,
    callback: (target) => {
      faceMode = faceMode === 'simple' ? 'dog' : faceMode === 'dog' ? 'image' : 'simple'
      target.renderer?.setFace?.(createCurrentFace())
      const app = target.renderer?.application as { distribute?: (event: string, payload: unknown) => void } | undefined
      syncFaceMode(app)
    },
  })
  syncFaceMode()

  robot.application.addDrawerButton({
    key: 'cycleEmotion',
    label: 'Emotion',
    callback: (target) => {
      emotionIndex = (emotionIndex + 1) % emotions.length
      const nextEmotion = emotions[emotionIndex]
      target.setEmotion(nextEmotion)
      if (emoticonEffect) {
        target.renderer?.removeDecorator(emoticonEffect)
        emoticonEffect = null
      }
      const emotionKeyMap: Record<Emotion, EmoticonKey | null> = {
        [Emotion.HAPPY]: 'heart',
        [Emotion.ANGRY]: 'angry',
        [Emotion.SAD]: 'tear',
        [Emotion.HOT]: 'sweat',
        [Emotion.SLEEPY]: 'sleepy',
        [Emotion.NEUTRAL]: null,
        [Emotion.DOUBTFUL]: null,
        [Emotion.COLD]: null,
      }
      const key = emotionKeyMap[nextEmotion]
      if (key) {
        emoticonEffect = new Emoticon({ key, name: 'emotion' })
        target.renderer?.addDecorator(emoticonEffect)
      }
    },
  })

  trace('[onRobotCreated] dialect chat ready\n')
}
