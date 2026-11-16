# 스택찬 사투리 🗣️

손바닥 로봇 **스택찬(M5Stack CoreS3)** 에게 5개 지역 사투리를 시켜 실시간으로 대화한 유튜브 영상에 쓴 **캐릭터 지시문(프롬프트)** 모음이에요.

ElevenLabs 대화 AI(Conversational AI) 에이전트에 붙여 넣으면 스택찬이 없어도 바로 써 볼 수 있어요.

스택찬이 있으면 `firmware/` 폴더의 펌웨어로 영상처럼 실시간 사투리 대화를 할 수 있어요. [쓰는 법 2](#쓰는-법-2-내-스택찬에서-사투리-대화하기)를 보세요.

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

## 쓰는 법 2: 내 스택찬에서 사투리 대화하기

`firmware/` 폴더에 영상에서 쓴 스택찬 펌웨어가 들어 있어요. 사투리 대화에 필요한 것만 남긴 버전이에요.

### 가장 쉬운 방법: AI 코딩 도구에게 맡기기

Claude Code 같은 AI 코딩 도구를 쓰면 설치를 대신 해 줘요. 이 저장소를 받은 폴더에서 AI에게 아래 문장을 그대로 붙여 넣으세요.

> 이 저장소(stackchan-dialects)의 README를 읽고, 내 스택찬(M5Stack CoreS3)에 사투리 대화 펌웨어를 설치해 줘. 필요한 개발 도구(Moddable SDK 8.1.1, ESP-IDF 6.0, Node.js)가 없으면 설치를 도와줘. Moddable에는 patches 폴더의 패치를 적용해 줘. 와이파이 이름·비밀번호, ElevenLabs API 키, 목소리 ID, 원하는 사투리는 나한테 물어보고, 키와 비밀번호는 화면에 출력하지 마. 플래시하기 전에 나한테 먼저 확인해 줘.

### 직접 하는 방법

**필요한 것**
- 스택찬 (M5Stack CoreS3 기반)
- 컴퓨터. 맥(Apple Silicon)에서만 시험했어요.
- [Moddable SDK](https://github.com/Moddable-OpenSource/moddable) 8.1.1과 ESP-IDF 6.0
- Node.js (npm)
- ElevenLabs 계정, API 키, 목소리 ID

**순서**

1. Moddable에 패치를 적용해요. 한국어 대화가 끊기지 않게 고친 내용이에요.
   ```bash
   cd $MODDABLE
   git apply /경로/stackchan-dialects/patches/moddable-8.1.1-elevenlabs-korean.patch
   ```
2. 펌웨어 폴더에서 필요한 패키지를 설치해요.
   ```bash
   cd /경로/stackchan-dialects/firmware
   npm install
   ```
3. 원하는 사투리를 설정 파일에 넣어요. `firmware/stackchan/manifest_local.json`이 없으면 예시 파일에서 새로 만들어요.
   ```bash
   cd /경로/stackchan-dialects
   python3 tools/apply_dialect.py yanbian --voice 내_목소리_ID
   ```
   사투리 이름: `chungcheong`(충청), `jeolla`(전라), `gyeongsang`(경상), `gangwon`(강원), `yanbian`(연변)
4. `firmware/stackchan/manifest_local.json`을 열어 `YOUR_`로 시작하는 칸을 채워요.
   - 와이파이 이름과 비밀번호
   - ElevenLabs API 키: `chatProviderID`와 `tts.token` 두 곳
   - 목소리 ID
   이 파일은 `.gitignore`에 들어 있어서 git에 올라가지 않아요. 남에게 보여 주지 마세요.
5. 스택찬을 USB로 연결하고 빌드·플래시해요. 포트 이름은 `ls /dev/cu.usbmodem*`로 확인해요.
   ```bash
   cd /경로/stackchan-dialects/firmware/stackchan
   mcconfig -m -p esp32/m5stack_cores3 manifest_local.json UPLOAD_PORT=/dev/cu.usbmodem1101
   ```
   처음 빌드는 10분 넘게 걸릴 수 있어요.
6. 스택찬이 켜지면 얼굴을 탭해서 메뉴를 열고 **Speech**를 눌러요. 연결되면 말로 대화하면 돼요. 한 번 더 누르면 대화가 끝나요.

**안 될 때**
- **화면이 꺼져 있음:** 플래시 뒤에 화면이 꺼져 있으면 전원 버튼을 눌러요.
- **Speech를 눌러도 연결이 안 됨:** API 키와 와이파이를 다시 확인해요.
- **예전에 다른 MOD를 설치했던 스택찬:** 그 MOD가 남아서 방해할 수 있어요. 아래 명령으로 MOD 영역을 지운 뒤 다시 켜요.
  ```bash
  esptool --chip esp32s3 -p /dev/cu.usbmodem1101 erase-region 0xfa0000 0x40000
  ```

**시험한 환경:** Moddable SDK 8.1.1 + 이 저장소의 패치, ESP-IDF 6.0, macOS(Apple Silicon), 새 스택찬(M5Stack CoreS3) 한 대. 다른 환경에서는 시험하지 않았어요.

### 펌웨어에 들어 있는 것 / 뺀 것

- **들어 있는 것:**
  - ElevenLabs 대화
  - 대화가 끝나면 정리하고 끊기면 다시 연결하는 기능
  - 대화 중 화면 부담 줄이기
  - 고개 돌리기
  - 시간 알려 주기
  - 얼굴·표정 바꾸기 버튼
- **뺀 것:** 영상 제작자 개인용으로 만든 기능들이에요.
  - 맥 연동, 존재 센서
  - 기억, 알람, 가전 제어
  - 개인 그림과 효과음
- **원본:** 이 펌웨어는 [스택찬 공식 펌웨어](https://github.com/stack-chan/stack-chan)를 고쳐 만든 거예요.

### Moddable 패치가 바꾸는 것

- 마이크 입력 8kHz, 스피커 출력 16kHz
- 에이전트 언어를 한국어(`ko`)로 고정
- 말이 끝나면 더 빨리 대답하게 설정 (`turn_eagerness: eager`)
- 대답 중간에 말이 끊기는 문제 수정: 소리가 1.5초 동안 안 올 때만 차례를 넘김
- 출력 버퍼 128KB, 작업용 메모리(nativeStack) 16KB
- 소리 상태를 1초마다 로그로 찍는 줄 (`[ChatAudio] ...`)

## 목소리

영상에서는 지역마다 따로 만든 목소리를 썼어요. 그 목소리는 이 저장소에 들어 있지 않아요. 각자 ElevenLabs에서 어울리는 목소리를 고르거나 만들어 쓰세요.

## 알아 둘 점

- **코미디 영상용이에요.** 각 지시문의 `[상황극]` 부분은 욕, 협박, 깡패, 보이스피싱 상담원 같은 상황극을 거절하지 말라고 되어 있어요. 영상에서 삐 처리하는 걸 전제로 만든 거예요. 필요 없으면 `[상황극]` 줄을 지우세요.
- 실제 은행 이름, 전화번호, 사이트 주소는 지어내지 말라는 규칙이 들어 있어요.
- 특정 지역이나 집단을 깎아내리지 말라는 규칙도 들어 있어요.
- **사투리가 정확한지는 토박이 검수를 받지 않았어요.** 어색한 표현이 있으면 이슈로 알려 주세요.
- 지시문을 넣어도 AI가 가끔 표준어를 섞을 수 있어요.

## 라이선스

- 지시문, 설명서, `tools/`: [MIT](LICENSE) © 방구석 테크랩
- `firmware/`: 스택찬 공식 펌웨어를 고친 것이라 원래 라이선스(Apache-2.0)를 따라요. [firmware/LICENSE](firmware/LICENSE)
- `patches/`: Moddable SDK 파일을 고친 것이라 원래 라이선스(LGPL-3.0)를 따라요.
- 자세한 내용은 [THIRD_PARTY.md](THIRD_PARTY.md)를 보세요.

---

## English summary

Character prompts that make an ElevenLabs Conversational AI agent speak five Korean regional dialects: Chungcheong, Jeolla, Gyeongsang, Gangwon and Yanbian. They were used on a Stack-chan robot (M5Stack CoreS3) for a YouTube video.

- **Using the prompts:** paste a file from `prompts/` into an agent's system prompt and set the language to Korean.
- **Firmware:** `firmware/` is a trimmed Stack-chan firmware (Apache-2.0) for dialect chat on M5Stack CoreS3. Apply the Moddable patch, run `python3 tools/apply_dialect.py <dialect> --voice <id>`, fill in Wi-Fi and the ElevenLabs key in `firmware/stackchan/manifest_local.json`, then build with `mcconfig -m -p esp32/m5stack_cores3 manifest_local.json`. Tested only on Moddable 8.1.1 + ESP-IDF 6.0 on macOS with one CoreS3 Stack-chan.
- **Moddable patch:** `patches/` holds a patch for Moddable SDK 8.1.1 `chatAudioIO`. It sets 8 kHz input, 16 kHz output, Korean language and eager turn-taking, and ends a turn only after 1.5 s without audio. It was tested only on CoreS3.
- **Roleplay blocks:** the prompts allow comedic roleplay, including swearing and scam-call parody, because the video bleeps those parts. Remove the `[상황극]` line if you don't want this.
- **License:** prompts, docs and tools are MIT. `firmware/` is Apache-2.0 (from Stack-chan). The patch follows Moddable's LGPL-3.0.
