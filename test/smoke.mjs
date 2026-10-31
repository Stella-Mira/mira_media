/**
 * mira_audio / test/smoke.mjs —— 离线自检（不需要 DSH、不联网、不碰真 ~/.dsh）
 *
 * 覆盖：
 *   A kit 副本一致 / B 配置规整与迁移 / C 配置仓库 / D 阿里云三件事（假 fetch）
 *   E VAD 断句 / F SSE 总线 / G HTTP 面（假 req/res）/ H 工具 / I 入口装配、单实例、退场
 *
 * 跑法：node test/smoke.mjs        （退出码 0 = 全过；末行打印断言数）
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX = mkdtempSync(join(tmpdir(), 'mira-audio-smoke-'))
process.env.DSH_HOME = join(SANDBOX, 'dsh-home')

let pass = 0
const failures = []

async function t(name, fn) {
  try {
    await fn()
    pass += 1
  } catch (error) {
    failures.push(name + '：' + (error && error.message ? error.message : String(error)))
    console.log('[FAIL] ' + name + '：' + (error && error.message ? error.message : String(error)))
  }
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

/* ── 假件 ───────────────────────────────────────────────── */

class FakeReq {
  constructor({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
    this.method = method
    this.url = url
    this.headers = headers
    this.body = body
    this._handlers = { data: [], end: [], error: [] }
  }

  on(event, fn) {
    if (this._handlers[event]) this._handlers[event].push(fn)
    return this
  }

  emit(event, value) {
    for (const fn of this._handlers[event] || []) fn(value)
    return this
  }

  start() {
    const chunks = this.body === null || this.body === undefined
      ? []
      : [Buffer.from(typeof this.body === 'string' ? this.body : JSON.stringify(this.body), 'utf8')]
    setImmediate(() => {
      for (const chunk of chunks) this.emit('data', chunk)
      this.emit('end')
    })
    return this
  }
}

class FakeRes {
  constructor() {
    this.status = 0
    this.headers = {}
    this.chunks = []
    this.ended = false
    this._handlers = {}
  }

  writeHead(status, headers) {
    this.status = status
    this.headers = headers || {}
    return this
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'))
    return true
  }

  end(chunk) {
    if (chunk !== undefined && chunk !== null) {
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    this.ended = true
    return this
  }

  on(event, fn) {
    ;(this._handlers[event] || (this._handlers[event] = [])).push(fn)
    return this
  }

  get text() {
    return Buffer.concat(this.chunks).toString('utf8')
  }

  get json() {
    try {
      return JSON.parse(this.text)
    } catch {
      return null
    }
  }
}

function makeCtx() {
  const registered = new Map()
  const routes = []
  const disposers = []
  const provided = new Map()
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    provide(name, api) {
      provided.set(name, api)
      return () => provided.delete(name)
    },
    effect(fn) {
      disposers.push(fn())
      return () => {}
    },
    registered,
    routes,
    provided,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.()
        } catch { /* 忽略 */ }
      }
    },
  }
  return ctx
}

function makeFetch(routes) {
  const calls = []
  const impl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      options,
      body: typeof options.body === 'string' ? safeJson(options.body) : options.body,
    })
    for (const [needle, responder] of routes) {
      if (String(url).includes(needle)) return responder(options)
    }
    throw new Error('假 fetch 没有匹配：' + url)
  }
  impl.calls = calls
  return impl
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    },
    async arrayBuffer() {
      return new TextEncoder().encode(JSON.stringify(payload)).buffer
    },
  }
}

function audioBytes(bytes, mime = 'audio/wav') {
  const buffer = Buffer.alloc(bytes, 7)
  return {
    ok: true,
    status: 200,
    headers: { get: () => mime },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
    async text() {
      return ''
    },
    async json() {
      return {}
    },
  }
}

const TTS_URL = 'https://fake-audio.invalid/tts.wav'

function makeSpeakFetch(bytes = 128, extra = []) {
  return makeFetch([
    ['/services/audio/tts/SpeechSynthesizer', () => jsonResponse({ output: { audio: { url: TTS_URL } } })],
    ['fake-audio.invalid', () => audioBytes(bytes)],
    ...extra,
  ])
}

