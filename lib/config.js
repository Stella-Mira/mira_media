/**
 * mira_media / config.js —— 「声音」插件的配置：默认值 + 规整 + 落盘（config.json，schemaVersion 1）
 *
 * 两条来源（与 mira_live2d / muse_vtuber 同口径）：
 *   · cordis patch 里的 config：宿主启动时给的一份基线（升级时会被覆盖的那层）；
 *   · `$DSH_HOME/mira_config/mira_media/config.json`：**权威值**，设置页保存就写这里，热生效。
 * 文件不存在时按「配置 → 内置默认」原子写一份出来（README 里写明这是唯一会自动创建的文件）。
 *
 * 这个插件是三件套里唯一持有**阿里云凭据**的：TTS / ASR / 识图共用一个网关与一份 key。
 * 识图的 base/model 在 mira_device 的配置里（它决定"看什么"），key 只在这里（谁也别再存一份）。
 *
 * 约定2（显式优先）：这里只给「只影响效果与性能」的项兜底默认值，并且每一个默认值都写进
 * README 的配置表；必填项（API key）一律不给默认，缺了就是 creds/missing + 去哪填。
 * 约定7（配置版本）：schemaVersion 不匹配 → 保留原文件、拒绝使用、给迁移提示，不静默兼容。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  MiraError, checkSchema, deepMerge, ensureDir, miraConfigDir, writeJsonAtomic,
} from './kit.mjs'

export const CONFIG_SCHEMA = 1

/**
 * 默认供应商入口（与旧 muse_vtuber 一致，用户口径 2026-10-29）：token-plan 的 MaaS 网关。
 *   compatible-mode/v1  OpenAI 兼容口：/audio/speech（合成）、/audio/transcriptions（识别）
 *   api/v1             阿里云原生口：/services/audio/tts/SpeechSynthesizer、
 *                                    /services/aigc/multimodal-generation/generation
 * 想换回官方 DashScope：把 base 换成 dashscope.aliyuncs.com 的对应前缀即可。
 */
const QWEN_API = 'https://token-plan.maas.qianwenaiapi.com/api/v1'

export const DEFAULTS = {
  enabled: true,
  // 语音合成：任何 OpenAI 兼容的 POST {base}/audio/speech 都能用，默认阿里云 qwen-tts。
  //   aliyun（实测可用）= POST {base}/services/audio/tts/SpeechSynthesizer
  //   openai            = POST {base}/audio/speech（直接回音频字节）
  tts: {
    enabled: true,
    provider: 'aliyun',
    base: QWEN_API,
    model: 'qwen-audio-3.0-tts-plus',
    // Qwen-Audio-TTS 的音色是 longan* 系列（不是 CosyVoice 的 Cherry/Serena）
    voice: 'longanhuan_v3.6',
    maxChars: 600,
    timeoutMs: 30000,
  },
  // 语音识别。provider：
  //   aliyun（实测可用）= POST {base}/services/aigc/multimodal-generation/generation
  //   openai            = POST {base}/audio/transcriptions（multipart 上传 WAV）
  asr: {
    enabled: true,
    provider: 'aliyun',
    base: QWEN_API,
    model: 'qwen-audio-3.0-asr-flash',
    language: 'zh',
    timeoutMs: 30000,
  },
  /**
   * VAD 切分（"一句话"的判定）。所有输入侧（浏览器麦克风、外部采集器 PCM）都用这一份：
   * 切分属于声音能力，不属于"从哪里进来"，所以它住在 mira_media。
   * 数值语义：threshold 是 16bit PCM 归一化后的 RMS；毫秒项都是人话。
   */
  vad: {
    threshold: 0.02,
    silenceMs: 650,
    minSpeechMs: 320,
    maxMs: 15000,
  },
}

