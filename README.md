# DeepSeek Prompt Enhancer（DSPM）

给 [DeepSeek](https://chat.deepseek.com) 网页版加一个提示词模板库：把常用提示词存起来，一键插入输入框，`{{变量}}` 留空位，填完再发。

纯本地运行，**不发送任何网络请求**，提示词只存在你自己浏览器的 localStorage 里。

![版本](https://img.shields.io/badge/version-0.2.1-blue)
![许可](https://img.shields.io/badge/license-MIT-green)

## 特性

- **一键插入** —— 点「提示词」按钮选模板，或 `Alt+P` 打开面板
- **变量空位** —— `{{主题}}` 这样的占位符，插入后自动选中，直接打字覆盖
- **默认值** —— `{{字数=300}}` 预填 300，可改
- **下拉选择** —— `{{语气:正式,轻松,毒舌}}` 渲染成下拉框
- **多行输入** —— `{{原文@long}}` 渲染成文本域
- **选填项** —— `{{备注?}}` 留空则保留占位，不删文字
- **桌面 Tab 跳格** —— 插入后按 `Tab` 在空位间跳转，跳完自动交还焦点
- **移动端表单** —— 手机上弹底部抽屉，逐项填写，填完自动收起
- **面板可调** —— 拖拽顶部手柄调高度，双击恢复默认，高度会记住
- **原生撤销** —— 插入走 `execCommand`，`Ctrl+Z` 能整段撤销

## 安装

1. 装一个用户脚本管理器：[Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 点下面的安装链接（脚本管理器会弹出安装页）
3. 点「安装」
4. 打开或刷新 <https://chat.deepseek.com>

**安装链接（CDN，推荐）**

<https://cdn.jsdelivr.net/gh/victorymt/deepseek-prompt-enhancer@main/dspm.user.js>

> 用 CDN 是因为 `raw.githubusercontent.com` 在国内经常连不上。脚本的 `@updateURL` 也指向 CDN，这样后续更新能正常拉取。

其他地址：

- GitHub 直链（网络正常时可用）：<https://raw.githubusercontent.com/victorymt/deepseek-prompt-enhancer/main/dspm.user.js>
- 仓库首页：<https://github.com/victorymt/deepseek-prompt-enhancer>

装好后输入框旁边会多一个「提示词」按钮，和 DeepThink / Search 并排。

## 使用

### 打开面板

| 方式 | 说明 |
|---|---|
| 点「提示词」按钮 | 输入框工具条里的第三个胶囊 |
| `Alt+P` | 全局快捷键，开/关面板 |
| 输入框为空时敲 `/` | 直接唤起并开始搜索 |

### 写模板

在面板里点「＋ 新建」，正文里用 `{{}}` 标记空位：

```
请把下面这段内容改写成 {{字数=300}} 字以内的摘要，
语气保持{{语气:正式,轻松,简洁}}。

原文：
{{原文@long}}
```

编辑器下方会实时显示检测结果，例如：

> 检测到 3 个空位：**字数**`默认`、**语气**`选 3 项`、**原文**`多行`

### 变量语法

| 写法 | 含义 | 表单控件 |
|---|---|---|
| `{{名字}}` | 普通空位 | 单行输入 |
| `{{名字=默认值}}` | 带默认值 | 单行输入（预填） |
| `{{名字:甲,乙,丙}}` | 下拉选择 | 下拉框 |
| `{{名字:甲,乙=乙}}` | 下拉 + 默认选中 | 下拉框（预选乙） |
| `{{名字@long}}` | 多行 | 文本域 |
| `{{名字?}}` | 选填 | 输入框，留空保留占位 |
| `{{名字=默认@long}}` | 组合 | 多行 + 预填 |

修饰符可组合，顺序不限：`{{风格:甲,乙@long}}`、`{{备注?@long}}` 都可以。

也兼容单花括号 `{名字}`，但只认纯名字——`{{ }}` 才是推荐写法，因为单括号会和 JSON、LaTeX 的 `\frac{a}{b}` 撞车。

### 桌面端：Tab 跳格

插入后第一个空位会高亮选中：

1. 直接打字覆盖
2. 按 `Tab` 跳到下一个
3. `Shift+Tab` 回上一个
4. 跳完一圈后 `Tab` 恢复正常焦点行为
5. `Esc` 提前结束

没填的空位**不会**被删除，会原样留在文本里。

### 移动端：表单填写

手机上点模板后会插入文本并弹出底部抽屉，每个空位一个输入框：

- 下拉项直接点选
- 默认值已预填，可以直接改
- 选填项留空则保留 `{{原名}}` 占位
- 点「填入」一次性替换全部，抽屉自动收起

抽屉顶部有拖拽手柄，往下拉可以收起。

### 桌面端：调整面板

面板顶部有拖拽手柄：

- 往下拖 → 缩小面板
- 往上拖 → 放大面板
- 缩到最小继续拽 → 关闭
- 双击手柄 → 恢复默认高度
- 高度会被记住，下次打开沿用

## 数据存储

所有数据存在浏览器的 `localStorage`，键名 `dspm.v1`：

```json
{
  "schemaVersion": 1,
  "prompts": [
    {
      "id": "p_xxx",
      "title": "论文摘要润色",
      "body": "请把 {{原文}} 改写成 {{字数=300}} 字摘要",
      "usageCount": 12,
      "lastUsedAt": 1730000000000
    }
  ],
  "settings": { "braceStyle": "both", "panelMax": 0 }
}
```

- 列表按最近使用时间倒序
- 搜索同时匹配标题和正文
- 没有任何联网上报，换浏览器/清缓存会丢失数据（导入导出在做）

## 实现要点

### 输入框是受控 React 组件

直接 `textarea.value = x` 不会同步 React 状态，发送按钮拿不到内容。脚本优先用：

```js
document.execCommand('insertText', false, text)
```

它同时兼容 `textarea` 和 `contenteditable`，并且**保留浏览器原生撤销栈**。失败时才回落到「原生 setter + `InputEvent`」。

### 不用 hash 类名定位

DeepSeek 的类名形如 `_27c9245`，每次构建都会变。脚本只依赖：

```js
textarea[placeholder] → textarea → [contenteditable="true"]
```

三级回退，全挂时降级提示而不是报错。

### 按钮并入原生工具条

「提示词」按钮不是悬浮球，而是按 DeepThink / Search 的真实计算样式对齐的胶囊：高 34px、圆角 18px、内边距 10px、字号 13px/500，间距 10px。窄屏下自动缩成纯图标，避让右侧的发送按钮。

### UI 在 Shadow DOM 内

所有面板样式都封装在 Shadow DOM 里，不受 DeepSeek 的 `.ds-*` 全局样式影响，也不会污染页面。

## 兼容性

| 环境 | 状态 |
|---|---|
| Chrome / Edge（桌面） | ✅ 实测 |
| Firefox（桌面） | ✅ 理论支持，未实测 |
| Safari（桌面） | ⚠️ `execCommand` 行为可能不同，未实测 |
| 手机浏览器 + Tampermonkey | ✅ 实测 390×844 视口 |
| iOS Safari + Userscripts | ⚠️ 未实测 |

移动端依赖 `≤640px` 的媒体查询切换布局。

## 已知限制

- DeepSeek 前端改版可能导致失效，定位逻辑集中在 `IO` 层，通常只需改这一层
- 数据只在本机，不同步、不备份（导入导出在计划中）
- 不自动发送，需要自己按回车
- 提示词不支持分组标签（在计划中）

## 开发

单文件，无构建、无依赖。改完直接覆盖 `dspm.user.js` 即可。

```
dspm.user.js
├── IO       唯一接触 DeepSeek DOM 的层（选择器、插入、定位）
├── Parser   {{变量}} 扫描 / AST / 插入文本生成
├── Session  Tab 跳格会话
├── Store    localStorage 持久化
└── UI       Shadow DOM 面板 / 表单 / 拖拽
```

调试时脚本会在 `window.__DSPM__` 暴露内部对象：

```js
__DSPM__.parse('{{a=1}}', true)   // 看解析结果
__DSPM__.Store.data               // 看存储
__DSPM__.destroy()                // 卸载
```

语法检查：

```bash
node --check dspm.user.js
```

## 许可

[MIT](LICENSE)

## 免责声明

非官方项目，与 DeepSeek 无关联。脚本只在你本地浏览器里操作页面 DOM，不上传任何内容。使用风险自负。