/* ── 载入被测模块（先钉 DSH_HOME） ───────────────────────── */

const kit = await import('../lib/kit.mjs')
const configMod = await import('../lib/config.js')
const aliyunMod = await import('../lib/aliyun.js')
const vadMod = await import('../lib/vad.js')
const hubMod = await import('../lib/hub.js')
const storeMod = await import('../lib/audio-store.js')
const routesMod = await import('../lib/routes.js')
const toolsMod = await import('../lib/tools.js')
const indexMod = await import('../lib/index.js')

const BASE = kit.miraConfigDir('mira_audio')

/* ══════════════════════════════════════════════════════════
 * A. kit 副本一致
 * ══════════════════════════════════════════════════════════ */

await t('A1 lib/kit.mjs 与 tool_shared/kit/kit.mjs 逐字节一致', () => {
  const canonical = resolve(ROOT, '..', 'tool_shared', 'kit', 'kit.mjs')
  if (!existsSync(canonical)) return
  assert.equal(sha256(join(ROOT, 'lib', 'kit.mjs')), sha256(canonical))
})

/* ══════════════════════════════════════════════════════════
 * B. 配置规整 / 迁移
 * ══════════════════════════════════════════════════════════ */

await t('B1 默认值：TTS/ASR 走千问原生口，VAD 是那一套数', () => {
  const { value } = configMod.normalizeConfig({})
  assert.equal(value.tts.model, 'qwen-audio-3.0-tts-plus')
  assert.equal(value.tts.voice, 'longanhuan_v3.6')
  assert.equal(value.tts.base, 'https://token-plan.maas.qianwenaiapi.com/api/v1')
  assert.equal(value.asr.model, 'qwen-audio-3.0-asr-flash')
  assert.equal(value.asr.provider, 'aliyun')
  assert.equal(value.vad.threshold, 0.02)
  assert.equal(value.vad.silenceMs, 650)
})

await t('B2 越界数字被夹回范围并留 warning；未知字段原样保留', () => {
  const { value, warnings } = configMod.normalizeConfig({
    vad: { silenceMs: 99999 },
    tts: { maxChars: 0 },
    futureThing: { a: 1 },
  })
  assert.equal(value.vad.silenceMs, 5000)
  assert.equal(value.tts.maxChars, 1)
  assert.deepEqual(value.futureThing, { a: 1 })
  assert.ok(warnings.some((w) => w.includes('vad.silenceMs')))
})

await t('B3 provider 只认白名单，其它值回落并点名', () => {
  const { value, warnings } = configMod.normalizeConfig({ tts: { provider: 'azure' }, asr: { provider: 'x' } })
  assert.equal(value.tts.provider, 'aliyun')
  assert.equal(value.asr.provider, 'aliyun')
  assert.ok(warnings.some((w) => w.includes('tts.provider')))
  assert.ok(warnings.some((w) => w.includes('asr.provider')))
})

await t('B4 publicConfig 不含路径与凭据', () => {
  const { value } = configMod.normalizeConfig({})
  value.configFile = '/x/config.json'
  const pub = configMod.publicConfig(value)
  assert.equal(pub.configFile, undefined)
  assert.equal(JSON.stringify(pub).includes('dashscope'), false)
  assert.equal(pub.vad.silenceMs, 650)
})

await t('B5 首次创建时从旧 muse_vtuber 配置迁移 tts/asr/vad', () => {
  const legacyDir = join(SANDBOX, 'dsh-home', 'mira_config', 'muse_vtuber')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    tts: { voice: 'legacy-voice', model: 'legacy-tts' },
    asr: { model: 'legacy-asr' },
    mic: { vad: { threshold: 0.05, silenceMs: 900 } },
  }, null, 2))
  const dir = join(SANDBOX, 'seed-config')
  const store = new configMod.ConfigStore({ baseDir: dir, patch: {}, seed: configMod.legacySeed })
  const loaded = store.load()
  assert.equal(loaded.seededFrom.endsWith('muse_vtuber/config.json'), true)
  assert.equal(store.current().tts.voice, 'legacy-voice')
  assert.equal(store.current().asr.model, 'legacy-asr')
  assert.equal(store.current().vad.threshold, 0.05)
  assert.equal(store.current().vad.silenceMs, 900)
})