const NUM_RULES = {
  'tts.maxChars': [1, 8000],
  'tts.timeoutMs': [1000, 120000],
  'asr.timeoutMs': [1000, 120000],
  'vad.threshold': [0.001, 0.5],
  'vad.silenceMs': [150, 5000],
  'vad.minSpeechMs': [100, 5000],
  'vad.maxMs': [1000, 120000],
}

const BOOL_KEYS = ['enabled', 'tts.enabled', 'asr.enabled']

const STRING_KEYS = [
  'tts.provider', 'tts.base', 'tts.model', 'tts.voice',
  'asr.provider', 'asr.base', 'asr.model', 'asr.language',
]

function getPath(obj, path) {
  let cur = obj
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = cur[key]
  }
  return cur
}

function setPath(obj, path, value) {
  const keys = path.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key]
  }
  cur[keys[keys.length - 1]] = value
}

/** `~/x` / 相对路径 都落成绝对路径；空值原样返回空串。 */
export function expandPath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return isAbsolute(text) ? text : resolve(text)
}

/**
 * 规整配置（不抛）：返回 { value, warnings }。
 * 类型不对/越界的项回落到默认值并留一条 warning（不静默吞掉用户写错的东西）。
 */
export function normalizeConfig(raw, { configFile = '' } = {}) {
  const warnings = []
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    warnings.push('配置不是 JSON 对象，已整体回落到默认值')
  }
  const value = deepMerge(structuredClone(DEFAULTS), input)

  for (const [path, [min, max]] of Object.entries(NUM_RULES)) {
    const current = getPath(value, path)
    const num = typeof current === 'number' ? current : Number(current)
    if (current === '' || current === null || current === undefined || Number.isNaN(num)) {
      setPath(value, path, getPath(DEFAULTS, path))
      warnings.push(path + ' 不是数字，已用默认值 ' + getPath(DEFAULTS, path))
      continue
    }
    if (num < min || num > max) {
      const clamped = Math.min(max, Math.max(min, num))
      setPath(value, path, clamped)
      warnings.push(path + '=' + num + ' 超出 [' + min + ',' + max + ']，已改成 ' + clamped)
      continue
    }
    setPath(value, path, num)
  }

  for (const path of BOOL_KEYS) {
    const current = getPath(value, path)
    if (typeof current !== 'boolean') {
      setPath(value, path, getPath(DEFAULTS, path))
      warnings.push(path + ' 不是布尔值，已用默认值 ' + getPath(DEFAULTS, path))
    }
  }

  for (const path of STRING_KEYS) {
    const current = getPath(value, path)
    if (typeof current === 'string') continue
    if (current === undefined || current === null) {
      setPath(value, path, getPath(DEFAULTS, path))
      continue
    }
    setPath(value, path, String(current))
    warnings.push(path + ' 不是字符串，已按字符串处理')
  }

  value.tts.base = String(value.tts.base || '').replace(/\/+$/, '')
  value.asr.base = String(value.asr.base || '').replace(/\/+$/, '')
  value.tts.provider = String(value.tts.provider || 'aliyun').toLowerCase()
  value.asr.provider = String(value.asr.provider || 'aliyun').toLowerCase()
  if (value.tts.provider !== 'aliyun' && value.tts.provider !== 'openai') {
    warnings.push('tts.provider 只支持 aliyun / openai，已回落到 aliyun（tts.provider=' + JSON.stringify(value.tts.provider) + '）')
    value.tts.provider = 'aliyun'
  }
  if (value.asr.provider !== 'openai' && value.asr.provider !== 'aliyun') {
    warnings.push('asr.provider 只支持 openai / aliyun，已回落到 aliyun（asr.provider=' + JSON.stringify(value.asr.provider) + '）')
    value.asr.provider = 'aliyun'
  }
  if (configFile) value.configFile = configFile
  return { value, warnings }
}

