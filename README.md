# mira_audio — DSH 的「声音」

三件套里的**第 1 件**：语音合成（TTS）/ 语音识别（ASR）/ 断句（VAD 切分），并且是**唯一**
保存阿里云凭据的地方。别的插件（`mira_input` 采集、`muse_vtuber` 形象，以及以后的任何插件）
`inject: ['miraAudio']` 就能用，不需要再存一份 key。

```
muse_vtuber ──┐
              ├─→ mira_input ──→ mira_audio        （箭头 = "依赖"）
muse_galaxy ──┘   （输入/采集口）  （TTS/ASR/VAD/凭据）
```

- 版本：**1.0.0**（2026-11-01 从 `muse_vtuber` 3.1.0 拆出）
- 位置：`PluginDSH/mira_audio`
- 依赖：**零第三方依赖**（只用 `node:` 内置 + 浏览器 API）

---

## 1. 它负责什么

| 能力 | 落地 |
|---|---|
| 语音合成 | `POST {tts.base}/services/audio/tts/SpeechSynthesizer`（原生口，默认 qwen-audio-tts）或 `POST {tts.base}/audio/speech`（`tts.provider=openai`） |
| 语音识别 | `POST {asr.base}/services/aigc/multimodal-generation/generation`（原生口，吃 base64）或 `POST {asr.base}/audio/transcriptions`（兼容口，multipart） |
| 断句（VAD） | `lib/vad.js`：16bit 单声道 PCM → 一句一句的 WAV（阈值/静音/最短/最长）。**切分器借给输入侧用**（`createSegmenter`） |
| 凭据 | 阿里云 key 只在这里（`creds/dashscope.json`，600）。识图也用同一份 key（`describeImage`） |
| 播放 | 页面侧一个**全局播放器**（不占槽位）：任一页签在场就能出声；形象只订阅播放状态对口型 |
| 设置页 | `settings.section` → **「声音」**：TTS / ASR / VAD / API key |

它**不负责**：录音、摄像头、画面识别（这些是 `mira_input`）；插话（steer）也不在这里——
"要不要把识别结果变成会话里的一条消息"是感知生产者的策略。

## 2. 落盘（约定1 / 约定3 / 约定7）

```
$DSH_HOME/mira_config/mira_audio/          # DSH_HOME 缺省 ~/.dsh
  config.json             配置（schemaVersion 1）。唯一会自动创建的文件
  creds/dashscope.json    阿里云 API key（600，永不回显、不进日志）
  ...（capture 令牌等不在这里：采集口属于 mira_input）
```

写盘一律「临时文件 → fsync → rename → fsync 目录」（`lib/kit.mjs` 的 `writeJsonAtomic`）。
**热生效**：`config.json` 内容变了，下一次读取就重新加载（约定9）；换代码仍需重启宿主。

## 3. 配置表（默认值全部在此）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` = 不注册工具与路由 |
| `tts.enabled` | `true` | 关掉后 `audio_say` 报 `config/missing` |
| `tts.provider` | `aliyun` | `aliyun` = 原生口（`/services/audio/tts/SpeechSynthesizer`，实测可用）；`openai` = `/audio/speech`。**base 要跟着选** |
| `tts.base` | `https://token-plan.maas.qianwenaiapi.com/api/v1` | 原生口用 `api/v1`，兼容口用 `compatible-mode/v1` |
| `tts.model` | `qwen-audio-3.0-tts-plus` | |
| `tts.voice` | `longanhuan_v3.6` | Qwen-Audio-TTS 的音色是 `longan*` 系列 |
| `tts.maxChars` | `600` | 单次最长字数（按**码点**截断，不劈 emoji），截断回报 `truncated` |
| `tts.timeoutMs` | `30000` | 原生口含一次音频 URL 下载 |
| `asr.enabled` | `true` | |
| `asr.provider` | `aliyun` | 原生口 / `openai` 兼容口 |
| `asr.base` | 同 `tts.base` | |
| `asr.model` | `qwen-audio-3.0-asr-flash` | |
| `asr.language` | `zh` | 原生口作 `language_hints:[lang]`，兼容口作 multipart 字段 |
| `asr.timeoutMs` | `30000` | |
| `vad.threshold` | `0.02` | 断句电平阈值（RMS，0..1），越大越不灵敏 |
| `vad.silenceMs` | `650` | 停顿多久算一句说完 |
| `vad.minSpeechMs` | `320` | 太短的杂音不送识别 |
| `vad.maxMs` | `15000` | 一句最长时长，超了强制切段 |

