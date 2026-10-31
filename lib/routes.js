/**
 * mira_audio / routes.js —— 宿主侧的 HTTP 面（`/audio/api/*`）
 *
 * 数据流（一眼看懂）：
 *   浏览器 → 宿主：bootstrap / say / asr / settings
 *   宿主 → 浏览器：events（SSE：say）
 *   音频：宿主合成完放 AudioStore（内存 + TTL），页面用 /audio/api/audio/<id> 播
 *
 * 为什么用 HTTP 而不是别的通道：浏览器侧（播放器、设置页）与别的插件的页面在同一个源里，
 * 同源 HTTP 最直接，而且能被自检用假 req/res 覆盖。所有 /audio/api/* 只接受同源请求
 * （这些接口能烧 TTS 额度、能改配置）。
 */

import { MiraError, fail, okObj, toError } from './kit.mjs'
import { publicConfig } from './config.js'

export function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

export function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8')
}

/**
 * 同源守卫：`Sec-Fetch-Site: cross-site` 一律拒；`Origin` 与 `Host` 不同源一律拒；
 * 没有 `Origin` 的本地客户端（curl / 自检）放行。
 */
export function isSameOriginRequest(req) {
  const headers = req && req.headers ? req.headers : {}
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
  const rawOrigin = headers.origin
  if (rawOrigin === undefined || rawOrigin === null) return true
  const origin = String(rawOrigin).trim()
  if (origin === '') return true
  if (origin.toLowerCase() === 'null') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = String(headers.host || '').trim().toLowerCase()
  if (host === '') return false
  return parsed.host.toLowerCase() === host
}

export function readJsonBody(req, maxBytes) {
  return new Promise((resolveBody) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    let finished = false
    const done = (value) => {
      if (finished) return
      finished = true
      resolveBody(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        done({
          ok: false,
          status: 413,
          error: {
            code: 'payload/too-large',
            message: '请求体超过上限 ' + maxBytes + ' 字节',
            hint: '音频请缩短或降采样；常规 API 请求应小于 64 KiB',
          },
        })
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        done({ ok: true, value: {} })
        return
      }
      try {
        done({ ok: true, value: JSON.parse(raw) })
      } catch {
        done({
          ok: false,
          status: 400,
          error: { code: 'payload/invalid', message: '请求体不是合法 JSON', hint: '用 Content-Type: application/json 并检查拼写' },
        })
      }
    })
    req.on('error', (error) => {
      done({
        ok: false,
        status: 400,
        error: { code: 'payload/read-failed', message: '读取请求体失败：' + (error?.message || error), hint: '重试' },
      })
    })
  })
}

/**
 * 主处理器。
 *
 * @param {object} deps
 * @param {object} deps.configStore
 * @param {() => object} deps.aliyun  每次取新的（配置热加载后要跟着换）
 * @param {object} deps.hub
 * @param {object} deps.audioStore
 * @param {(cfg:object, text:string, voice?:string)=>Promise<object>} deps.speak
 * @param {object} [deps.logger]
 * @param {object} [deps.counters]
 */