/**
 * 从旧 muse_vtuber 的 config.json 里捞一份可迁移的基线（只在**本插件首次创建配置**时用）。
 *
 * 为什么要有它：拆分前 TTS/ASR/VAD 都写在 muse_vtuber 的配置里（`$DSH_HOME/mira_config/muse_vtuber/
 * config.json`）。升级后如果什么都不搬，用户会发现"声音设置全变默认了"，甚至以为 key 丢了。
 * 这里只读、不删旧文件；旧文件仍归 muse_vtuber 自己管。
 */
export function legacySeed() {
  const file = join(miraConfigDir('muse_vtuber'), 'config.json')
  let raw = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { patch: {}, source: '' }
  }
  if (!raw || typeof raw !== 'object') return { patch: {}, source: '' }
  const patch = {}
  for (const key of ['tts', 'asr']) {
    if (raw[key] && typeof raw[key] === 'object') patch[key] = raw[key]
  }
  const vad = raw.mic && raw.mic.vad && typeof raw.mic.vad === 'object' ? raw.mic.vad : null
  if (vad) {
    patch.vad = {}
    for (const key of ['threshold', 'silenceMs', 'minSpeechMs', 'maxMs']) {
      if (vad[key] !== undefined) patch.vad[key] = vad[key]
    }
  }
  return { patch, source: Object.keys(patch).length ? file : '' }
}

/**
 * 配置仓库：读 config.json（权威）→ 规整；写回原子替换；文件改动按内容热生效（约定9）。
 * `seed`：文件第一次创建时要叠在默认值上的基线（旧 muse_vtuber 的 tts/asr/vad）。
 */
export class ConfigStore {
  /**
   * @param {object} options
   * @param {string} options.baseDir  `$DSH_HOME/mira_config/mira_media`
   * @param {object} [options.patch]  cordis patch 里的 config（基线）
   * @param {object} [options.logger]
   * @param {() => {patch:object, source:string}} [options.seed] 首次创建时的迁移基线
   */
  constructor({ baseDir, patch = {}, logger = null, seed = null }) {
    this.baseDir = baseDir
    this.file = join(baseDir, 'config.json')
    this.patch = patch && typeof patch === 'object' ? patch : {}
    this.logger = logger
    this.seed = seed
    this.cache = null
    this.cacheRaw = null
    this.fatalError = null
    this.createdFile = false
    this.seededFrom = ''
    this.warnings = []
  }

  /** 启动读：缺文件 → 按 patch+seed+默认写一份；坏文件/schema 不匹配 → 记 fatalError，不动原文件。 */
  load() {
    ensureDir(this.baseDir)
    const text = this.readText()
    if (text === null) {
      let base = this.patch
      if (typeof this.seed === 'function') {
        try {
          const seeded = this.seed()
          if (seeded && seeded.patch && Object.keys(seeded.patch).length) {
            base = deepMerge(structuredClone(this.patch), seeded.patch)
            this.seededFrom = String(seeded.source || '')
          }
        } catch { /* 迁移失败不挡创建 */ }
      }
      const { value, warnings } = normalizeConfig(base, { configFile: this.file })
      const payload = { schemaVersion: CONFIG_SCHEMA, ...stripRuntime(value) }
      this.createdFile = writeJsonAtomic(this.file, payload)
      this.cache = value
      this.warnings = warnings
      this.cacheRaw = this.createdFile ? JSON.stringify(payload, null, 2) + '\n' : null
      return { created: true, warnings, seededFrom: this.seededFrom }
    }
    return this.applyRaw(text)
  }

  /** 读文件原文；不存在返回 null（读失败也当不存在，不把 IO 错当成配置错）。 */
  readText() {
    try {
      return readFileSync(this.file, 'utf8')
    } catch {
      return null
    }
  }