> **约定2**：API key 是唯一必填项，没有默认、不自动探测。没配时工具返回
> `creds/missing` 并指到「设置 · 声音」。

## 4. 工具（2 个）

| 工具 | 干什么 | 失败长什么样 |
|---|---|---|
| `audio_say` | 合成并让**页面出声**（形象开着时 LIVE2D 口型跟着音量动）。文本受 `tts.maxChars` 限制 | 没页面 → `delivery/failed`（声音没地方播）；没 key → `creds/missing`；空文本 → `tts/failed` |
| `audio_status` | 只读：TTS/ASR 模型、VAD 参数、key 配没配、连着的页面数、最近一次朗读、计数 | 永不失败（配置坏了也报 `configError`） |

> 说话的工具在 `mira_audio`、不在形象插件里 —— 这是拆分时用户明确的口径
> （「各自的能力归各自的插件」）。形象只负责让嘴动。

## 5. 服务契约（别的插件怎么用）

`ctx.provide('miraAudio', api)`，`inject: ['miraAudio']` 后：

```js
miraAudio.version
miraAudio.status()                     // 只读状态（含 configured / tts / asr / vad / credsFile）
miraAudio.synthesize(text, { voice })  // → { mime, base64, bytes, chars, truncated, voice, model }（不播放）
miraAudio.transcribe({ base64, mime, sampleRate })  // → { text, model }
miraAudio.describeImage({ dataUrl, base, model, prompt, timeoutMs })  // 同一份 key 的网关能力
miraAudio.say(text, { voice })         // 合成 + 广播 → { url, chars, clients, delivered, ... }
miraAudio.vad()                        // { threshold, silenceMs, minSpeechMs, maxMs }
miraAudio.createSegmenter({ vad?, sampleRate, maxAudioMs, onUtterance })  // PCM 断句器
miraAudio.pcmToWav(pcm, sampleRate) / miraAudio.pcmRms(pcm)
miraAudio.player()                     // { clients }（0 = 没页面，合成得出来但没地方播）
miraAudio.publicConfig() / miraAudio.settingsView()
```

`describeImage` 的 base/model 由调用方决定（`mira_input` 的 `vision.*`），因为"看什么图用哪个
模型"是输入侧的配置；**key 不出这个插件**。

## 5.1 指向本机 stream 网关（没有云端 key 也能出声；本机当前**不用**这条路，作备选）

同一个 `openai` 口就能对接本机的 **stream 统一能力网关**（`stream-gateway.service`，
`http://127.0.0.1:11089`，它把 TTS 交给本地 CosyVoice3、ASR 交给本地三路融合）：

```jsonc
// $DSH_HOME/mira_config/mira_audio/config.json
{
  "tts": { "provider": "openai", "base": "http://127.0.0.1:11089/v1", "model": "stella", "voice": "rosy" },
  "asr": { "provider": "openai", "base": "http://127.0.0.1:11089/v1", "model": "stella", "language": "zh" }
}
```

- **key**：填网关的 `GATEWAY_API_KEYS`（就在 `~/.config/stream-gateway.env`，600；
  本插件一样只把它写进自己的 `creds/dashscope.json`，不回显）。
- 依赖：`stream-gateway.service` 在跑，**并且** `cosyvoice3.service` 在跑（:8204，本地 TTS；
  它不在时网关的 `/v1/audio/speech` 会 503 `cosyvoice3 unavailable`）。ASR 依赖 `8208`。
- 返回：`/v1/audio/speech` 是 **WAV 二进制**（`audio/wav`），本插件按 content-type 存 mime，
  `<audio>` 直接能播；`/v1/audio/transcriptions` 是 multipart，回 `{text, emotion, segments…}`。
- 音色：网关重启后可用的是它 `providers/voices/` 里的那些（本机实测 `rosy` / `mira` / `muse` / `hana`；
  doc 里的 `rosy_fix` 是旧名字）。`GET /v1/models` 只列 `stella` / `sylvia`。
- **代价**：这条路的识图仍是另一回事（网关没有 OpenAI 兼容的"看图"端点，图的本地能力在
  `/v2/image/select`）；所以 `mira_input` 的自动推帧（`vision.provider=aliyun`）仍然要云端 key，
  而 `input_look` 的默认 `dsh` 模式不依赖任何 key。

## 6. HTTP 面（`/audio/api/*`，全部同源校验）

