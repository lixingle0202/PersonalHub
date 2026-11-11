/**
 * PersonalHub 小程序 - 接口服务地址配置
 *
 * 说明：
 * 1. baseUrl 必须与网页版指向同一个后端（同一份数据）。
 * 2. 微信小程序正式版要求 request 域名是「已备案的 HTTPS 域名」，
 *    trycloudflare.com 这类临时隧道域名无法加入白名单，
 *    因此开发阶段请在开发者工具中勾选「不校验合法域名」，
 *    上线前请把 baseUrl 换成自己的备案域名（后端部署在同一个域名下即可）。
 * 3. 开发者工具会带上 Origin: https://servicewechat.com，
 *    网页版后端把它当跨站请求返回 403，所以本机联调请走 _tools/proxy.js
 *    （去掉 Origin/Referer 再转发），即下面的 8786 端口。
 */
module.exports = {
  // 后端地址，末尾不要带斜杠。请改成你自己的地址：
  //   本机联调：http://127.0.0.1:8771（先启动 _tools/wechat-notifier.js）
  //   线上/隧道：https://你的域名（已备案的 HTTPS 域名）
  baseUrl: 'http://127.0.0.1:8771',

  // 是否在小程序里打印接口日志，便于排查
  debug: true,

  // 订阅消息模板 id（到期提醒推送用）。留空则由电脑端推送服务自动发现。
  wechatTmplId: '',

  // 主题色预设（与网页版一致）
  themeColors: [
    { name: '星蓝', value: '#5b6cff' },
    { name: '青竹', value: '#1f9d75' },
    { name: '暮橙', value: '#e8813a' },
    { name: '玫紫', value: '#a15ddb' },
    { name: '墨青', value: '#3f7f9e' }
  ]
}
