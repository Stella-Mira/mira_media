/**
 * mira_audio — 客户端模块（浏览器侧）
 *
 * 两个注册点：
 *   1) **全局播放器**（不占槽位）：任一页签在场就能出声。它订阅 `/audio/api/events` 的 `say` 帧，
 *      合成好的音频由 `<audio>` 播；同时暴露 `window.__miraAudio__` 给同一页面里的别的插件
 *      （muse_vtuber 用它做 LIVE2D 口型与频谱环，不需要自己再播一遍 —— 播两遍就是双重声音）。
 *   2) `settings.section` → 设置页「声音」：TTS / ASR / 断句（VAD）与阿里云 API key。
 *
 * 事实源：
 *   · 浏览器侧只做"播"和"配"，合成/识别/凭据全在宿主（`/audio/api/*`，同源 + CSRF 守卫）。
 *   · 与别的插件的契约是**页面全局对象**，不是 import：插件各自独立打包，`window.__miraAudio__`
 *     是唯一稳定的交接点（README §4 写了字段与语义）。
 *   · `<audio>` 的自动播放会被浏览器拦：这里在首次用户手势时补一次 resume，并把待播的 URL 补上。
 */

function miraAudioClient(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/audio/api'
    const PLAYER_VERSION = 1

    /* ══════════════════════════════════════════════════════════
     * 0. 小工具
     * ══════════════════════════════════════════════════════════ */

    function errorText(error, status) {
      if (!error) return '请求失败（HTTP ' + status + '）'
      const code = error.code ? '[' + error.code + '] ' : ''
      const hint = error.hint ? '；' + error.hint : ''
      return code + (error.message || '未知错误') + hint
    }

    async function postJson(path, body) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const json = await response.json().catch(() => null)
      if (!response.ok || !json || json.ok !== true) {
        throw new Error(errorText(json && json.error, response.status))
      }
      return json
    }

    async function getJson(path) {
      const response = await fetch(API + path, { headers: { accept: 'application/json' } })
      const json = await response.json().catch(() => null)
      if (!response.ok || !json || json.ok !== true) {
        throw new Error(errorText(json && json.error, response.status))
      }
      return json
    }

    /* ══════════════════════════════════════════════════════════
     * 1. 全局播放器（模块级单例：跨页签、跨插件）
     * ══════════════════════════════════════════════════════════ */

    const player = {
      audio: null,
      ctx: null,
      source: null,
      analyser: null,
      speaking: false,
      level: 0,
      text: '',
      error: '',
      url: '',
      pendingUrl: '',
      raf: 0,
      listeners: new Set(),
    }

    function emitPlayer(patch) {
      if (patch) Object.assign(player, patch)
      for (const fn of [...player.listeners]) {
        try {
          fn(playerState())
        } catch (error) {
          console.error('[mira_audio] 播放器订阅者出错', error)
        }
      }
    }

    function playerState() {
      return {
        ready: !!player.audio,
        speaking: player.speaking,
        level: player.level,
        text: player.text,
        url: player.url,
        error: player.error,
      }
    }

    /** 造 `<audio>` 与（能建就建的）分析器；建不了也不挡播放。 */
    function ensureAudio() {
      if (player.audio) return player.audio
      const audio = document.createElement('audio')
      audio.preload = 'auto'
      audio.crossOrigin = 'anonymous'
      audio.style.display = 'none'
      audio.dataset.miraAudio = 'player'
      document.body?.appendChild(audio)
      audio.addEventListener('ended', () => {
        stopLevelLoop()
        emitPlayer({ speaking: false, level: 0 })
      })
      audio.addEventListener('error', () => {
        stopLevelLoop()
        emitPlayer({ speaking: false, level: 0, error: '音频播放失败（文件可能已过期，10 分钟内有效）' })
      })
      player.audio = audio
      return audio
    }

    /** AudioContext 只在真的要画电平（形象口型/频谱环）时才建；没有它也能出声。 */
    function ensureGraph() {
      const audio = ensureAudio()
      if (player.analyser) return player.analyser
      const AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return null
      try {
        const ctx = new AC()
        const source = ctx.createMediaElementSource(audio)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        analyser.smoothingTimeConstant = 0.5
        source.connect(analyser)
        analyser.connect(ctx.destination)
        player.ctx = ctx
        player.source = source
        player.analyser = analyser
        const bin = new Uint8Array(analyser.fftSize)
        player.bin = bin
        return analyser
      } catch (error) {
        // MediaElementSource 一个元素只能建一次，或浏览器不支持：退化成"只出声、不画电平"
        player.graphError = error && error.message ? error.message : String(error)
        return null
      }
    }

    function startLevelLoop() {
      if (player.raf) return
      const tick = () => {
        player.raf = window.requestAnimationFrame(tick)
        const analyser = player.analyser
        if (!analyser || !player.bin) return
        try {
          analyser.getByteTimeDomainData(player.bin)
        } catch {
          return
        }
        let sum = 0
        for (let i = 0; i < player.bin.length; i++) {
          const v = (player.bin[i] - 128) / 128
          sum += v * v
        }
        // 口型要"响一点"：RMS 开根号再抬个增益，静音时立刻归零
        player.level = Math.min(1, Math.sqrt(sum / player.bin.length) * 3.2)
      }
      player.raf = window.requestAnimationFrame(tick)
    }

    function stopLevelLoop() {
      if (player.raf) window.cancelAnimationFrame(player.raf)
      player.raf = 0
      player.level = 0
    }

    /** 真正开播（含自动播放被拦时的补救）。 */
    async function playUrl(url) {
      if (typeof url !== 'string' || url === '') return
      const audio = ensureAudio()
      ensureGraph()
      if (player.ctx && player.ctx.state === 'suspended') {
        try { await player.ctx.resume() } catch { /* 等用户手势 */ }
      }
      player.pendingUrl = ''
      player.url = url
      audio.src = url
      try {
        await audio.play()
        emitPlayer({ speaking: true, error: '' })
        startLevelLoop()
      } catch (error) {
        // 浏览器要求先有用户手势：把这次播放挂起，等第一次点击/按键再补
        player.pendingUrl = url
        emitPlayer({ speaking: false, error: '需要先在页面上点一下才能播放声音（浏览器自动播放策略）' })
        armGestureUnlock()
      }
    }

    let gestureArmed = false
    function armGestureUnlock() {
      if (gestureArmed) return
      gestureArmed = true
      const unlock = () => {
        window.removeEventListener('pointerdown', unlock, true)
        window.removeEventListener('keydown', unlock, true)
        gestureArmed = false
        if (player.ctx && player.ctx.state === 'suspended') {
          player.ctx.resume().catch(() => { /* 下次手势再试 */ })
        }
        const pending = player.pendingUrl
        player.pendingUrl = ''
        if (pending) void playUrl(pending)
      }
      window.addEventListener('pointerdown', unlock, true)
      window.addEventListener('keydown', unlock, true)
    }

    /** 页面 → 宿主的事件流（say）。 */
    let stream = null
    function ensureStream() {
      if (stream || typeof window.EventSource !== 'function') return stream
      stream = new window.EventSource(API + '/events')
      stream.addEventListener('message', (event) => {
        let frame
        try {
          frame = JSON.parse(event.data)
        } catch {
          return
        }
        if (!frame || typeof frame !== 'object') return
        if (frame.type !== 'say') return
        const text = String(frame.text || '')
        const url = String(frame.url || '')
        emitPlayer({ text })
        if (url !== '') void playUrl(url)
      })
      return stream
    }

    /**
     * 对外的页面全局契约（别的插件从这里拿口型/频谱要用的电平）。
     * 已经有人注册过就不再覆盖：同包可能以另一个 specifier 装进 profile（见文件末尾的注册）。
     */
    function publishGlobal() {
      const existing = window.__miraAudio__
      if (existing && existing.version >= PLAYER_VERSION) return existing
      const api = {
        version: PLAYER_VERSION,
        /** 当前播放状态 { ready, speaking, level, text, url, error }。 */
        state: () => playerState(),
        /** 订阅播放状态变化，返回取消函数。 */
        subscribe(fn) {
          player.listeners.add(fn)
          return () => player.listeners.delete(fn)
        },
        /** 0..1 的实时音量（LIVE2D 口型/频谱环用）；没在播时是 0。 */
        level: () => player.level,
        /** 分析器（想在别处自己画频谱时用，可能是 null）。 */
        analyser: () => player.analyser,
        /** 让页面播一段宿主已经合成好的音频（url 必须是 /audio/api/audio/<id>）。 */
        play: (url) => playUrl(url),
        /** 当前页面的播放器有没有真正建好。 */
        ready: () => !!player.audio,
      }
      window.__miraAudio__ = api
      return api
    }

    /* ══════════════════════════════════════════════════════════
     * 2. 样式（只吃主题变量，没写死颜色）
     * ══════════════════════════════════════════════════════════ */

    const CSS = [
      '.ma-set{display:flex;flex-direction:column;gap:16px;font:inherit;color:inherit;max-width:760px;}',
      '.ma-set-title{margin:0;font-size:16px;font-weight:600;}',
      '.ma-set-sub{margin:4px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary, inherit);}',
      '.ma-set-group{margin:0;padding:12px 14px 14px;display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l2, currentColor);border-radius:var(--dsw-radius-md, 8px);min-width:0;}',
      '.ma-set-legend{padding:0 4px;margin:0 0 2px;font-size:13px;font-weight:600;}',
      '.ma-set-row{display:grid;grid-template-columns:132px minmax(0, 1fr);gap:6px 12px;align-items:start;font-size:13px;min-width:0;}',
      '.ma-set-mid{display:flex;flex-direction:column;gap:4px;min-width:0;}',
      '.ma-set-label{padding-top:6px;font-size:13px;}',
      '.ma-set-hint{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary, inherit);}',
      '.ma-set-input{box-sizing:border-box;width:100%;font:inherit;font-size:13px;padding:5px 8px;border-radius:var(--dsw-radius-sm, 6px);border:1px solid var(--dsw-alias-border-l2, currentColor);background:var(--dsw-alias-bg-layer-2, transparent);color:inherit;}',
      '.ma-set-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding-top:5px;}',
      '.ma-set-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;}',
      '.ma-set-button{font:inherit;font-size:13px;padding:6px 16px;border-radius:var(--dsw-radius-md, 8px);border:1px solid var(--dsw-alias-border-l2, currentColor);background:var(--dsw-alias-bg-layer-2, transparent);color:inherit;cursor:pointer;}',
      '.ma-set-button:disabled{opacity:.55;cursor:default;}',
      '.ma-notice{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary, inherit);}',
      '.ma-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary, #d25);}',
      '.ma-notice[data-kind="success"]{color:var(--dsw-alias-state-success-primary, #2a2);}',
      '.ma-err{font-size:11px;line-height:1.5;color:var(--dsw-alias-state-error-primary, #d25);word-break:break-word;}',
    ].join('\n')

    /* ══════════════════════════════════════════════════════════
     * 3. 设置页「声音」
     * ══════════════════════════════════════════════════════════ */

    function toDraft(raw) {
      const v = raw && typeof raw === 'object' ? raw : {}
      const group = (name, keys) => {
        const source = v[name] && typeof v[name] === 'object' ? v[name] : {}
        const out = {}
        for (const key of keys) out[key] = source[key]
        return out
      }
      return {
        tts: group('tts', ['enabled', 'provider', 'base', 'model', 'voice', 'maxChars']),
        asr: group('asr', ['enabled', 'provider', 'base', 'model', 'language']),
        vad: group('vad', ['threshold', 'silenceMs', 'minSpeechMs', 'maxMs']),
      }
    }

    function SettingsSection() {
      const [values, setValues] = React.useState(null)
      const [baseline, setBaseline] = React.useState(null)
      const [apiKey, setApiKey] = React.useState('')
      const [keyConfigured, setKeyConfigured] = React.useState(false)
      const [files, setFiles] = React.useState({ configFile: '', credsFile: '', seededFrom: '' })
      const [warnings, setWarnings] = React.useState([])
      const [notice, setNotice] = React.useState({ kind: 'loading', text: '正在读取声音配置…' })
      const [saving, setSaving] = React.useState(false)
      const [trying, setTrying] = React.useState(false)

      function readBack(json) {
        setValues(toDraft(json.values))
        setBaseline(toDraft(json.values))
        setKeyConfigured(json.keyConfigured === true)
        setFiles({
          configFile: typeof json.configFile === 'string' ? json.configFile : '',
          credsFile: typeof json.credsFile === 'string' ? json.credsFile : '',
          seededFrom: typeof json.seededFrom === 'string' ? json.seededFrom : '',
        })
        setWarnings(Array.isArray(json.warnings) ? json.warnings.map(String) : [])
        if (json.configError && json.configError.message) {
          setNotice({ kind: 'error', text: '当前配置不可用：' + errorText(json.configError, 200) })
        }
      }

      React.useEffect(() => {
        let alive = true
        setNotice({ kind: 'loading', text: '正在读取声音配置…' })
        fetch(API + '/settings', { headers: { accept: 'application/json' } })
          .then((response) => response.json().then((json) => ({ response, json })))
          .then(({ response, json }) => {
            if (!alive) return
            if (!response.ok || !json || json.ok !== true) {
              setNotice({ kind: 'error', text: errorText(json && json.error, response.status) })
              return
            }
            readBack(json)
            setNotice({ kind: 'info', text: '已读取当前配置；修改后点「保存」。TTS/ASR/断句改完立刻生效。' })
          })
          .catch((error) => {
            if (!alive) return
            setNotice({ kind: 'error', text: '读取失败：' + ((error && error.message) || String(error)) })
          })
        return () => { alive = false }
      }, [])

      const patch = (group, key, value) => setValues((prev) => (prev
        ? { ...prev, [group]: { ...prev[group], [key]: value } }
        : prev))

      async function save() {
        if (!values) return
        setSaving(true)
        setNotice({ kind: 'info', text: '正在保存…' })
        const body = { values }
        const trimmed = apiKey.trim()
        if (trimmed !== '') body.apiKey = trimmed
        try {
          const response = await fetch(API + '/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          const json = await response.json().catch(() => ({}))
          if (!response.ok || !json || json.ok !== true) {
            setNotice({ kind: 'error', text: errorText(json && json.error, response.status) })
            return
          }
          setApiKey('')
          readBack(json)
          const changed = Array.isArray(json.changed) && json.changed.length ? json.changed.join('、') : '无改动'
          setNotice({ kind: 'success', text: '已保存：' + changed + (json.keyWritten ? '；API key 已写入 600 凭据文件' : '') })
        } catch (error) {
          setNotice({ kind: 'error', text: '保存失败：' + ((error && error.message) || String(error)) })
        } finally {
          setSaving(false)
        }
      }

      async function trySay() {
        setTrying(true)
        try {
          const out = await postJson('/say', { text: '声音连接正常，我是星辉澪。' })
          setNotice({
            kind: out.delivered ? 'success' : 'error',
            text: out.delivered
              ? '已合成并推送（' + out.chars + ' 字，音色 ' + out.voice + '）；没听到就点一下页面再试。'
              : '合成成功，但没有页面在播（刷新页面后重试）',
          })
        } catch (error) {
          setNotice({ kind: 'error', text: '试听失败：' + ((error && error.message) || String(error)) })
        } finally {
          setTrying(false)
        }
      }

      if (!values) {
        return h('section', { className: 'ma-set', 'aria-label': '声音设置' },
          h('style', null, CSS),
          h('header', null,
            h('h2', { className: 'ma-set-title' }, '声音'),
            h('p', { className: 'ma-set-sub' }, '语音合成、语音识别、断句与阿里云 key。')),
          h('p', { className: 'ma-notice', 'data-kind': notice.kind, role: 'status' }, notice.text))
      }

      const row = (label, control, hint) => h('div', { className: 'ma-set-row', key: label },
        h('span', { className: 'ma-set-label' }, label),
        h('div', { className: 'ma-set-mid' }, control, hint ? h('p', { className: 'ma-set-hint' }, hint) : null))

      const text = (group, key, hint, placeholder) => row(
        key,
        h('input', {
          className: 'ma-set-input',
          type: 'text',
          value: values[group][key] === undefined || values[group][key] === null ? '' : values[group][key],
          placeholder: placeholder || '',
          spellCheck: false,
          onChange: (event) => patch(group, key, event.target.value),
        }),
        hint,
      )

      const number = (group, key, hint, min, max, step) => row(
        key,
        h('input', {
          className: 'ma-set-input',
          type: 'number',
          min,
          max,
          step,
          value: values[group][key] === undefined || values[group][key] === null ? '' : values[group][key],
          onChange: (event) => patch(group, key, event.target.value === '' ? '' : Number(event.target.value)),
        }),
        hint,
      )

      const check = (group, key, label, hint) => row(
        label,
        h('label', { className: 'ma-set-check' },
          h('input', {
            type: 'checkbox',
            checked: values[group][key] === true,
            onChange: (event) => patch(group, key, event.target.checked),
          }),
          h('span', null, label)),
        hint,
      )

      return h('section', { className: 'ma-set', 'aria-label': '声音设置' },
        h('style', null, CSS),
        h('header', null,
          h('h2', { className: 'ma-set-title' }, '声音'),
          h('p', { className: 'ma-set-sub' },
            '语音合成、语音识别与断句（VAD）。这里是三件套里**唯一**保存阿里云 key 的地方：'
            + '输入侧（摄像头/麦克风/采集器）与形象都借这套能力，不再各存一份凭据。')),
        h('fieldset', { className: 'ma-set-group' },
          h('legend', { className: 'ma-set-legend' }, '语音合成（TTS）'),
          check('tts', 'enabled', '启用 TTS', '关掉后 audio_say 会明确报 config/missing。'),
          row('合成方式',
            h('select', {
              className: 'ma-set-input',
              value: values.tts.provider || 'aliyun',
              onChange: (event) => patch('tts', 'provider', event.target.value),
            },
            h('option', { value: 'aliyun' }, '千问原生口（/services/audio/tts/SpeechSynthesizer）'),
            h('option', { value: 'openai' }, 'OpenAI 兼容口（/audio/speech）')),
            '原生口用 api/v1（实测可用），兼容口用 compatible-mode/v1；'
            + '也可以填本机 stream 网关：provider=openai + base=http://127.0.0.1:11089/v1（key 用它的 GATEWAY_API_KEYS）。'),
          text('tts', 'base', '地址（默认 token-plan 的 api/v1）', 'https://token-plan.maas.qianwenaiapi.com/api/v1'),
          text('tts', 'model', '模型名（默认 qwen-audio-3.0-tts-plus）', 'qwen-audio-3.0-tts-plus'),
          text('tts', 'voice', '音色（Qwen-Audio-TTS 是 longan* 系列）', 'longanhuan_v3.6'),
          number('tts', 'maxChars', '单次最长字数，超了截断并回报 truncated', 1, 8000)),
        h('fieldset', { className: 'ma-set-group' },
          h('legend', { className: 'ma-set-legend' }, '语音识别（ASR）'),
          check('asr', 'enabled', '启用语音识别', '关掉后输入侧只显示波形，不识别、不插话。'),
          row('识别方式',
            h('select', {
              className: 'ma-set-input',
              value: values.asr.provider || 'aliyun',
              onChange: (event) => patch('asr', 'provider', event.target.value),
            },
            h('option', { value: 'aliyun' }, '千问原生口（多模态生成，实测可用）'),
            h('option', { value: 'openai' }, 'OpenAI 兼容口（/audio/transcriptions）')),
            '原生口用 api/v1，兼容口用 compatible-mode/v1；本机 stream 网关同样是 openai 口'
            + '（base=http://127.0.0.1:11089/v1，model 随便填，网关按能力路由）。'),
          text('asr', 'base', '地址（默认 token-plan 的 api/v1）', 'https://token-plan.maas.qianwenaiapi.com/api/v1'),
          text('asr', 'model', '模型名（默认 qwen-audio-3.0-asr-flash）', 'qwen-audio-3.0-asr-flash'),
          text('asr', 'language', '语言（zh / en…）', 'zh')),
        h('fieldset', { className: 'ma-set-group' },
          h('legend', { className: 'ma-set-legend' }, '断句（VAD）'),
          number('vad', 'threshold', '断句电平阈值（RMS，0.001–0.5），越大越不灵敏；安静环境用默认 0.02。', 0.001, 0.5, 0.001),
          number('vad', 'silenceMs', '静音多久算一句（毫秒，默认 650）', 150, 5000),
          number('vad', 'minSpeechMs', '最短算说话的时长（毫秒，默认 320）', 100, 5000),
          number('vad', 'maxMs', '一句话最长时长（毫秒，默认 15000，超了强制切段）', 1000, 120000)),
        h('fieldset', { className: 'ma-set-group' },
          h('legend', { className: 'ma-set-legend' }, 'API key（云端或本机网关）'),
          row('API key',
            h('input', {
              className: 'ma-set-input',
              type: 'password',
              value: apiKey,
              autoComplete: 'off',
              placeholder: keyConfigured ? '已配置，留空 = 不改' : '未配置，填入后保存',
              onChange: (event) => setApiKey(event.target.value),
            }),
            keyConfigured
              ? '当前已配置（只显示状态，永不回显）；留空保存不会覆盖。TTS / ASR / 识图共用这一份。'
              : '未配置。保存后写进 ' + (files.credsFile || 'creds/dashscope.json') + '（权限 600）。'
                + '填阿里云 DashScope key，或本机 stream 网关的 GATEWAY_API_KEYS（两者都只用这一处）。')),
        h('div', { className: 'ma-set-actions' },
          h('button', {
            type: 'button',
            className: 'ma-set-button',
            disabled: saving,
            onClick: () => { void save() },
          }, saving ? '保存中…' : '保存'),
          h('button', {
            type: 'button',
            className: 'ma-set-button',
            disabled: saving || !baseline,
            onClick: () => {
              if (!baseline) return
              setValues(toDraft(baseline))
              setApiKey('')
              setNotice({ kind: 'info', text: '已撤销未保存的改动。' })
            },
          }, '撤销改动'),
          h('button', {
            type: 'button',
            className: 'ma-set-button',
            disabled: trying || saving,
            onClick: () => { void trySay() },
            title: '用当前配置合成一句并推给页面播放，验证 key / 模型 / 网络',
          }, trying ? '试听中…' : '试听')),
        h('p', { className: 'ma-notice', 'data-kind': notice.kind, role: 'status', 'aria-live': 'polite' }, notice.text),
        files.seededFrom
          ? h('p', { className: 'ma-set-hint' }, '首次创建时已从旧 muse_vtuber 配置迁移 TTS/ASR/VAD：' + files.seededFrom)
          : null,
        warnings.length
          ? h('ul', { className: 'ma-set-hint' }, warnings.map((warning, index) => h('li', { key: index }, warning)))
          : null,
        files.configFile ? h('p', { className: 'ma-set-hint' }, '配置文件：' + files.configFile) : null,
        files.credsFile ? h('p', { className: 'ma-set-hint' }, '凭据文件：' + files.credsFile + '（600，永不回显）') : null)
    }

    /* ══════════════════════════════════════════════════════════
     * 4. 导出：播放器（无槽位）+ 设置页
     * ══════════════════════════════════════════════════════════ */

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          publishGlobal()
          ensureStream()
          armGestureUnlock()
          return () => {
            if (stream) {
              try { stream.close() } catch { /* 忽略 */ }
              stream = null
            }
            stopLevelLoop()
            try {
              if (player.audio) {
                player.audio.pause()
                player.audio.src = ''
              }
            } catch { /* 忽略 */ }
            player.listeners.clear()
          }
        })

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'mira-audio',
          order: 45,
          label: () => '声音',
        }, SettingsSection))
      },
    }
}

/**
 * 注册 id 必须等于宿主认的**包 specifier**（`dsh-client-modules` 取的是 loader 条目的
 * `fiber.entry?.options.name`，加载完还会校验「bundle 有没有用这个 id 注册」）。
 * 同一个包可能以不同 specifier 装进 profile（例如为了不重启宿主而用别名替换旧实现），
 * 所以两个 id 都注册：只有宿主清单里那个会被真正 import，另一个只是躺着的工厂。
 */
for (const id of ['mira_audio', 'mira_audio_ui']) {
  try {
    window.__ModuleLoader__.load({ id, factory: miraAudioClient })
  } catch (error) {
    console.error('[mira_audio] 注册 client 模块失败：' + id, error)
  }
}