/* ══════════════════════════════════════════════════════════
 * C. 配置仓库
 * ══════════════════════════════════════════════════════════ */

await t('C1 首次 load 建文件（含 schemaVersion），save 深合并保留未知字段', () => {
  const dir = join(SANDBOX, 'cfg-1')
  const store = new configMod.ConfigStore({ baseDir: dir, patch: { tts: { voice: 'Serena' } } })
  const loaded = store.load()
  assert.equal(loaded.created, true)
  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(raw.schemaVersion, 1)
  assert.equal(raw.tts.voice, 'Serena')
  raw.futureThing = 'keep-me'
  writeFileSync(store.file, JSON.stringify(raw, null, 2))
  store.save({ asr: { language: 'en' } })
  const after = JSON.parse(readFileSync(store.file, 'utf8'))
  assert.equal(after.asr.language, 'en')
  assert.equal(after.futureThing, 'keep-me')
})

await t('C2 schemaVersion 不匹配：拒绝使用且不改原文件', () => {
  const dir = join(SANDBOX, 'cfg-2')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'config.json')
  const text = JSON.stringify({ schemaVersion: 99 }, null, 2)
  writeFileSync(file, text)
  const store = new configMod.ConfigStore({ baseDir: dir, patch: {} })
  const loaded = store.load()
  assert.equal(loaded.error.code, 'config/schema')
  assert.throws(() => store.current(), /schemaVersion|版本/)
  assert.equal(readFileSync(file, 'utf8'), text)
})

await t('C3 手改文件后 current() 热生效', () => {
  const dir = join(SANDBOX, 'cfg-3')
  const store = new configMod.ConfigStore({ baseDir: dir, patch: {} })
  store.load()
  const raw = JSON.parse(readFileSync(store.file, 'utf8'))
  raw.tts = { ...raw.tts, voice: '手改的音色' }
  writeFileSync(store.file, JSON.stringify(raw, null, 2) + '\n')
  assert.equal(store.current().tts.voice, '手改的音色')
})

/* ══════════════════════════════════════════════════════════
 * D. 阿里云网关（假 fetch）
 * ══════════════════════════════════════════════════════════ */

const CFG = configMod.normalizeConfig({}).value
const CREDS_BASE = join(SANDBOX, 'creds')

function makeAliyun(routes, overrides = {}, baseDir = CREDS_BASE) {
  const fetchImpl = makeFetch(routes)
  const service = new aliyunMod.AliyunService({
    config: { ...CFG, ...overrides },
    baseDir,
    configFile: join(baseDir, 'config.json'),
    fetchImpl,
  })
  return { service, fetchImpl }
}

await t('D1 没 key：synthesize 报 creds/missing 并指到文件', async () => {
  const { service } = makeAliyun([], {}, join(SANDBOX, 'creds-empty'))
  await assert.rejects(() => service.synthesize('你好'), (error) => {
    assert.equal(error.code, 'creds/missing')
    assert.ok(String(error.hint).includes('creds'))
    return true
  })
})

await t('D2 writeCreds 落 600；status 只报 configured，不泄 key', () => {
  const { service } = makeAliyun([], {}, join(SANDBOX, 'creds-d2'))
  service.writeCreds({ apiKey: 'sk-secret-123' })
  const status = service.status()
  assert.equal(status.configured, true)
  assert.equal(JSON.stringify(status).includes('sk-secret-123'), false)
})

await t('D3 TTS 原生口：SpeechSynthesizer → 下载 audio.url', async () => {
  const { service, fetchImpl } = makeAliyun([], {}, join(SANDBOX, 'creds-d3'))
  service.fetchImpl = makeSpeakFetch(64)
  service.writeCreds({ apiKey: 'k' })
  const out = await service.synthesize('你好呀')
  assert.equal(out.mime, 'audio/wav')
  assert.equal(out.bytes, 64)
  assert.equal(out.voice, CFG.tts.voice)
  assert.ok(service.fetchImpl.calls[0].url.endsWith('/services/audio/tts/SpeechSynthesizer'))
  assert.ok(service.fetchImpl.calls[1].url.includes('fake-audio.invalid'))
  void fetchImpl
})

