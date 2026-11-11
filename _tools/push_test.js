#!/usr/bin/env node
/**
 * 本地手动触发一次提醒推送（不开端口、不经过网络）
 *
 * 旧版本里靠 HTTP 接口 POST /api/v1/wx/push-now 来"立即发一条"，
 * 那个接口没有任何鉴权，知道隧道域名就能被别人调用来烧额度，因此已移除。
 * 需要立刻验证推送是否配通时，用这个脚本在命令行里发。
 *
 * 用法：
 *   node _tools/push_test.js --dry           预览：只打印"将会发什么"，不发送、不扣额度
 *   node _tools/push_test.js                 真实发送，但只发现在这个时间点该发的
 *   node _tools/push_test.js --force         忽略时间窗，把今天到点的未完成提醒都发一遍（会扣额度）
 *   node _tools/push_test.js --limit 3       最多发 3 条（避免一次烧太多额度）
 *
 * 前提：_tmpapi/wechat_conf.json 里已经填好 appid / secret，
 *       并且本人已在小程序里点过"开启提醒"授权过订阅消息。
 */
const { pushOnce } = require('./wechat-notifier')

const args = process.argv.slice(2)
const has = (f) => args.includes(f)
const val = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}

const dry = has('--dry')
const force = has('--force')
const limit = Number(val('--limit') || 0) || 0

console.log('[push_test] dry=' + dry + ' force=' + force + ' limit=' + (limit || '不限'))
if (force && !dry) {
  console.log('[push_test] 注意：--force 会真实发送，每发一条消耗一次订阅额度')
}

;(async () => {
  try {
    const r = await pushOnce({ dry: dry, force: force, limit: limit })
    console.log('[push_test] 结果：')
    console.log(JSON.stringify(r, null, 2))
    if (dry) console.log('[push_test] 以上为预览，未真实发送')
  } catch (e) {
    console.error('[push_test] 失败：', e && e.stack ? e.stack : e)
    process.exit(1)
  }
})()