| 方法与路径 | 作用 |
|---|---|
| `GET /audio/api/bootstrap` | 配置（脱敏）、能力/凭据就绪、VAD、endpoints |
| `GET /audio/api/events` | **SSE**：`hello` / `say`（`{ text, url, id, mime, chars, truncated, voice }`） |
| `POST /audio/api/say` | `{ text, voice? }` → 合成 → 广播 `say` |
| `POST /audio/api/asr` | `{ base64, mime, sampleRate }` → 识别 → **只回文本**（插话由输入侧决定） |
| `GET /audio/api/audio/<id>` | 合成好的音频（内存 32 条 / 10 分钟） |
| `GET/POST /audio/api/settings` | 设置页读写；GET **永不回 key**，只回 `keyConfigured` |
| `GET /audio/api/health` | 存活探针（客户端数、TTS/ASR 开关、VAD、音频缓存） |

**同源守卫**：`Sec-Fetch-Site: cross-site` 或 `Origin` 与 `Host` 不同源一律 403。

## 7. 页面全局契约（给形象/别的插件用）

`lib/client.js` 在页面里挂一个全局对象（播放器 + 电平），`muse_vtuber` 靠它画口型/频谱环：

```js
window.__miraAudio__ = {
  version, state(), subscribe(fn),   // state: { ready, speaking, level, text, url, error }
  level(), analyser(), play(url), ready(),
}
```

为什么用页面全局而不是 `import`：插件各自独立打包，跨包 import 在 `link:` 安装下不可靠；
页面全局是唯一稳定的交接点。**声音只播一遍**：形象不自己播音频，只读 `state().level`。

浏览器自动播放策略：首次播放被拦时会把 URL 挂起，并在**第一次点击/按键**时补播
（`armGestureUnlock`）。

## 8. 迁移（从旧 `muse_vtuber`）

1. **配置**：本插件第一次创建 `config.json` 时，会从
   `$DSH_HOME/mira_config/muse_vtuber/config.json` 里读 `tts` / `asr` / `mic.vad` 作为基线
   （只读旧文件、不删不改）。`settingsView.seededFrom` 会写明是否迁移过。
2. **凭据**：新目录没有 `creds/dashscope.json`、旧目录有时，自动复制一份（600，旧文件保留）。
3. **老配置里的键**（`camera` / `vision` / `events` …）不会被本插件读取；它们分别属于
   `mira_input`，或留在旧文件里不再使用（README 在 `muse_vtuber` 里写明了这一点）。
4. 回滚：停用 `mira_audio` 即可；旧 `muse_vtuber` 的配置与凭据原样未动。

## 9. 已知取舍

1. **TTS 音频只放内存**（32 条 / 10 分钟），不落盘 —— 不在 `mira_config` 里堆音频文件。
2. **VAD 阈值住在声音插件**，输入侧只是"借"：改阈值只有一个地方（「设置 · 声音」）。
3. **播放器是全局的**（不占槽位）：只要有一个页面连着就能出声；多个页面同时在场时**同时出声**
   （浏览器行为，不是 bug）。只想一端出声就在那端静音。
4. **识图能力也在这里**：它和 TTS/ASR 共用一个网关与一份 key；但"用哪个模型、看哪张图"由
   调用方（`mira_input`）决定。
5. 供应商形状差异（原生口 vs OpenAI 兼容口）已经写死在 `lib/aliyun.js` 里，并在
   `status()` 里回报实际用的 model/base，排障不用猜。

## 10. 验收

```
node test/smoke.mjs                 # → ALL PASS（通过 35 项断言），退出 0
node ..\tool_shared\tools\check-zero-dep.mjs mira_audio
node ..\tool_shared\tools\check-kit.mjs
```

手工：

| # | 步骤 | 期望 |
|---|---|---|
| 1 | 设置 · 声音 → 填 API key → 保存 | 提示"API key 已写入 600 凭据文件"；`audio_status.credentials.configured=true` |
| 2 | 点「试听」 | 页面出声（先说一句「声音连接正常，我是星辉澪。」）；没声音时先点一下页面（浏览器自动播放策略） |
| 3 | 让模型调 `audio_say {text:"..."}` | 出声；形象开着时口型跟着音量动 |
| 4 | 把 `vad.silenceMs` 改成 1200 再说话 | 断句变迟钝（停顿更久才算一句） |
| 5 | 故意写错 key | `audio_say` 报 `tts/failed`，文案里 key 被抹成 `***` |
