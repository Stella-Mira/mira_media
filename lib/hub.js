/**
 * mira_audio / hub.js —— SSE 事件总线（宿主 → 所有浏览器页签）
 *
 * 只有两个方向中的**下行**：这个插件是"声音"的基础设施，别的插件（muse_vtuber、以后的直播/语音
 * 房间）通过 `miraAudio.say()` 说话；页面侧的播放器收到 `say` 帧就播。上行（浏览器回执）不需要，
 * 因为这里没有"要页面做一件事并等结果"的指令 —— 那种请求/回执在 mira_input（采集）里。
 *
 * 帧类型：
 *   hello  连接建立（带 seq 起点，便于前端重连后判断是否断档）
 *   say    要页面说话：{ text, url, id, mime, chars, truncated, voice }
 *
 * 为什么播放器在 mira_audio 的客户端而不是形象页：声音输出是 **mira_audio 的能力**，
 * 别的插件（不装 muse_vtuber）也应该能说话；形象只是订阅同一批 `say` 帧来对口型。
 */

import { randomUUID } from 'node:crypto'

export class EventHub {
  /**
   * @param {object} options
   * @param {object} [options.logger]
   * @param {object} [options.counters]
   * @param {() => number} [options.now] 注入时钟（自检用）
   */
  constructor({ logger = null, counters = null, now = Date.now } = {}) {
    this.logger = logger
    this.counters = counters || { bump() {}, get() { return 0 }, snapshot() { return {} } }
    this.now = now
    this.clients = new Set()
    this.seq = 0
    this.lastSay = null
    this.pingTimer = null
    this.disposed = false
  }

  /** 挂一个 SSE 客户端；返回关闭函数。 */
  attach(req, res) {
    if (this.disposed) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('plugin disposed')
      return () => {}
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate',
      connection: 'keep-alive',
      // 反向代理（mira_proxy）后面必须关掉缓冲，否则事件要攒满一屏才到
      'x-accel-buffering': 'no',
    })
    const client = { res, id: randomUUID(), at: this.now() }
    this.clients.add(client)
    this.send(client, 'hello', { seq: this.seq, clientId: client.id, at: new Date(this.now()).toISOString() })
    this.ensurePing()
    const drop = () => {
      this.clients.delete(client)
    }
    try {
      req.on?.('close', drop)
      req.on?.('error', drop)
      res.on?.('close', drop)
      res.on?.('error', drop)
    } catch {
      drop()
    }
    this.counters.bump('sse.connect')
    return drop
  }

  get clientCount() {
    return this.clients.size
  }

  ensurePing() {
    if (this.pingTimer) return
    this.pingTimer = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.res.write(': ping ' + this.now() + '\n\n')
        } catch {
          this.clients.delete(client)
        }
      }
    }, 15000)
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref()
  }

  send(client, type, payload) {
    this.seq += 1
    const frame = { seq: this.seq, type, at: new Date(this.now()).toISOString(), ...(payload || {}) }
    try {
      client.res.write('data: ' + JSON.stringify(frame) + '\n\n')
      return true
    } catch {
      this.clients.delete(client)
      return false
    }
  }

  /** 广播一帧给所有浏览器页签。返回送达的客户端数。 */
  broadcast(type, payload) {
    let sent = 0
    for (const client of [...this.clients]) {
      if (this.send(client, type, payload)) sent += 1
    }
    return sent
  }

  status() {
    return {
      clients: this.clients.size,
      seq: this.seq,
      lastSay: this.lastSay,
      counters: this.counters.snapshot(),
    }
  }

  dispose() {
    this.disposed = true
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    for (const client of [...this.clients]) {
      try {
        client.res.end('data: {"type":"bye"}\n\n')
      } catch { /* 忽略 */ }
    }
    this.clients.clear()
  }
}
