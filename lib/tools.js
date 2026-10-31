/**
 * mira_media / tools.js —— 1 个 JSON 工具（返回结构按约定4）
 *
 * 设计口径：
 *   · 2.0.0 起本插件是**纯能力**：合成只回字节，不播放；说话（播放）搬到 mira_device。
 *   · 识图保留（`miraMedia.describeImage`），给 mira_device 的自动推帧用。
 *   · 录音归 mira_device，这里只有 TTS / ASR / VAD / 识图。
 */

import { textTool } from './kit.mjs'

const obj = (props, required = []) => ({ type: 'object', properties: props, required })
const str = (description) => ({ type: 'string', description })

export const TOOL_NAMES = ['media_status']

/**
 * @param {object} ctx
 * @param {object} deps
 * @param {object} deps.configStore
 * @param {() => object} deps.aliyun
 * @param {() => object} deps.statusView
 * @param {object} [deps.logger]
 */
export function registerTools(ctx, deps) {
  const disposers = []

  disposers.push(ctx.tools.register(textTool(
    'media_status',
    '只读：声音系统状态（TTS/ASR 是否启用与模型、VAD 断句参数、阿里云 key 配没配）。排查「为什么它不说话/听不见」先调这个。',
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

/** media_status 的返回体（只读、可自证）。 */
export function statusView(deps) {
  const status = deps.configStore.status()
  let cfg = null
  try {
    cfg = deps.configStore.current()
  } catch { /* 已经记在 status.error 里 */ }
  const feature = deps.aliyun().status()
  return {
    ok: true,
    plugin: 'mira_media',
    configFile: status.file,
    configError: status.error,
    configWarnings: status.warnings,
    seededFrom: status.seededFrom || '',
    // 顶层也报一个 configured：别的插件（mira_device / muse_vtuber）拿它判断"能不能开口/识别"
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
    endpoints: {
      api: '/media/api/',
    },
    counters: deps.counters ? deps.counters.snapshot() : {},
  }
}