export function createHandler(deps) {
  return async function handle(req, res) {
    let url
    try {
      url = new URL(req.url, 'http://x')
    } catch {
      send(res, 400, 'bad url')
      return undefined
    }
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      pathname = url.pathname
    }
    if (!pathname.startsWith('/audio/api/')) {
      send(res, 404, 'not found')
      return undefined
    }
    const sub = pathname.slice('/audio/api/'.length)
    const method = (req.method || 'GET').toUpperCase()

    if (!isSameOriginRequest(req)) {
      sendJson(res, 403, fail('http/forbidden',
        '拒绝跨站请求：/audio/api/' + sub + ' 只接受同源请求',
        '这些接口能烧 TTS 额度、能改配置；别的站点不能调用'))
      return undefined
    }

    // 配置坏了：除了 settings（要能把「为什么不可用」显示出来）与 health，其余一律拒
    let cfg = null
    let configError = null
    try {
      cfg = deps.configStore.current()
    } catch (error) {
      configError = toError(error)
      if (sub !== 'settings' && sub !== 'health') {
        sendJson(res, 503, configError)
        return undefined
      }
    }

    if (sub === 'health' && method === 'GET') {
      sendJson(res, 200, okObj({
        plugin: 'mira_audio',
        clients: deps.hub.clientCount,
        configError: configError ? configError.error : null,
        configFile: deps.configStore.file,
        credsFile: deps.aliyun().credsFile,
        audio: deps.audioStore.status(),
        features: {
          tts: deps.aliyun().status().tts.enabled === true,
          asr: deps.aliyun().status().asr.enabled === true,
          vad: true,
        },
        count: deps.counters ? deps.counters.snapshot() : {},
      }))
      return undefined
    }

    if (sub === 'bootstrap' && method === 'GET') {
      sendJson(res, 200, okObj({
        config: cfg ? publicConfig(cfg) : null,
        features: deps.aliyun().status(),
        configError: configError ? configError.error : null,
        configFile: deps.configStore.file,
        credsFile: deps.aliyun().credsFile,
        endpoints: {
          events: '/audio/api/events',
          say: '/audio/api/say',
          asr: '/audio/api/asr',
          settings: '/audio/api/settings',
          audio: '/audio/api/audio/',
        },
      }))
      return undefined
    }

    if (sub === 'events' && method === 'GET') {
      deps.hub.attach(req, res)
      return undefined
    }

    if (sub === 'say' && method === 'POST') {
      if (configError) {
        sendJson(res, 503, configError)
        return undefined
      }
      const parsed = await readJsonBody(req, 64 * 1024)
      if (!parsed.ok) {
        sendJson(res, parsed.status, parsed)
        return undefined
      }
      const text = String(parsed.value?.text ?? '')
      const voice = String(parsed.value?.voice ?? '')
      try {
        sendJson(res, 200, await speak(deps, cfg, text, voice))
      } catch (error) {
        sendJson(res, 400, toError(error))
      }
      return undefined
    }

    if (sub === 'asr' && method === 'POST') {
      if (configError) {
        sendJson(res, 503, configError)
        return undefined
      }
      const parsed = await readJsonBody(req, 16 * 1024 * 1024)
      if (!parsed.ok) {
        sendJson(res, parsed.status, parsed)
        return undefined
      }
      const value = parsed.value || {}
      try {
        const outcome = await deps.aliyun().transcribe({
          base64: String(value.base64 ?? value.audio ?? ''),
          mime: String(value.mime || 'audio/wav'),
          // 原生识别口要 sample_rate（各输入侧按自己的采样率录）
          sampleRate: Number(value.sampleRate) || 0,
        })
        sendJson(res, 200, okObj({
          text: outcome.text,
          model: outcome.model,
          chars: Array.from(outcome.text || '').length,
          durationMs: Number(value.durationMs) || 0,
        }))
      } catch (error) {
        sendJson(res, 400, toError(error))
      }
      return undefined
    }

    if (sub === 'settings' && method === 'GET') {
      sendJson(res, 200, buildSettingsView(deps))
      return undefined
    }

    if (sub === 'settings' && method === 'POST') {
      if (configError) {
        sendJson(res, 503, configError)
        return undefined
      }
      const parsed = await readJsonBody(req, 256 * 1024)
      if (!parsed.ok) {
        sendJson(res, parsed.status, parsed)
        return undefined
      }
      try {
        sendJson(res, 200, writeSettings(deps, parsed.value || {}))
      } catch (error) {
        sendJson(res, 400, toError(error))
      }
      return undefined
    }

    if (sub.startsWith('audio/') && method === 'GET') {
      const id = sub.slice('audio/'.length)
      const item = deps.audioStore.get(id)
      if (!item) {
        sendJson(res, 404, fail('audio/not-found', '音频不存在或已过期：' + id,
          'TTS 音频只在内存里保留 10 分钟；让模型重新说一次'))
        return undefined
      }
      res.writeHead(200, {
        'content-type': item.mime || 'audio/mpeg',
        'content-length': item.buffer.length,
        'cache-control': 'private, max-age=600',
      })
      res.end(item.buffer)
      return undefined
    }

    sendJson(res, 404, fail('http/not-found', '未知接口：/audio/api/' + sub, '见 GET /audio/api/bootstrap 的 endpoints'))
    return undefined
  }
}