await t('D4 TTS 超长按码点截断（不劈 emoji）', async () => {
  const { service } = makeAliyun([], { tts: { ...CFG.tts, maxChars: 4 } }, join(SANDBOX, 'creds-d4'))
  service.fetchImpl = makeSpeakFetch(8)
  service.writeCreds({ apiKey: 'k' })
  const out = await service.synthesize('😀'.repeat(10))
  assert.equal(out.truncated, true)
  assert.equal(out.chars, 4)
})

await t('D5 ASR 原生口：input_audio + format/sample_rate + SSE:disable', async () => {
  const { service } = makeAliyun([['multimodal-generation', () => jsonResponse({ output: { text: '你好' } })]], {}, join(SANDBOX, 'creds-d5'))
  service.writeCreds({ apiKey: 'k' })
  const out = await service.transcribe({ base64: 'AAAA', mime: 'audio/wav', sampleRate: 16000 })
  assert.equal(out.text, '你好')
  const call = service.fetchImpl.calls[0]
  assert.equal(call.body.input.messages[0].content[0].type, 'input_audio')
  assert.equal(call.body.parameters.format, 'wav')
  assert.equal(call.body.parameters.sample_rate, '16000')
  assert.equal(call.options.headers['X-DashScope-SSE'], 'disable')
})

await t('D6 ASR 空音频：asr/failed', async () => {
  const { service } = makeAliyun([], {}, join(SANDBOX, 'creds-d6'))
  service.writeCreds({ apiKey: 'k' })
  await assert.rejects(() => service.transcribe({ base64: '  ' }), /音频为空/)
})

await t('D7 识图：base/model 由调用方给；原生口不通时切兼容口并记住', async () => {
  let native = 0
  let compat = 0
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target.includes('/services/aigc/multimodal-generation/generation')) {
      native += 1
      return {
        ok: false,
        status: 404,
        headers: { get: () => 'application/json' },
        async text() {
          return '{"message":"Model not exist."}'
        },
      }
    }
    if (target.endsWith('/chat/completions')) {
      compat += 1
      return jsonResponse({ choices: [{ message: { content: '画面里有一张桌子。' } }] })
    }
    throw new Error('没预料到的地址：' + target)
  }
  const service = new aliyunMod.AliyunService({
    config: CFG,
    baseDir: join(SANDBOX, 'creds-d7'),
    configFile: 'x',
    fetchImpl,
  })
  service.writeCreds({ apiKey: 'k' })
  const first = await service.describeImage({
    dataUrl: 'data:image/jpeg;base64,AAAA',
    base: 'https://gateway.example/api/v1',
    model: 'qwen3.8-flash',
  })
  assert.equal(first.text, '画面里有一张桌子。')
  assert.equal(first.model, 'qwen3.8-flash')
  assert.equal(native, 1)
  assert.equal(compat, 1)
  const second = await service.describeImage({
    dataUrl: 'data:image/jpeg;base64,AAAA',
    base: 'https://gateway.example/api/v1',
    model: 'qwen3.8-flash',
  })
  assert.equal(second.text, '画面里有一张桌子。')
  assert.equal(native, 1, '记住之后不该再试原生口')
  assert.equal(compat, 2)
})

await t('D8 识图缺 base/model：config/missing', async () => {
  const { service } = makeAliyun([], {}, join(SANDBOX, 'creds-d8'))
  service.writeCreds({ apiKey: 'k' })
  await assert.rejects(() => service.describeImage({ dataUrl: 'data:image/jpeg;base64,AAAA' }), (error) => {
    assert.equal(error.code, 'config/missing')
    return true
  })
})

/* ══════════════════════════════════════════════════════════
 * E. VAD 断句
 * ══════════════════════════════════════════════════════════ */

