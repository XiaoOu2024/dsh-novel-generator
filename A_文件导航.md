文件名称	|	更新时间	|	文件描述
#最新文件说明
package.json	|	2026-10-20 03:54	|	插件包清单（bundle patch + dsh.client 双半声明）
cordis.patch.yml	|	2026-10-20 03:54	|	loader 插入行 dsh-novel-studio
index.js	|	2026-10-20 03:57	|	Host 半：作品存储、HTTP API、Agent 生成与快照
client.js	|	2026-10-20 03:56	|	Client 半：侧栏按钮 + 全窗工作室（项目/时间线/故事/大纲）
locale/en.json	|	2026-10-20 03:54	|	英文标题与描述
locale/zh.json	|	2026-10-20 03:54	|	中文标题与描述
icon.svg	|	2026-10-20 03:54	|	插件图标（书页+时间线，原创）
README.md	|	2026-10-20 03:59	|	使用说明、数据布局、接口与自检脚本
selfcheck.mjs	|	2026-10-20 03:55	|	接口自检：作品/时间线/章节/大纲/保存/删除
selfcheck-generate.mjs	|	2026-10-20 03:56	|	真实调用模型生成一章的自检
selfcheck-snapshot.mjs	|	2026-10-20 03:58	|	真实调用模型产出世界快照的自检

#目录文件变化
package.json	|	2026-10-20 03:54	|	新增插件清单
cordis.patch.yml	|	2026-10-20 03:54	|	新增 loader 插入行
index.js	|	2026-10-20 03:54	|	新增 Host 半初版
index.js	|	2026-10-20 03:57	|	修复 prompt 缺 AbortSignal、补充禁工具指令
client.js	|	2026-10-20 03:54	|	新增 Client 半初版
client.js	|	2026-10-20 03:56	|	侧栏按钮支持折叠栏（宽/窄态）
locale/en.json	|	2026-10-20 03:54	|	新增英文元数据
locale/zh.json	|	2026-10-20 03:54	|	新增中文元数据
icon.svg	|	2026-10-20 03:54	|	新增图标
README.md	|	2026-10-20 03:59	|	新增使用说明
selfcheck.mjs	|	2026-10-20 03:55	|	新增接口自检脚本
selfcheck-generate.mjs	|	2026-10-20 03:56	|	新增生成自检脚本
selfcheck-snapshot.mjs	|	2026-10-20 03:58	|	新增快照自检脚本
client.js	|	2026-10-20 04:02	|	故事页同步生成后的正文；切换作品重置工作区状态
client.js	|	2026-10-20 04:08	|	侧栏小说工坊按钮底色改为淡蓝（state-business-tertiary，明暗主题自适应）
client.js	|	2026-10-20 04:12	|	主按钮/单位切换改用 label-primary+bg-layer 反色配对，去掉写死白字；toast 改主题色；补 color-scheme
index.js	|	2026-10-20 05:05	|	快照阈值改为天0起算、按章节梗概结算、新增 /compose 一键出章、cursor 迁移为天
client.js	|	2026-10-20 05:05	|	时间线0..最新快照、去掉章节列表与新建按钮、故事页左右翻章+新建弹窗、大纲去掉自动推演
README.md	|	2026-10-20 05:05	|	同步新流程说明
selfcheck.mjs	|	2026-10-20 05:05	|	改用 /outline/save 建章
selfcheck-compose.mjs	|	2026-10-20 05:05	|	新增自动推演整章与快照阈值自检
client.js	|	2026-10-20 05:00	|	故事页保存改为弹出提示；未保存离开（回时间线/翻章/大纲/新建/作品列表/关闭）弹确认，可选保存并离开
README.md	|	2026-10-20 05:00	|	补充保存提示与未保存确认说明
client.js	|	2026-10-20 05:10	|	章节大纲：保存改弹出提示，未保存离开弹确认（可保存并离开），提示条提到弹窗之上
README.md	|	2026-10-20 05:10	|	补充大纲页保存提示与未保存确认
index.js	|	2026-10-20 05:20	|	/compose 支持带 chapterId 原地重生成（覆盖大纲+正文），返回梗概
client.js	|	2026-10-20 05:20	|	大纲页加自动推演（确认后覆盖并保存）、生成前确认、通用 ConfirmDialog
selfcheck-rededuce.mjs	|	2026-10-20 05:20	|	新增原地重生成自检
README.md	|	2026-10-20 05:20	|	补充大纲页自动推演与生成确认说明