  /** 用一段原文刷新缓存：schema/坏 JSON 只记 fatalError，绝不覆盖原文件。 */
  applyRaw(text) {
    this.cacheRaw = text
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      this.fatalError = {
        code: 'config/corrupt',
        message: '配置文件不可用：' + this.file + '（' + (error?.message || error) + '）',
        hint: '修好这个 JSON 文件（或删掉它让插件按默认重建），然后重载插件',
      }
      return { created: false, error: this.fatalError }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.fatalError = {
        code: 'config/corrupt',
        message: '配置文件不是 JSON 对象：' + this.file,
        hint: '顶层必须是对象（{ "schemaVersion": 1, ... }）',
      }
      return { created: false, error: this.fatalError }
    }
    const checked = checkSchema(parsed, CONFIG_SCHEMA, this.file)
    if (!checked.ok) {
      this.fatalError = checked.error?.error || checked.error
      return { created: false, error: this.fatalError }
    }
    const { value, warnings } = normalizeConfig(parsed, { configFile: this.file })
    this.cache = value
    this.warnings = warnings
    this.fatalError = null
    return { created: false, warnings }
  }

  /**
   * 热生效：文件内容变了就重新加载（约定9）。
   *
   * 为什么比**内容**而不是比 mtime：Windows 上文件时间戳是懒更新的（同一瞬间连续写可能拿到同一个
   * mtimeNs），靠时间戳判断会漏掉改动。配置文件只有几 KB，每次读一遍再字符串比较最省心。
   */
  current() {
    const text = this.readText()
    if (text !== this.cacheRaw) {
      const result = this.load()
      if (result.error) {
        // 文件被改坏了：保留上一次好用的值，但仍然对外报错（工具要能说清哪里坏了）
        this.fatalError = result.error
      }
    }
    if (this.fatalError) {
      throw new MiraError(this.fatalError.code, this.fatalError.message, this.fatalError.hint)
    }
    if (!this.cache) {
      const { value } = normalizeConfig(this.patch, { configFile: this.file })
      this.cache = value
    }
    return this.cache
  }

  /** 设置页保存：深合并 → 原子写（保留未知字段）→ 立即热生效。 */
  save(patch) {
    const before = this.current()
    const { value, warnings } = normalizeConfig(deepMerge(structuredClone(before), patch || {}), {
      configFile: this.file,
    })
    const payload = { schemaVersion: CONFIG_SCHEMA, ...stripRuntime(value) }
    const written = writeJsonAtomic(this.file, payload)
    if (!written) {
      throw new MiraError('config/write-failed', '写配置失败：' + this.file,
        '检查目录权限；文件会被原样保留，不会写坏的半截 JSON')
    }
    this.cache = value
    this.warnings = warnings
    this.fatalError = null
    this.cacheRaw = JSON.stringify(payload, null, 2) + '\n'
    return { value, warnings }
  }

  status() {
    return {
      file: this.file,
      createdFile: this.createdFile,
      seededFrom: this.seededFrom,
      warnings: this.warnings.slice(),
      error: this.fatalError ? { ...this.fatalError } : null,
    }
  }
}

/** 内部字段（绝对路径）不落盘。 */
function stripRuntime(value) {
  const { configFile, ...rest } = value
  return rest
}

/** 给浏览器的一份配置（不含路径、不含凭据；VAD 参数要给输入侧切分用）。 */
export function publicConfig(cfg) {
  return {
    tts: { enabled: cfg.tts.enabled, provider: cfg.tts.provider, voice: cfg.tts.voice, maxChars: cfg.tts.maxChars },
    asr: { enabled: cfg.asr.enabled, language: cfg.asr.language },
    vad: { ...cfg.vad },
    features: {
      tts: cfg.tts.enabled === true,
      asr: cfg.asr.enabled === true,
    },
  }
}

/** 供自检/迁移判断用：某个路径是不是目录。 */
export function isDir(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 旧凭据文件是否存在（迁移时用；不读内容以外的任何东西）。 */
export function legacyCredsFile() {
  const file = join(miraConfigDir('muse_vtuber'), 'creds', 'dashscope.json')
  return existsSync(file) ? file : ''
}