const sinePcm = (ms, rate = 16000, amp = 8000) => {
  const samples = Math.floor((ms / 1000) * rate)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i += 1) buf.writeInt16LE(Math.round(amp * Math.sin((i / rate) * 2 * Math.PI * 220)), i * 2)
  return buf
}
const silencePcm = (ms, rate = 16000) => Buffer.alloc(Math.floor((ms / 1000) * rate) * 2)

await t('E1 pcmToWav 头正确、pcmRms 在 0..1 之间', () => {
  const wav = vadMod.pcmToWav(Buffer.alloc(320, 1), 16000)
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
  assert.equal(wav.subarray(8, 12).toString(), 'WAVE')
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.equal(wav.length, 44 + 320)
  const rms = vadMod.pcmRms(sinePcm(100))
  assert.ok(rms > 0.01 && rms <= 1, String(rms))
  assert.equal(vadMod.pcmRms(Buffer.alloc(0)), 0)
})

await t('E2 断句：说话+静音切一句，纯静音不出句', () => {
  const got = []
  const seg = vadMod.createSegmenter({
    vad: { threshold: 0.02, silenceMs: 100, minSpeechMs: 100, maxMs: 5000 },
    sampleRate: 16000,
    onUtterance: (u) => got.push(u),
  })
  seg.push(sinePcm(200))
  assert.equal(got.length, 0, '还没静音，不该断句')
  seg.push(silencePcm(200))
  assert.equal(got.length, 1)
  assert.equal(got[0].reason, 'silence')
  assert.equal(got[0].sampleRate, 16000)
  const silent = vadMod.createSegmenter({
    vad: { threshold: 0.02, silenceMs: 100, minSpeechMs: 100 },
    sampleRate: 16000,
    onUtterance: () => got.push({ silent: true }),
  })
  for (let i = 0; i < 5; i += 1) silent.push(silencePcm(200))
  assert.equal(got.length, 1, '纯静音不能造出句子')
})

await t('E3 太短的杂音不回调（当作没听到）', () => {
  const got = []
  const seg = vadMod.createSegmenter({
    vad: { threshold: 0.02, silenceMs: 100, minSpeechMs: 320 },
    sampleRate: 16000,
    onUtterance: (u) => got.push(u),
  })
  seg.push(sinePcm(60))
  seg.push(silencePcm(200))
  assert.equal(got.length, 0)
})

/* ══════════════════════════════════════════════════════════
 * F. SSE 总线 + 音频暂存
 * ══════════════════════════════════════════════════════════ */

