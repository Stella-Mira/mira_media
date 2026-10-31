/**
 * mira_audio —— DSH 的「声音」插件（任务书：三件套拆分后的第 1 件）
 *
 * 一句话：把**语音合成（TTS）/ 语音识别（ASR）/ 断句（VAD 切分）**做成一个独立插件，
 * 并暴露 `miraAudio` 服务，别的插件（mira_input 采集、muse_vtuber 形象、以后的任何插件）
 * `inject: ['miraAudio']` 就能用，不需要各自再存一份阿里云 key。
 *
 * 结构（每个模块一件事）：
 *   config.js       配置默认值 / 规整 / config.json 原子写 / 热生效（schemaVersion 1）
 *                   首次创建时从旧 muse_vtuber 配置迁移 tts/asr/vad
 *   aliyun.js       DashScope 网关：语音合成、语音识别、识图（key 只在 creds/dashscope.json，600）
 *   vad.js          PCM 断句（16bit 单声道 → 一句一句的 WAV）
 *   hub.js          SSE（宿主 → 页面）：say 帧
 *   audio-store.js  合成音频暂存（内存 + TTL），页面用 /audio/api/audio/<id> 播
 *   routes.js       /audio/api/*（bootstrap / events / say / asr / settings / audio/<id>）
 *   tools.js        audio_say / audio_status
 *   client.js       （浏览器侧）全局播放器 + 设置页「声音」
 *
 * 与另外两件的关系（依赖方向）：
 *   muse_vtuber ──┐
 *                 ├─→ mira_input ──→ mira_audio        （箭头 = "依赖"）
 *   muse_galaxy ──┘   （采集口）      （TTS/ASR/VAD/凭据）
 *
 * 凭据纪律（任务书约定8）：key 只在这里；只写 600 文件；永不回显、不进日志、不进工具返回值。
 */

import { existsSync, readFileSync } from 'node:fs'

import {
  claimInstance, ensureDir, fail, makeCounters, miraConfigDir,
} from './kit.mjs'
import { ConfigStore, legacyCredsFile, legacySeed, publicConfig } from './config.js'
import { AliyunService } from './aliyun.js'
import { EventHub } from './hub.js'
import { AudioStore } from './audio-store.js'
import { createHandler, buildSettingsView, speak } from './routes.js'
import { createSegmenter, pcmRms, pcmToWav } from './vad.js'
import { registerTools, statusView, TOOL_NAMES } from './tools.js'

export const name = 'mira_audio'

/**
 * 硬依赖（缺了插件不加载，比「一半可用」好排查）：
 *   tools      注册 audio_* 工具
 *   webServer  /audio/api/* 与设置页读写
 */
export const inject = ['tools', 'webServer']

const INSTANCE_ID = 'mira_audio'
const SERVICE_NAME = 'miraAudio'
const VERSION = '1.0.0'

