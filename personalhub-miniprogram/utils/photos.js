/**
 * 饮食照片记录（现阶段存小程序本地，后续可平滑切到电脑端存储）
 *
 * 存储：wx.env.USER_DATA_PATH 下的持久文件 + Storage 里的索引
 *   索引 key：ph_photos_<账号>  →  { [日期]: [{ id, path, created_at }] }
 * 约束：每天最多 12 张、自动清理 90 天前的记录，避免占满本地空间。
 *
 * 接口形状（list/upload/remove）刻意与将来的服务端版本一致：
 * 到时候只需要把这三处实现换成 HTTP 请求，页面代码不用动。
 */
const api = require('./api')
const util = require('./util')

const MAX_PER_DAY = 12
const KEEP_DAYS = 90

function fs() {
  return wx.getFileSystemManager()
}

function storeKey() {
  const user = api.getUser()
  return 'ph_photos_' + ((user && user.username) || 'me')
}

function readStore() {
  try {
    return wx.getStorageSync(storeKey()) || {}
  } catch (e) {
    return {}
  }
}

function writeStore(data) {
  try {
    wx.setStorageSync(storeKey(), data)
  } catch (e) {}
}

/** 清掉太老的日期，防止索引无限膨胀 */
function prune(data) {
  const min = util.addDays(util.today(), -KEEP_DAYS)
  Object.keys(data).forEach((d) => {
    if (d < min) {
      data[d].forEach((it) => {
        try {
          fs().unlink({ filePath: it.path, fail: () => {} })
        } catch (e) {}
      })
      delete data[d]
    }
  })
  return data
}

/** 某天的照片列表，[{ id, url, created_at }]，按时间倒序 */
function list(date) {
  const data = readStore()
  const items = data[date] || []
  return Promise.resolve(items.map((it) => Object.assign({}, it, { url: it.path })))
}

/**
 * 上传一张照片：先压缩，再转成持久文件，写入索引。
 * resolve 一个 { id, url, created_at }。
 */
function upload(date, tempFilePath) {
  return new Promise((resolve, reject) => {
    const done = (p) => {
      fs().saveFile({
        tempFilePath: p,
        success: (r) => {
          const data = prune(readStore())
          const arr = data[date] || []
          if (arr.length >= MAX_PER_DAY) {
            // 超出当日上限：删掉最早一张腾位置
            const old = arr.shift()
            try {
              fs().unlink({ filePath: old.path, fail: () => {} })
            } catch (e) {}
          }
          const item = {
            id: util.uuid(),
            path: r.savedFilePath,
            created_at: new Date().toISOString(),
          }
          arr.push(item)
          data[date] = arr
          writeStore(data)
          resolve(Object.assign({}, item, { url: item.path }))
        },
        fail: () => reject(new Error('保存照片失败')),
      })
    }
    // 高质量原图太占空间，先压一道；压缩失败就用原图
    wx.compressImage({
      src: tempFilePath,
      quality: 55,
      compressedWidth: 1080,
      success: (r) => done(r.tempFilePath),
      fail: () => done(tempFilePath),
    })
  })
}

/** 删除一张照片（索引 + 文件本体） */
function remove(date, id) {
  return new Promise((resolve, reject) => {
    const data = readStore()
    const arr = data[date] || []
    const idx = arr.findIndex((x) => x.id === id)
    if (idx < 0) {
      resolve()
      return
    }
    const hit = arr[idx]
    arr.splice(idx, 1)
    if (arr.length) data[date] = arr
    else delete data[date]
    writeStore(data)
    try {
      fs().unlink({ filePath: hit.path, complete: () => resolve() })
    } catch (e) {
      resolve()
    }
  })
}

module.exports = { list, upload, remove }