await t('F1 attach 立刻收到 hello；broadcast 逐帧带 seq', () => {
  const hub = new hubMod.EventHub()
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  assert.equal(hub.clientCount, 1)
  hub.broadcast('say', { text: 'hi' })
  const frames = res.text.split('\n\n').filter((x) => x.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
  assert.equal(frames[0].type, 'hello')
  assert.equal(frames[1].type, 'say')
  assert.ok(frames[1].seq > frames[0].seq)
  hub.dispose()
  assert.equal(hub.clientCount, 0)
})

await t('F2 AudioStore：上限淘汰 + TTL + status', () => {
  const store = new storeMod.AudioStore({ limit: 2, ttlMs: 1000 })
  const a = store.put(Buffer.from('a'), 'audio/wav')
  const b = store.put(Buffer.from('b'), 'audio/wav')
  const c = store.put(Buffer.from('c'), 'audio/wav')
  assert.equal(store.get(a), null)
  assert.equal(store.get(b).mime, 'audio/wav')
  assert.ok(store.get(c))
  assert.equal(store.status().size, 2)
})

/* ══════════════════════════════════════════════════════════
 * G. HTTP 面
 * ══════════════════════════════════════════════════════════ */

async function makeDeps({ fetchRoutes = [], creds = true } = {}) {
  const base = join(SANDBOX, 'http-' + Math.random().toString(36).slice(2, 8))
  const configStore = new configMod.ConfigStore({ baseDir: base, patch: {} })
  configStore.load()
  const counters = kit.makeCounters()
  const aliyunSvc = new aliyunMod.AliyunService({
    config: configStore.current(),
    baseDir: base,
    configFile: configStore.file,
    fetchImpl: makeFetch(fetchRoutes),
  })
  if (creds) aliyunSvc.writeCreds({ apiKey: 'sk-http-test' })
  const hub = new hubMod.EventHub({ counters })
  const audioStore = new storeMod.AudioStore()
  const deps = {
    configStore,
    aliyun: () => {
      aliyunSvc.setConfig(configStore.current())
      return aliyunSvc
    },
    hub,
    audioStore,
    logger: { info() {}, warn() {}, debug() {} },
    counters,
    speak: (cfg, text, voice) => routesMod.speak(deps, cfg, text, voice),
  }
  const handler = routesMod.createHandler(deps)
  return { deps, handler, configStore, hub, audioStore }
}

async function call(handler, { method = 'GET', url = '/', headers = {}, body = null }) {
  const req = new FakeReq({ method, url, headers, body })
  const res = new FakeRes()
  const promise = handler(req, res)
  req.start()
  await promise
  return { res, json: res.json, text: res.text, status: res.status }
}

await t('G1 health / bootstrap 可读，bootstrap 带 vad 与 endpoints', async () => {
  const { handler, hub } = await makeDeps()
  const health = await call(handler, { url: '/audio/api/health' })
  assert.equal(health.status, 200)
  assert.equal(health.json.plugin, 'mira_audio')
  const boot = await call(handler, { url: '/audio/api/bootstrap' })
  assert.equal(boot.status, 200)
  assert.ok(boot.json.endpoints.events)
  assert.equal(boot.json.config.vad.silenceMs, 650)
  assert.equal(boot.json.features.configured, true)
  assert.equal(JSON.stringify(boot.json).includes('sk-http-test'), false)
  hub.dispose()
})

await t('G2 跨站请求 403', async () => {
  const { handler, hub } = await makeDeps()
  const bad = await call(handler, { url: '/audio/api/bootstrap', headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } })
  assert.equal(bad.status, 403)
  assert.equal(bad.json.error.code, 'http/forbidden')
  const ok = await call(handler, { url: '/audio/api/bootstrap', headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } })
  assert.equal(ok.status, 200)
  hub.dispose()
})

await t('G3 POST /say：合成 → 广播 say → 音频可取回', async () => {
  const { handler, hub, audioStore } = await makeDeps({
    fetchRoutes: [
      ['/services/audio/tts/SpeechSynthesizer', () => jsonResponse({ output: { audio: { url: TTS_URL } } })],
      ['fake-audio.invalid', () => audioBytes(64)],
    ],
  })
  const res = new FakeRes()
  hub.attach(new FakeReq({ headers: {} }), res)
  const out = await call(handler, { url: '/audio/api/say', method: 'POST', body: { text: '你好' } })
  assert.equal(out.json.ok, true)
  assert.equal(out.json.delivered, true)
  assert.ok(String(out.json.url).startsWith('/audio/api/audio/'))
  assert.ok(res.text.includes('"type":"say"'))
  const id = String(out.json.url).split('/').pop()
  const audio = await call(handler, { url: '/audio/api/audio/' + id })
  assert.equal(audio.status, 200)
  assert.equal(audio.res.headers['content-type'], 'audio/wav')
  assert.equal(audioStore.get(id).buffer.length, 64)
  hub.dispose()
})

await t('G4 POST /asr：只回文本（插话由输入侧负责）', async () => {
  const { handler, hub } = await makeDeps({
    fetchRoutes: [['multimodal-generation', () => jsonResponse({ output: { text: '我回来了' } })]],
  })
  const out = await call(handler, {
    url: '/audio/api/asr',
    method: 'POST',
    body: { base64: 'AAAA', mime: 'audio/wav', sampleRate: 16000 },
  })
  assert.equal(out.status, 200)
  assert.equal(out.json.text, '我回来了')
  assert.equal(out.json.steered, undefined, 'audio 不该自己往会话里插话')
  hub.dispose()
})

