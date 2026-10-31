/**
 * mira_audio / tools.js —— 2 个 JSON 工具（返回结构按约定4）
 *
 * 设计口径：
 *   · 声音是**能力**，说话是"让页面出声"：合成在宿主完成，播放由 mira_audio 的页面播放器执行，
 *     没有页面在场就明确报 delivery/failed（不假装成功）。
 *   · 口型、气泡这些"表现"不归这里 —— muse_vtuber 订阅同一批 `say` 帧自己画。
 *   · 录音（按需取一段麦克风）归 mira_input（输入侧），这里只有 TTS / ASR / VAD 三种声音能力。
 */

import { textTool } from './kit.mjs'

const obj = (props, required = []) => ({ type: 'object', properties: props, required })
const str = (description) => ({ type: 'string', description })

export const TOOL_NAMES = ['audio_say', 'audio_status']

/**
 * @param {object} ctx
 * @param {object} deps
 * @param {object} deps.configStore
 * @param {() => object} deps.aliyun
 * @param {object} deps.hub
 * @param {object} deps.audioStore
 * @param {(cfg:object, text:string, voice?:string)=>Promise<object>} deps.speak
 * @param {() => object} deps.statusView
 * @param {object} [deps.logger]
 */
export function registerTools(ctx, deps) {
  const disposers = []

  disposers.push(ctx.tools.register(textTool(
    'audio_say',
    '让声音系统说出这句话：服务端合成语音后推给浏览器播放（形象开着时 LIVE2D 口型会跟着音量动）。没有页面连着时返回 delivery/failed（声音没地方播）。',
    obj({
      text: str('要说的话（受 tts.maxChars 限制，超长会截断并回报 truncated）'),
      voice: str('可选音色覆盖（默认用设置里的音色，如 longanhuan_v3.6）'),
    }, ['text']),
    async (args) => {
      const text = String(args?.text ?? '')
      if (text.trim() === '') {
        return { ok: false, error: { code: 'tts/failed', message: 'text 为空', hint: '传要朗读的文字' } }
      }
      const cfg = deps.configStore.current()
      if (deps.hub.clientCount === 0) {
        return {
          ok: false,
          error: {
            code: 'delivery/failed',
            message: '没有浏览器页签连着，语音没有地方播',
            hint: '打开 DSH 界面（任一页签都行，声音播放器是全局的）',
          },
        }
      }
      return deps.speak(cfg, text, String(args?.voice ?? ''))
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'audio_status',
    '只读：声音系统状态（TTS/ASR 是否启用与模型、VAD 断句参数、阿里云 key 配没配、连着的页面数、最近一次朗读）。排查「为什么它不说话/听不见」先调这个。',
    obj({}),
    async () => deps.statusView(),
  )))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.()
      } catch { /* 退场不抛 */ }
    }
  }
}

/** audio_status 的返回体（只读、可自证）。 */
export function statusView(deps) {
  const status = deps.configStore.status()
  let cfg = null
  try {
    cfg = deps.configStore.current()
  } catch { /* 已经记在 status.error 里 */ }
  const feature = deps.aliyun().status()
  return {
    ok: true,
    plugin: 'mira_audio',
    configFile: status.file,
    configError: status.error,
    configWarnings: status.warnings,
    seededFrom: status.seededFrom || '',
    // 顶层也报一个 configured：别的插件（mira_input / muse_vtuber）拿它判断"能不能开口/识别"
    configured: feature.configured === true,
    tts: feature.tts,
    asr: feature.asr,
    vad: cfg ? { ...cfg.vad } : null,
    credentials: {
      configured: feature.configured,
      file: feature.credsFile,
      mode: feature.credsMode,
      hint: feature.hint,
    },
    clients: deps.hub.clientCount,
    audio: deps.audioStore.status(),
    lastSay: deps.hub.status().lastSay || null,
    endpoints: {
      api: '/audio/api/',
      events: '/audio/api/events',
      player: '全局播放器（mira_audio 客户端，任一页签在场即可）',
    },
    counters: deps.counters ? deps.counters.snapshot() : {},
  }
}
