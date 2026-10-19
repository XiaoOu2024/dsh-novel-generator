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