await t('G5 settings：key 不回显，能写回配置与 600 凭据', async () => {
  const { handler, configStore, hub } = await makeDeps({ creds: false })
  const view = await call(handler, { url: '/audio/api/settings' })
  assert.equal(view.status, 200)
  assert.equal(view.json.keyConfigured, false)
  const saved = await call(handler, {
    url: '/audio/api/settings',
    method: 'POST',
    body: { values: { tts: { voice: 'Serena' }, vad: { silenceMs: 800 } }, apiKey: 'sk-new-key' },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.keyWritten, true)
  assert.equal(configStore.current().tts.voice, 'Serena')
  assert.equal(configStore.current().vad.silenceMs, 800)
  const creds = JSON.parse(readFileSync(join(configStore.baseDir, 'creds', 'dashscope.json'), 'utf8'))
  assert.equal(creds.apiKey, 'sk-new-key')
  assert.equal(saved.text.includes('sk-new-key'), false)
  const after = await call(handler, { url: '/audio/api/settings' })
  assert.equal(after.json.keyConfigured, true)
  hub.dispose()
})

await t('G6 未知音频 id：404 audio/not-found', async () => {
  const { handler, hub } = await makeDeps()
  const out = await call(handler, { url: '/audio/api/audio/nope' })
  assert.equal(out.status, 404)
  assert.equal(out.json.error.code, 'audio/not-found')
  hub.dispose()
})

/* ══════════════════════════════════════════════════════════
 * H. 工具
 * ══════════════════════════════════════════════════════════ */

async function makeToolEnv({ withClient = true, fetchRoutes = [] } = {}) {
  const base = join(SANDBOX, 'tools-' + Math.random().toString(36).slice(2, 8))
  const configStore = new configMod.ConfigStore({ baseDir: base, patch: {} })
  configStore.load()
  const counters = kit.makeCounters()
  const aliyunSvc = new aliyunMod.AliyunService({
    config: configStore.current(),
    baseDir: base,
    configFile: configStore.file,
    fetchImpl: makeFetch(fetchRoutes),
  })
  aliyunSvc.writeCreds({ apiKey: 'sk-tool-test' })
  const hub = new hubMod.EventHub({ counters })
  const audioStore = new storeMod.AudioStore()
  let clientRes = null
  if (withClient) {
    clientRes = new FakeRes()
    hub.attach(new FakeReq({ headers: {} }), clientRes)
  }
  const deps = {
    configStore,
    aliyun: () => {
      aliyunSvc.setConfig(configStore.current())
      return aliyunSvc
    },
    hub,
    audioStore,
    logger: { info() {}, warn() {}, debug() {} },
    counters,
    speak: (cfg, text, voice) => routesMod.speak(deps, cfg, text, voice),
  }
  deps.statusView = () => toolsMod.statusView(deps)
  const ctx = makeCtx()
  const dispose = toolsMod.registerTools(ctx, deps)
  return { ctx, deps, dispose, hub, clientRes, registered: ctx.registered }
}

await t('H1 注册 2 个工具', async () => {
  const env = await makeToolEnv()
  assert.deepEqual([...env.registered.keys()].sort(), [...toolsMod.TOOL_NAMES].sort())
  assert.equal(toolsMod.TOOL_NAMES.length, 2)
  env.dispose()
  env.hub.dispose()
})

await t('H2 audio_say：没有页面 → delivery/failed；空文本 → tts/failed', async () => {
  const env = await makeToolEnv({ withClient: false })
  const noPage = JSON.parse(await env.registered.get('audio_say').execute({ text: '你好' }, {}))
  assert.equal(noPage.ok, false)
  assert.equal(noPage.error.code, 'delivery/failed')
  const empty = JSON.parse(await env.registered.get('audio_say').execute({ text: '  ' }, {}))
  assert.equal(empty.error.code, 'tts/failed')
  env.dispose()
  env.hub.dispose()
})

await t('H3 audio_say：有页面 → 合成 + 广播；audio_status 不带 key', async () => {
  const env = await makeToolEnv({
    fetchRoutes: [
      ['/services/audio/tts/SpeechSynthesizer', () => jsonResponse({ output: { audio: { url: TTS_URL } } })],
      ['fake-audio.invalid', () => audioBytes(48)],
    ],
  })
  const said = JSON.parse(await env.registered.get('audio_say').execute({ text: '你好呀' }, {}))
  assert.equal(said.ok, true)
  assert.equal(said.clients, 1)
  assert.ok(env.clientRes.text.includes('"type":"say"'))
  const status = JSON.parse(await env.registered.get('audio_status').execute({}, {}))
  assert.equal(status.ok, true)
  assert.equal(status.plugin, 'mira_audio')
  assert.equal(status.credentials.configured, true)
  assert.equal(JSON.stringify(status).includes('sk-tool-test'), false)
  assert.equal(status.vad.silenceMs, 650)
  env.dispose()
  env.hub.dispose()
})

/* ══════════════════════════════════════════════════════════
 * I. 入口装配 / 单实例 / 退场
 * ══════════════════════════════════════════════════════════ */

await t('I1 apply：提供服务 + 2 个工具 + /audio 路由', () => {
  const ctx = makeCtx()
  try {
    const result = indexMod.apply(ctx, {})
    assert.equal(result.ok, true)
    assert.equal(result.service, 'miraAudio')
    assert.equal(result.tools, 2)
    assert.equal(ctx.registered.size, 2)
    assert.equal(ctx.routes.length, 1)
    assert.equal(ctx.routes[0].path, '/audio')
    const api = ctx.provided.get('miraAudio')
    assert.ok(api && typeof api.say === 'function' && typeof api.transcribe === 'function')
    assert.ok(typeof api.createSegmenter === 'function')
    assert.ok(typeof api.describeImage === 'function')
    assert.equal(typeof api.vad().silenceMs, 'number')
    assert.equal(JSON.parse(readFileSync(result.configFile, 'utf8')).schemaVersion, 1)
  } finally {
    ctx.dispose()
  }
})

await t('I2 第二个实例被拒；退场后可重新装配', () => {
  const ctx1 = makeCtx()
  const ctx2 = makeCtx()
  try {
    indexMod.apply(ctx1, {})
    const second = indexMod.apply(ctx2, {})
    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'plugin/instance')
    assert.equal(ctx2.registered.size, 0)
  } finally {
    ctx1.dispose()
    ctx2.dispose()
  }
  const again = makeCtx()
  try {
    assert.equal(indexMod.apply(again, {}).ok, true)
  } finally {
    again.dispose()
  }
})