export function apply(ctx, config) {
  const logger = ctx.logger || null
  const counters = makeCounters()
  counters.pluginName = 'mira_audio'

  if (config && config.enabled === false) {
    logger?.info?.('[mira_audio] 已禁用（config.enabled = false），不注册工具与路由')
    return fail('plugin/disabled', 'mira_audio 被 config.enabled=false 禁用', '把配置里的 enabled 改回 true 再重载')
  }

  // 约定6：两个实例 = 两套 SSE 客户端表 + 两份路由 = 同一个事件被播两遍
  const claim = claimInstance(INSTANCE_ID)
  if (!claim.ok) {
    logger?.warn?.('[mira_audio] 已经有一个实例在跑（pid=' + (claim.holder?.pid ?? '?') + '），本次加载被拒绝：'
      + '两个实例会让同一段语音被播两次。检查 profile 是不是把这个插件挂了两遍')
    return fail('plugin/instance', 'mira_audio 已有实例在跑，重复加载被拒绝',
      '检查 profile 的 cordis patch 是否把 mira_audio 挂了两遍；一个进程只允许一个实例')
  }

  const baseDir = miraConfigDir('mira_audio')
  const configStore = new ConfigStore({
    baseDir,
    patch: config || {},
    logger,
    seed: legacySeed,
  })
  let hub = null
  let audioStore = null
  let aliyunSvc = null
  let disposeTools = null
  let routeDisposer = null
  let disposeProvide = null

  const releaseAll = () => {
    try { disposeProvide?.() } catch { /* 退场不抛 */ }
    try { disposeTools?.() } catch { /* noop */ }
    try { routeDisposer?.() } catch { /* noop */ }
    try { hub?.dispose() } catch { /* noop */ }
    try { claim.release() } catch { /* noop */ }
  }

  try {
    ensureDir(baseDir)
    const loaded = configStore.load()
    if (loaded.error) {
      logger?.warn?.('[mira_audio] 配置不可用（' + loaded.error.code + '）：' + loaded.error.message
        + '；工具会拒绝使用，文件原样保留')
    }
    for (const warning of loaded.warnings || []) logger?.warn?.('[mira_audio] 配置：' + warning)
    if (loaded.seededFrom) {
      logger?.info?.('[mira_audio] 首次创建配置：已从旧 muse_vtuber 配置迁移 tts/asr/vad（' + loaded.seededFrom + '）')
    }

    aliyunSvc = new AliyunService({
      config: {},
      baseDir,
      configFile: configStore.file,
      logger,
      counters,
      fetchImpl: (...args) => globalThis.fetch(...args),
    })
    const aliyun = () => {
      try {
        aliyunSvc.setConfig(configStore.current())
      } catch { /* 配置坏了：服务层会自己报 creds/config 错误 */ }
      return aliyunSvc
    }

    // 凭据迁移：拆分前 key 存在 muse_vtuber 下；新目录没有就搬一份（原文件不动）
    migrateCreds(aliyun(), logger)

    hub = new EventHub({ logger, counters })
    audioStore = new AudioStore()

    const deps = {
      configStore,
      aliyun,
      hub,
      audioStore,
      logger,
      counters,
      speak: (cfg, text, voice) => speak(deps, cfg, text, voice),
      statusView: () => statusView(deps),
    }

    /**
     * 对外服务（别的插件 `inject: ['miraAudio']` 拿到的就是它）。
     * 契约写进 README「§3 服务契约」；这里只做薄包装，所有真实逻辑在各自模块里。
     */
    const service = {
      version: VERSION,
      /** 只读状态（不含 key）。 */
      status: () => statusView(deps),
      /** 语音合成：返回 { mime, base64, bytes, chars, truncated, voice, model }，不播放。 */
      synthesize: (text, options = {}) => aliyun().synthesize(text, { voice: String(options?.voice || '') }),
      /** 语音识别：{ base64, mime, sampleRate } → { text, model }。 */
      transcribe: (input = {}) => aliyun().transcribe({
        base64: String(input.base64 ?? input.audio ?? ''),
        mime: String(input.mime || 'audio/wav'),
        sampleRate: Number(input.sampleRate) || 0,
      }),
      /** 识图（同一个网关/同一份 key）：base/model/prompt 由调用方给。 */
      describeImage: (input = {}) => aliyun().describeImage(input),
      /** 合成 + 广播：页面播放器会出声。返回 { url, chars, truncated, voice, clients, delivered }。 */
      say: (text, options = {}) => speak(deps, currentCfg(), String(text ?? ''), String(options?.voice || '')),
      /** 当前 VAD 参数（切分阈值属于声音，不属于输入侧）。 */
      vad: () => ({ ...currentCfg().vad }),
      /** 造一个 PCM 断句器（输入侧用它把采集到的 PCM 切成一句句）。 */
      createSegmenter: (options = {}) => {
        const vad = options && options.vad && typeof options.vad === 'object' ? options.vad : currentCfg().vad
        return createSegmenter({
          vad,
          sampleRate: Number(options?.sampleRate) || 16000,
          maxAudioMs: Number(options?.maxAudioMs) || 30000,
          onUtterance: options?.onUtterance,
          now: options?.now,
        })
      },
      /** 两个纯函数，省得调用方自己写（16bit PCM → WAV / RMS）。 */
      pcmToWav,
      pcmRms,
      /** 有没有页面在（播放器在页面里；0 = 合成得出来但没地方播）。 */
      player: () => ({ clients: hub.clientCount }),
      /** 给调用方拼提示词/状态用的一份公开配置（不含路径与凭据）。 */
      publicConfig: () => publicConfig(currentCfg()),
      /** 设置页视图（同一份数据，别的插件想展示也能用）。 */
      settingsView: () => buildSettingsView(deps),
    }

    disposeProvide = ctx.provide(SERVICE_NAME, service)

    disposeTools = registerTools(ctx, deps)

    routeDisposer = ctx.webServer.register({
      kind: 'prefix',
      path: '/audio',
      handler: createHandler(deps),
    })

    ctx.effect(() => () => releaseAll())

    const status = configStore.status()
    const feature = aliyun().status()
    logger?.info?.('[mira_audio] 已加载：服务 ' + SERVICE_NAME + '，工具 ' + TOOL_NAMES.length + ' 个，'
      + 'TTS ' + (feature.tts.enabled ? feature.tts.model + '/' + feature.tts.voice : '关')
      + '，ASR ' + (feature.asr.enabled ? feature.asr.model : '关')
      + '，VAD ' + currentCfg().vad.threshold + '/' + currentCfg().vad.silenceMs + 'ms'
      + '，阿里云 ' + (feature.configured ? '已配置 key' : '未配置 key（TTS/ASR 会报 creds/missing）')
      + '，接口 /audio/api/')
    if (status.error) {
      logger?.warn?.('[mira_audio] config.json 处于错误状态（' + status.error.code + '）：' + status.error.message)
    }

    return {
      ok: true,
      service: SERVICE_NAME,
      configFile: configStore.file,
      credsFile: aliyunSvc.credsFile,
      seededFrom: status.seededFrom || '',
      tools: TOOL_NAMES.length,
      api: '/audio/api/',
      configError: status.error,
    }
  } catch (error) {
    // 装配失败必须回滚干净：服务/路由/工具/单实例认领都要释放，否则只能重启进程
    releaseAll()
    logger?.warn?.('[mira_audio] 加载失败，已回滚服务/工具/路由/单实例认领：' + (error?.message || error))
    throw error
  }

  function currentCfg() {
    try {
      return configStore.current()
    } catch {
      return configStore.cache || { tts: {}, asr: {}, vad: {} }
    }
  }
}

/**
 * 凭据迁移：旧 `mira_config/muse_vtuber/creds/dashscope.json` → `mira_config/mira_audio/creds/dashscope.json`。
 * 只在"新文件不存在、旧文件存在且能读出 key"时做一次；key 本身不进日志。
 */
function migrateCreds(aliyunSvc, logger) {
  const target = aliyunSvc?.credsFile
  if (!target || existsSync(target)) return
  const legacy = legacyCredsFile()
  if (!legacy) return
  try {
    const raw = JSON.parse(readFileSync(legacy, 'utf8'))
    const key = String(raw?.apiKey ?? '').trim()
    if (key === '') return
    aliyunSvc.writeCreds({ apiKey: key })
    logger?.info?.('[mira_audio] 已把阿里云凭据从旧 muse_vtuber 迁移到 ' + target + '（600，旧文件保留）')
  } catch { /* 旧文件坏了：不迁移，设置页会显示"未配置"并让人重填 */ }
}

/** 供自检脚本使用（不是 DSH 接口）。 */
export const __testing = {
  TOOL_NAMES,
  SERVICE_NAME,
  VERSION,
}
