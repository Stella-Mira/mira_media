/**
 * mira_media — 客户端模块（浏览器侧）
 *
 * 两个注册点：
 *   1) **全局播放器**（不占槽位）：任一页签在场就能出声。它订阅 `/media/api/events` 的 `say` 帧，
 *      2.0.0 起**不播放**：合成只回字节，播放搬到 mira_device
 *      （muse_vtuber 用它做 LIVE2D 口型与频谱环，不需要自己再播一遍 —— 播两遍就是双重声音）。
 *   2) `settings.section` → 设置页「声音」：TTS / ASR / 断句（VAD）与阿里云 API key。
 *
 * 事实源：
 *   · 浏览器侧只做"播"和"配"，合成/识别/凭据全在宿主（`/media/api/*`，同源 + CSRF 守卫）。
 *   · 与别的插件的契约是宿主服务（miraMedia），不再有页面全局对象
 *     是唯一稳定的交接点（README §4 写了字段与语义）。
 *   · `<audio>` 的自动播放会被浏览器拦：这里在首次用户手势时补一次 resume，并把待播的 URL 补上。
 */

function miraMediaClient(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/media/api'
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
          check('tts', 'enabled', '启用 TTS', '关掉后 device_say 会明确报 config/missing。'),
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
          ),
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
for (const id of ['mira_media', 'mira_media_ui']) {
  try {
    window.__ModuleLoader__.load({ id, factory: miraMediaClient })
  } catch (error) {
    console.error('[mira_media] 注册 client 模块失败：' + id, error)
  }
}