await t('I3 enabled=false：不注册任何东西并返回 plugin/disabled', () => {
  const ctx = makeCtx()
  try {
    const result = indexMod.apply(ctx, { enabled: false })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'plugin/disabled')
    assert.equal(ctx.registered.size, 0)
  } finally {
    ctx.dispose()
  }
})

await t('I4 凭据迁移：旧 muse_vtuber 的 key 搬到新目录（600）', () => {
  const home = process.env.DSH_HOME
  const legacyDir = join(home, 'mira_config', 'muse_vtuber', 'creds')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, 'dashscope.json'), JSON.stringify({ schemaVersion: 1, apiKey: 'sk-legacy-key' }), { mode: 0o600 })
  // 清掉本插件自己的凭据（前面的用例可能建过）
  rmSync(join(home, 'mira_config', 'mira_audio', 'creds'), { recursive: true, force: true })
  const ctx = makeCtx()
  try {
    indexMod.apply(ctx, {})
    const creds = JSON.parse(readFileSync(join(home, 'mira_config', 'mira_audio', 'creds', 'dashscope.json'), 'utf8'))
    assert.equal(creds.apiKey, 'sk-legacy-key')
  } finally {
    ctx.dispose()
  }
})

/* ══════════════════════════════════════════════════════════
 * 收尾
 * ══════════════════════════════════════════════════════════ */

try {
  rmSync(SANDBOX, { recursive: true, force: true })
} catch { /* 临时目录清理失败不算失败 */ }

void BASE
if (failures.length) {
  console.log('\n---- 失败明细 ----')
  for (const failure of failures) console.log('· ' + failure)
  console.log('\n==== FAILED（' + pass + ' 过 / ' + failures.length + ' 败）====')
  process.exit(1)
}

console.log('\n==== ALL PASS（通过 ' + pass + ' 项断言）====')
