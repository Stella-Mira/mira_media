/**
 * mira_audio / vad.js —— PCM 断句（VAD 切分）：一段 16bit 单声道 PCM 流 → 一句一句的 WAV
 *
 * 为什么切分住在「声音」插件里：
 *   切分阈值和"什么算一句话"是**声音能力**，与声音从哪里来无关（浏览器麦克风、外部采集器、
 *   以后别的插件喂进来的 PCM 都该用同一份判定）。所以配置在 `mira_audio` 的 `vad` 段，
 *   切分器由 `miraAudio.createSegmenter()` 借给输入侧用，`mira_input` 不再自己写一套阈值。
 *
 * 与浏览器侧 `mira_input` 的麦克风 VAD 是**同一套语义**（threshold / silenceMs / minSpeechMs /
 * maxMs），只是那边在 Float32 上算 RMS，这边在 Int16LE 上算，数值口径一致（都归一到 0..1）。
 */

/** 16bit 单声道 PCM → WAV（ASR 口吃整段 WAV，不吃裸 PCM）。 */
export function pcmToWav(pcm, sampleRate) {
  const rate = Math.max(8000, Number(sampleRate) || 16000)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Int16 小端 PCM 的 RMS（0..1）。断句阈值和浏览器端麦克风 VAD 用的是同一套数。 */
export function pcmRms(pcm) {
  if (!pcm || pcm.length < 2) return 0
  const count = pcm.length >> 1
  let sum = 0
  for (let i = 0; i < count; i += 1) {
    const v = pcm.readInt16LE(i * 2) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / count)
}

/** 统一的 VAD 参数规整（配置里写坏了也给出合法值，绝不因为一个 NaN 就永不断句）。 */
export function normalizeVad(vad = {}) {
  const num = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
  }
  return {
    threshold: num(vad.threshold, 0.02, 0.001, 0.5),
    silenceMs: num(vad.silenceMs, 650, 150, 5000),
    minSpeechMs: num(vad.minSpeechMs, 320, 100, 5000),
    maxMs: num(vad.maxMs, 15000, 1000, 120000),
  }
}

/**
 * PCM 断句器。
 *
 * 用法：
 *   const seg = createSegmenter({ vad, sampleRate: 16000, onUtterance: (u) => … })
 *   seg.push(int16Buffer)   // 每来一块喂一次，返回这一块的 RMS（面板波形可用）
 *   seg.flush()             // 流结束时把最后半句交出去
 *
 * `onUtterance` 收到 { wav: Buffer, speechMs, reason: 'silence'|'max'|'flush', sampleRate }。
 * 太短的杂音（speechMs < minSpeechMs）不会回调 —— 不是错误，是"没听到人说话"。
 */
export class PcmSegmenter {
  constructor({ vad = {}, sampleRate = 16000, maxAudioMs = 30000, onUtterance = null, now = () => Date.now() } = {}) {
    const params = normalizeVad(vad)
    this.sampleRate = Math.max(8000, Number(sampleRate) || 16000)
    this.threshold = params.threshold
    this.silenceMs = params.silenceMs
    this.minSpeechMs = params.minSpeechMs
    this.maxMs = params.maxMs
    this.maxAudioMs = Math.max(this.maxMs, Number(maxAudioMs) || 30000)
    this.onUtterance = onUtterance
    this.now = now
    this.chunks = []
    this.bytes = 0
    this.speechMs = 0
    this.silenceRun = 0
    this.micSince = 0
  }

  get maxBytes() {
    return Math.floor((this.maxAudioMs / 1000) * this.sampleRate * 2)
  }

  /** 正在一句里（说过话但还没切）→ true。面板可以据此显示"在听"。 */
  get speaking() {
    return this.micSince > 0
  }

  /** 喂一块 PCM，返回这一块的 RMS（面板/波形用）。 */
  push(pcm) {
    if (!pcm || pcm.length < 2) return 0
    const ms = (pcm.length / 2 / this.sampleRate) * 1000
    const rms = pcmRms(pcm)
    if (rms > this.threshold) {
      if (this.micSince === 0) this.micSince = this.now()
      this.speechMs += ms
      this.silenceRun = 0
    } else if (this.micSince > 0) {
      this.silenceRun += ms
    }
    this.chunks.push(Buffer.from(pcm))
    this.bytes += pcm.length
    if (this.bytes > this.maxBytes) this.#trim()
    if (this.micSince > 0 && this.silenceRun >= this.silenceMs) this.#cut('silence')
    else if (this.micSince > 0 && this.speechMs >= this.maxMs) this.#cut('max')
    return rms
  }

  flush() {
    if (this.micSince === 0) return null
    return this.#cut('flush')
  }

  /** 丢掉半句话（采集端断流/用户关麦克风时用：不要把没说完的残片当一句话送识别）。 */
  reset() {
    this.chunks = []
    this.bytes = 0
    this.speechMs = 0
    this.silenceRun = 0
    this.micSince = 0
  }

  #trim() {
    // 只留最近 maxAudioMs：从头丢整块
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const dropped = this.chunks.shift()
      this.bytes -= dropped.length
    }
  }

  #cut(reason) {
    const audio = this.chunks.length ? Buffer.concat(this.chunks) : Buffer.alloc(0)
    const speechMs = Math.round(this.speechMs)
    const enough = speechMs >= this.minSpeechMs && audio.length >= this.sampleRate * 0.1 * 2
    this.chunks = []
    this.bytes = 0
    this.speechMs = 0
    this.silenceRun = 0
    this.micSince = 0
    if (!enough) return null
    const value = { wav: pcmToWav(audio, this.sampleRate), speechMs, reason, sampleRate: this.sampleRate }
    if (typeof this.onUtterance === 'function') this.onUtterance(value)
    return value
  }
}

/** 给 mira_input 等调用方用的工厂（配置热生效后下一次建段器就用新阈值）。 */
export function createSegmenter({ vad = {}, sampleRate = 16000, maxAudioMs = 30000, onUtterance = null, now } = {}) {
  return new PcmSegmenter({ vad, sampleRate, maxAudioMs, onUtterance, now })
}
