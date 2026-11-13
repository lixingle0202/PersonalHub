# PersonalHub 小程序 · 增量更新包（2026-11-13）

## 一、这个包里是什么

**只放这几天改动过和新增的文件**，共 32 个（另有本说明 UPDATE.md），全部来自小程序目录 `personalhub-miniprogram`。

包内不包含、也不会覆盖原来的代码：电脑端 `personalhub-web`、旧版小程序里没动过的页面（今日计划、学习计划、协议页、tabBar、styles 等）、`_tools/wechat-notifier.js` 一律没有放进来。

包内目录结构与仓库完全一致 —— 看到 `README.md`、`app.js`、`pages/`、`utils/` 的这一层，就对应小程序代码的根目录。

## 二、文件清单（32 个）

**新增 13 个**

```
cloudfunctions/phgroup/index.js
cloudfunctions/phgroup/package.json
pages/group/index.js  index.json  index.wxml  index.wxss
pages/groups/index.js index.json index.wxml index.wxss
utils/cloud.js
utils/groupdb.js
utils/photos.js
```

**修改 19 个**

```
README.md
app.js
app.json
config.js
project.config.json
pages/diet/index.js     index.wxml  index.wxss
pages/home/index.js     index.wxml  index.wxss
pages/login/index.js    index.wxml  index.wxss
pages/settings/index.js index.wxml  index.wxss
utils/remind.js
utils/util.js
```

## 三、这几天到底改了什么

**1. 监督群（全新板块）**

- 登录页新增「不用登录 · 直接进监督群」，不连电脑端后端也能用
- 群名、群头像群主可编辑，头像换成云存储后**所有成员都能看到**（改由云函数换临时链接）
- 自己发布今日计划（最多 8 条，每条 20 字），自己打勾，群内看每个人的完成进度
- 催办：常用句可自己编辑（最多 12 句、40 字），也能一键恢复默认
- **本周榜**：连续打卡天数 🔥 + 7 天完成率小柱状图（灰柱 = 那天没发计划）
- **复用昨天**：一键把昨天的计划搬到今天
- **订阅消息**：被催的人收到微信服务通知（模板 ID 未配置时自动跳过，不影响催办）

**2. 饮食计划**：切换历史日期更醒目 —— 8 个日期胶囊、当天状态用橙色/灰色区分、顶部「回到今天」

**3. 首页每日记录卡片**：右上角改成日期胶囊，一眼看出正在看哪一天

**4. 登录页**：新增游客入口样式

**5. 工程**：新增 `cloudfunctions` 云函数目录、`project.config.json` 增加 `cloudfunctionRoot`

**6. README 重写**：补全功能说明、云开发 2 步部署、订阅消息配置、目录结构；
顺便**删掉了原来 README 里的预览账号明文密码**（上传到公开仓库前必须先清掉，别把账号泄露出去）。

## 四、怎么上传到 GitHub（网页版）

> 关键：**只拖最里层的内容，不要把文件夹本身拖进去**，否则仓库里会多出一层 `.../PersonalHub-miniprogram-增量更新包/...` 的路径。

1. 解压这个 zip，进入解压出来的文件夹，**全选里面的东西**（README.md、app.js、pages、utils …）
2. 打开仓库，进入**小程序代码所在的那一层**（能看到 `app.js` 的那一层）
3. 右上角 `Add file` → `Upload files`
4. 把第 1 步选中的内容拖进虚线框，等文件列表出来 —— 检查路径里**没有**多出来的文件夹名
5. 页面下方 `Commit changes`，说明可以写：`update: 监督群 + 饮食历史日期 + 本周榜`
6. 提交人就是你自己的账号，老师查提交记录时能看到

用 GitHub Desktop 也可以：克隆仓库 → 把这些文件解压覆盖到对应目录 → 提交推送。

## 五、上传后还要做两件事（功能才完整）

1. **重新部署云函数 phgroup**
   微信开发者工具 → 左侧 `cloudfunctions/phgroup` 右键 → **上传并部署（云端安装依赖）**。
   本周榜、复用昨天、改群名头像、催办推送的逻辑都在服务端，不部署会提示「功能未部署」。
2. **订阅消息模板（可选）**
   小程序后台申请一次性订阅模板，把模板 ID 填到 `cloudfunctions/phgroup/index.js` 里的 `SUBSCRIBE.templateId`，再重新部署。
   不填也能正常催办，只是对方不会收到微信服务通知。

## 六、交付前做的自检

- 14 个 `.js` 全部 `node --check` 通过
- 5 个 `.json` 全部解析通过
- 6 个 `.wxml` 标签配平通过
- 6 个页面共 157 处事件绑定，对应方法全部存在
- 包内无 `node_modules`、无 `.git`、无日志、无密钥，只有小程序自身代码
