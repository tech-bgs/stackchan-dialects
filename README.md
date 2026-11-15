# 스택찬 사투리 🗣️

손바닥 로봇 **스택찬(M5Stack CoreS3)** 에게 5개 지역 사투리를 시켜 실시간으로 대화한 유튜브 영상에 쓴 **캐릭터 지시문(프롬프트)** 모음이에요.

ElevenLabs 대화 AI(Conversational AI) 에이전트에 붙여 넣으면 스택찬이 없어도 바로 써 볼 수 있어요.

## 지역별 캐릭터

| 지역 | 캐릭터 | 말투 예시 | 파일 |
|---|---|---|---|
| 충청도 | 느긋하게 칭찬처럼 돌려 까는 "돌려 까기" 장인 | ~유, ~해유, 그려, 몰러 | [prompts/chungcheong.txt](prompts/chungcheong.txt) |
| 전라도 | 정 많고 잔소리 많은 동네 이모·삼촌 | 아따, 워메, 겁나게, ~당께 | [prompts/jeolla.txt](prompts/jeolla.txt) |
| 경상도 | 퉁명스럽지만 속으로 챙기는 츤데레 | 마!, 아이가!, 그랬나!, ~노? | [prompts/gyeongsang.txt](prompts/gyeongsang.txt) |
| 강원도 | 순박하고 겁 많은 감자·옥수수 사랑 | ~드래요, 마이 무서워, 감재 | [prompts/gangwon.txt](prompts/gangwon.txt) |
| 연변 | 느와르 영화 속 조직 큰형님 | ~슴다, ~슴까?, 일 없슴다, 뭐이라니? | [prompts/yanbian.txt](prompts/yanbian.txt) |

다섯 개를 한 파일에 모은 것도 있어요: [dialect-prompts.json](dialect-prompts.json)

## 만들면서 알게 된 것

말투를 정하는 건 결국 **지시문에 쓴 사투리 문장**이었어요.

- 처음 만든 경상도·강원도는 표준어가 자꾸 섞여서 실패했어요.
- 그래서 지시문을 이렇게 다시 썼어요.
  - **꼭 써야 하는 말끝:** ~노?, ~드래요, ~슴다 등
  - **쓰면 안 되는 표준어 말끝:** ~요, ~습니다 등
  - **그 지역에서 자주 쓰는 단어**
  - **예시 대답 여러 개**
- "설명해 달라"는 질문에도 사투리로 답하라는 규칙을 넣어야 했어요. 이 규칙이 없으면 설명할 때 표준어로 돌아가요.

## 쓰는 법 1: ElevenLabs 대시보드 (가장 쉬움)

1. ElevenLabs에 로그인해서 대화 AI(Agents) 메뉴로 가요.
2. 새 에이전트를 만들어요.
3. 시스템 프롬프트(System prompt) 칸에 `prompts/` 폴더의 지역 파일 내용을 통째로 붙여 넣어요.
4. 언어를 한국어로 정해요.
5. 마음에 드는 목소리를 골라요.
6. 테스트 버튼으로 말을 걸어 봐요.

메뉴 이름은 ElevenLabs 화면이 바뀌면 다를 수 있어요.

## 쓰는 법 2: 스택찬 / Moddable SDK

영상에서는 Moddable SDK의 `chatAudioIO` 모듈(`elevenLabsAgent`)로 스택찬과 ElevenLabs를 연결했어요.

- 지시문은 `instructions` 값에 넣어요.
- 목소리 ID는 `voiceID` 값에 넣어요.
- 사용법은 Moddable의 [chatAudioIO 설명서](https://github.com/Moddable-OpenSource/moddable/blob/public/modules/network/services/chatAudioIO/readme.md)를 보세요.

### Moddable 수정 패치 (선택)

한국어 대화가 더 잘 되도록 Moddable 파일 두 개를 고쳐서 썼어요. 수정 내용은 [patches/moddable-8.1.1-elevenlabs-korean.patch](patches/moddable-8.1.1-elevenlabs-korean.patch)에 있어요.

**바뀌는 것:**
- 마이크 입력 8kHz, 스피커 출력 16kHz
- 에이전트 언어를 한국어(`ko`)로 고정
- 말이 끝나면 더 빨리 대답하게 설정 (`turn_eagerness: eager`)
- 대답 중간에 말이 끊기는 문제 수정: 소리가 1.5초 동안 안 올 때만 차례를 넘김
- 출력 버퍼 128KB, 작업용 메모리(nativeStack) 16KB
- 소리 상태를 1초마다 로그로 찍는 줄 (`[ChatAudio] ...`): 문제 찾을 때 쓴 것이라 지워도 돼요

**적용 방법** (Moddable 폴더에서):

```bash
cd $MODDABLE
git apply /경로/stackchan-dialects/patches/moddable-8.1.1-elevenlabs-korean.patch
```

Moddable SDK 8.1.1 + M5Stack CoreS3에서만 써 봤어요. 다른 버전과 기기에서는 시험하지 않았어요.

## 목소리

영상에서는 지역마다 따로 만든 목소리를 썼어요. 그 목소리는 이 저장소에 들어 있지 않아요. 각자 ElevenLabs에서 어울리는 목소리를 고르거나 만들어 쓰세요.

## 알아 둘 점

- **코미디 영상용이에요.** 각 지시문의 `[상황극]` 부분은 욕, 협박, 깡패, 보이스피싱 상담원 같은 상황극을 거절하지 말라고 되어 있어요. 영상에서 삐 처리하는 걸 전제로 만든 거예요. 필요 없으면 `[상황극]` 줄을 지우세요.
- 실제 은행 이름, 전화번호, 사이트 주소는 지어내지 말라는 규칙이 들어 있어요.
- 특정 지역이나 집단을 깎아내리지 말라는 규칙도 들어 있어요.
- **사투리가 정확한지는 토박이 검수를 받지 않았어요.** 어색한 표현이 있으면 이슈로 알려 주세요.
- 지시문을 넣어도 AI가 가끔 표준어를 섞을 수 있어요.

## 라이선스

- 지시문, 설명서: [MIT](LICENSE) © 방구석 테크랩
- `patches/` 폴더의 패치: Moddable SDK 파일을 고친 것이라 원래 라이선스(LGPL-3.0)를 따라요. [THIRD_PARTY.md](THIRD_PARTY.md)를 보세요.

---

## English summary

Character prompts that make an ElevenLabs Conversational AI agent speak five Korean regional dialects: Chungcheong, Jeolla, Gyeongsang, Gangwon and Yanbian. They were used on a Stack-chan robot (M5Stack CoreS3) for a YouTube video.

- **Using the prompts:** paste a file from `prompts/` into an agent's system prompt and set the language to Korean.
- **Optional Moddable patch:** `patches/` holds a patch for Moddable SDK 8.1.1 `chatAudioIO`. It sets 8 kHz input, 16 kHz output, Korean language and eager turn-taking, and ends a turn only after 1.5 s without audio. It was tested only on CoreS3.
- **Roleplay blocks:** the prompts allow comedic roleplay, including swearing and scam-call parody, because the video bleeps those parts. Remove the `[상황극]` line if you don't want this.
- **License:** prompts and docs are MIT. The patch follows Moddable's LGPL-3.0.