/** 合成 + 广播：工具、HTTP、别的插件（miraAudio.say）共用这一条路径。 */
export async function speak(deps, cfg, text, voice = '') {
  const outcome = await deps.aliyun().synthesize(text, { voice })
  const id = deps.audioStore.put(Buffer.from(outcome.base64, 'base64'), outcome.mime)
  const url = '/audio/api/audio/' + id
  const clients = deps.hub.broadcast('say', {
    text: String(text ?? ''),
    url,
    id,
    mime: outcome.mime,
    chars: outcome.chars,
    truncated: outcome.truncated,
    voice: outcome.voice,
  })
  if (deps.hub) {
    deps.hub.lastSay = { text: String(text ?? ''), chars: outcome.chars, voice: outcome.voice, at: new Date().toISOString(), clients }
  }
  deps.logger?.info?.('[mira_audio] 朗读 ' + outcome.chars + ' 字（' + outcome.voice + '），送达 '
    + clients + ' 个页面' + (outcome.truncated ? '（已按 tts.maxChars 截断）' : ''))
  return okObj({
    text: String(text ?? ''),
    chars: outcome.chars,
    requestedChars: outcome.requestedChars,
    delivered: clients > 0,
    truncated: outcome.truncated,
    voice: outcome.voice,
    model: outcome.model,
    url,
    clients,
  })
}

/** 设置页 GET：只回可编辑项 + 「key 配没配」，永不回 key。 */
export function buildSettingsView(deps) {
  const status = deps.configStore.status()
  let cfg = null
  let configError = status.error
  try {
    cfg = deps.configStore.current()
  } catch (error) {
    configError = toError(error).error
  }
  const effective = cfg || deps.configStore.cache || null
  const aliyun = deps.aliyun()
  const creds = aliyun.readCreds()
  const view = {
    ok: true,
    configFile: deps.configStore.file,
    credsFile: aliyun.credsFile,
    keyConfigured: !!(creds.ok && typeof creds.value?.apiKey === 'string' && creds.value.apiKey.trim() !== ''),
    keyMode: creds.ok ? (creds.mode === -1 ? null : '0o' + creds.mode.toString(8)) : null,
    warnings: status.warnings.slice(),
    seededFrom: status.seededFrom || '',
    configError: configError || null,
  }
  if (!creds.ok) view.credsError = creds.error
  if (effective) {
    view.values = {
      tts: {
        enabled: effective.tts.enabled,
        provider: effective.tts.provider,
        base: effective.tts.base,
        model: effective.tts.model,
        voice: effective.tts.voice,
        maxChars: effective.tts.maxChars,
      },
      asr: {
        enabled: effective.asr.enabled,
        provider: effective.asr.provider,
        base: effective.asr.base,
        model: effective.asr.model,
        language: effective.asr.language,
      },
      vad: { ...effective.vad },
    }
    view.runtime = { features: aliyun.status() }
  }
  return view
}

/** 设置页 POST：白名单字段深合并写回 config.json；apiKey 单独写 600 凭据文件。 */
export function writeSettings(deps, body) {
  const values = body && typeof body === 'object' && body.values && typeof body.values === 'object'
    ? body.values
    : body
  const patch = pickSettings(values)
  const changed = []
  const before = deps.configStore.current()
  const after = deps.configStore.save(patch)
  for (const key of Object.keys(patch)) {
    if (JSON.stringify(before?.[key]) !== JSON.stringify(after.value?.[key])) changed.push(key)
  }
  let keyWritten = false
  const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : ''
  if (apiKey !== '') {
    deps.aliyun().writeCreds({ apiKey })
    keyWritten = true
    changed.push('key')
    deps.logger?.info?.('[mira_audio] 阿里云 API key 已更新（写 ' + deps.aliyun().credsFile + '，600）')
  }
  return okObj({ ...buildSettingsView(deps), changed, keyWritten })
}

const SETTINGS_SHAPE = {
  tts: ['enabled', 'provider', 'base', 'model', 'voice', 'maxChars', 'timeoutMs'],
  asr: ['enabled', 'provider', 'base', 'model', 'language', 'timeoutMs'],
  vad: ['threshold', 'silenceMs', 'minSpeechMs', 'maxMs'],
}

/** 只收设置页认得的字段（其余一律忽略，避免前端把 runtime 字段写进配置）。 */
export function pickSettings(values) {
  const patch = {}
  if (!values || typeof values !== 'object') return patch
  for (const [group, keys] of Object.entries(SETTINGS_SHAPE)) {
    const source = values[group]
    if (!source || typeof source !== 'object') continue
    const target = {}
    for (const key of keys) {
      if (source[key] !== undefined) target[key] = source[key]
    }
    if (Object.keys(target).length) patch[group] = target
  }
  return patch
}

export { MiraError }
