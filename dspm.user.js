// ==UserScript==
// @name         DeepSeek 提示词增强（DSPM）
// @name:en      DeepSeek Prompt Enhancer
// @namespace    https://github.com/victorymt/deepseek-prompt-enhancer
// @version      0.3.0
// @description  提示词模板管理（{{变量}} 插入输入框）+ 任务面板：翻译、提示词增强、润色一键跑完并取回结果。
// @description:en  Prompt templates ({{variables}}) plus a task panel: run translation / prompt-enhance / polish in one click and collect the answer.
// @author       victorymt
// @license      MIT
// @match        https://chat.deepseek.com/*
// @run-at       document-idle
// @grant        none
// @homepageURL  https://github.com/victorymt/deepseek-prompt-enhancer
// @supportURL   https://github.com/victorymt/deepseek-prompt-enhancer/issues
// @downloadURL  https://victorymt.github.io/deepseek-prompt-enhancer/dspm.user.js
// @updateURL    https://victorymt.github.io/deepseek-prompt-enhancer/dspm.user.js
// ==/UserScript==

/**
 * 分层：
 *   IO       —— 唯一接触 DeepSeek DOM 的层（改版只需改这里）
 *   Parser   —— {{变量}} 扫描 / AST
 *   Session  —— 插入后的 Tab 跳格
 *   Store    —— localStorage 持久化
 *   Runner   —— 任务执行：新建对话 → 组信封 → 发送 → 等完成 → 取回结果
 *   UI       —— Shadow DOM 面板
 */

(function () {
  'use strict';

  if (window.__DSPM__ && window.__DSPM__.alive) return;

  /* ============================ 常量 / 工具 ============================ */

  const ZWSP = '\u200B';            // 用来"保护"用户原义花括号，避免被当成空位
  const KEY = 'dspm.v1';
  const SCHEMA = 1;
  const TASK_KEY = 'dspm.tasks.v1';  // 任务结果单独存，避免把 prompts 撑爆
  const TASK_SCHEMA = 1;
  const RUN_KEY = 'dspm.run.v1';     // 运行中任务的现场（sessionStorage，刷新可续）
  const RESULT_KEEP = 20;            // 每个用途最多留 20 条
  const RESULT_MAX = 20000;          // 单条结果最多 20k 字符

  const uid = () => 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = () => Date.now();
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  /* ============================== IO 层 ============================== */

  const IO = {
    _cached: null,

    /** 三级回退定位输入框；不依赖任何 hash 类名 */
    composer() {
      const c = this._cached;
      if (c && c.isConnected && this.visible(c)) return c;
      const selectors = ['textarea[placeholder]', 'textarea', '[contenteditable="true"]'];
      for (const sel of selectors) {
        const el = [...document.querySelectorAll(sel)].find((e) => this.visible(e));
        if (el) return (this._cached = el);
      }
      return null;
    },

    visible(el) {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) return false;
      const st = getComputedStyle(el);
      return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
    },

    isTextarea(el) {
      return !!el && el.tagName === 'TEXTAREA';
    },

    /** 是否支持定位/选中（跳格只在 textarea 上启用） */
    supportsRange(el) {
      return this.isTextarea(el);
    },

    value(el) {
      if (!el) return '';
      return this.isTextarea(el) ? el.value : el.textContent || '';
    },

    /**
     * 插入文本。优先 execCommand：能保留浏览器原生撤销栈，
     * 且同时适用于 textarea 与 contenteditable。
     */
    insertText(el, text) {
      if (!el) return false;
      el.focus();
      const before = this.value(el);
      try {
        document.execCommand('insertText', false, text);
      } catch (e) {
        /* ignore */
      }
      if (this.value(el) !== before) return true;
      return this._fallbackInsert(el, text, before);
    },

    /** 兜底：原生 setter + InputEvent，让 React 受控组件同步 */
    _fallbackInsert(el, text, before) {
      if (!this.isTextarea(el)) {
        // contenteditable 兜底：直接改 DOM 再派发 input
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return false;
        sel.deleteFromDocument();
        sel.getRangeAt(0).insertNode(document.createTextNode(text));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        return true;
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      const v = before ?? el.value;
      const s = el.selectionStart ?? v.length;
      const e = el.selectionEnd ?? s;
      const next = v.slice(0, s) + text + v.slice(e);
      setter.call(el, next);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      try { el.setSelectionRange(s + text.length, s + text.length); } catch (_) {}
      return true;
    },

    /** 整体覆写（用于清理残留标记），同样走 React 友好路径 */
    setValue(el, text) {
      if (!el) return;
      if (this.isTextarea(el)) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(el, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      } else {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    },

    setRange(el, start, end) {
      if (!this.isTextarea(el)) return false;
      try {
        el.focus();
        el.setSelectionRange(start, end);
        // 让滚动跟随选中位置
        const approxLine = el.value.slice(0, start).split('\n').length;
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
        el.scrollTop = clamp((approxLine - 2) * lh, 0, el.scrollHeight);
        return true;
      } catch (_) {
        return false;
      }
    },

    caret(el) {
      if (this.isTextarea(el)) return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
      return { start: this.value(el).length, end: this.value(el).length };
    },

    rect(el) {
      return el ? el.getBoundingClientRect() : null;
    },

    /* ---------------- 任务执行相关（全部是启发式，失败要能降级） ---------------- */

    /**
     * 找「开启新对话」入口。
     * 实测：DeepSeek 把它做成一个 tabindex="0" 的 DIV（无 role、类名哈希化），
     * 文本是 "New chat" / "开启新对话"。所以不能只认 a/button/[role=button]。
     * 返回可点击的元素；找不到返回 null。
     */
    newChatButton() {
      const kw = /^(开启新对话|新对话|新建对话|new chat|start a new chat)$/i;
      const cands = document.querySelectorAll('a, button, [role="button"], [tabindex="0"]');
      for (const el of cands) {
        const text = (el.textContent || '').trim();
        if (!text || text.length > 24) continue;
        const label = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '').trim();
        if (!kw.test(text) && !kw.test(label)) continue;
        if (!this.visible(el)) continue;
        // 优先返回自身可点（有 tabindex/role/button 语义）的那个
        return el;
      }
      return null;
    },

    /** 当前对话地址，作为任务记录的「会话地址」；不解析、不硬编码路由 */
    href() {
      try { return location.href; } catch (_) { return ''; }
    },

    /**
     * 是否正在生成。
     * 实测：没有稳定的 aria 文案（英文界面下也没有 "Stop generating"），
     * 所以分层判断，最后都归到「文字是否还在增长」这个主信号上。
     */
    generating() {
      // 1) 显式停止文案（中英文都试）
      const kw = /^(停止生成|停止回答|停止|stop generating|stop|stop responding)$/i;
      for (const el of document.querySelectorAll('button, [role="button"], [tabindex="0"]')) {
        const text = (el.textContent || '').trim();
        if (!text || text.length > 20) continue;
        const label = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '').trim();
        if ((kw.test(text) || kw.test(label)) && this.visible(el)) return true;
      }
      // 2) 主按钮从「上箭头」换成「方块」= 停止键
      const btn = this.primaryButton();
      const svg = btn && btn.querySelector('svg');
      if (svg) {
        if (svg.querySelector('rect')) return true;                 // 方块 = 停止
        const path = svg.querySelector('path');
        const d = path ? (path.getAttribute('d') || '') : '';
        // 空闲态是上箭头（实测以 M8.3125 开头）；不是箭头就当在生成
        if (d && !/^M8\.3125/.test(d) && !/8\.3125/.test(d) && d.length > 20) return false;
      }
      return false;
    },

    /** 输入框那个主圆形按钮（空闲时是发送上箭头，生成时是停止） */
    primaryButton() {
      return document.querySelector('.ds-button--primary.ds-button--circle')
        || document.querySelector('[class*="ds-button--primary"][class*="circle"]');
    },

    /**
     * 助手答复容器。
     * 实测：纯 .ds-markdown 是「思考过程」(ds-think-content)，
     * 真正的回答带 ds-assistant-message-main-content。
     * 但 DeepThink 刚启动时只有思考区、还没有 main-content，
     * 这时返回空是正常的，调用方要据此继续等，而不是判失败。
     */
    answers() {
      return [...document.querySelectorAll('[class*="ds-assistant-message-main-content"]')]
        .filter((el) => this.visible(el) && (el.innerText || el.textContent || '').trim().length > 0);
    },

    /**
     * 把答复容器转成接近 Markdown 的纯文本。
     *
     * 为什么不能直接 innerText：DeepSeek 用 KaTeX 渲染公式，innerText 会把
     * 每个字符、每个上下标都拆成独立行（实测「N(t)」变成 𝐍\n(\n𝑡\n)），
     * 一条带公式的回答能膨胀出几百行空白。
     *
     * 正确做法是按块递归遍历，遇到 .katex 就取出它自带的
     * <annotation encoding="application/x-tex"> 里的原始 LaTeX，
     * 还原成 $...$（行内）或 $$...$$（独立公式）。
     */
    toMarkdown(root) {
      if (!root) return '';

      const texOf = (k) => {
        const ann = k.querySelector('annotation[encoding="application/x-tex"]');
        return ann ? ann.textContent : '';
      };
      const isDisplay = (n) =>
        !!(n.classList && (n.classList.contains('katex-display')
          || n.classList.contains('ds-markdown-math')))
        || !!(n.closest && n.closest('.katex-display'));

      const walk = (node) => {
        let out = '';
        for (let i = 0; i < node.childNodes.length; i++) {
          const n = node.childNodes[i];

          if (n.nodeType === 3) {                       // 文本节点
            out += n.nodeValue.replace(/[ \t]+/g, ' ');
            continue;
          }
          if (n.nodeType !== 1) continue;               // 跳过注释等

          const tag = n.tagName;

          // 公式：优先用 KaTeX 保留的 LaTeX 源码
          if (n.classList && n.classList.contains('katex')) {
            const tex = texOf(n);
            if (tex) {
              out += isDisplay(n) ? '\n\n$$' + tex + '$$\n\n' : '$' + tex + '$';
              continue;
            }
            out += (n.textContent || '');   // 没有 annotation 就退回可见文本，别丢公式
            continue;
          }

          if (tag === 'PRE') {
            out += '\n\n```\n' + (n.textContent || '').replace(/\n+$/, '') + '\n```\n\n';
            continue;
          }
          if (tag === 'CODE' && !(n.closest && n.closest('pre'))) {
            out += '`' + (n.textContent || '') + '`';
            continue;
          }
          if (/^H[1-6]$/.test(tag)) {
            out += '\n\n' + '#'.repeat(+tag[1]) + ' ' + walk(n).trim() + '\n\n';
            continue;
          }
          if (tag === 'LI') { out += '\n- ' + walk(n).trim(); continue; }
          if (tag === 'UL' || tag === 'OL') { out += '\n' + walk(n) + '\n'; continue; }
          if (tag === 'BLOCKQUOTE') {
            out += '\n\n> ' + walk(n).trim().replace(/\n/g, '\n> ') + '\n\n';
            continue;
          }
          if (tag === 'TABLE') {
            // 逐行逐格走 walk()，这样表格里的公式也能还原成 LaTeX
            const rows = [...n.querySelectorAll('tr')].map((tr) =>
              [...tr.children].map((cell) => walk(cell).trim().replace(/\n+/g, ' ')));
            if (rows.length) {
              const cols = Math.max(...rows.map((r) => r.length));
              const pad = (r) => { while (r.length < cols) r.push(''); return r; };
              out += '\n\n| ' + pad(rows[0]).join(' | ') + ' |\n';
              out += '| ' + new Array(cols).fill('---').join(' | ') + ' |\n';
              rows.slice(1).forEach((r) => { out += '| ' + pad(r).join(' | ') + ' |\n'; });
              out += '\n';
            }
            continue;
          }
          if (tag === 'P' || tag === 'DIV' || tag === 'SECTION') {
            out += '\n\n' + walk(n).trim() + '\n\n';
            continue;
          }
          if (tag === 'BR') { out += '\n'; continue; }
          if (tag === 'STRONG' || tag === 'B') { out += '**' + walk(n).trim() + '**'; continue; }
          if (tag === 'EM' || tag === 'I') { out += '*' + walk(n).trim() + '*'; continue; }
          if (tag === 'DEL' || tag === 'S') { out += '~~' + walk(n).trim() + '~~'; continue; }
          if (tag === 'HR') { out += '\n\n---\n\n'; continue; }
          if (tag === 'A') {
            const href = n.getAttribute('href') || '';
            const label = walk(n).trim();
            out += href && href !== label ? `[${label}](${href})` : label;
            continue;
          }

          out += walk(n);
        }
        return out;
      };

      return walk(root)
        .replace(/[ \t]+\n/g, '\n')      // 行尾空格
        .replace(/\n{3,}/g, '\n\n')      // 压掉连续空行
        .trim();
    },

    /** 最后一条答复的纯文本（Markdown 化，公式保留为 LaTeX） */
    lastAnswer() {
      const list = this.answers();
      const el = list[list.length - 1];
      return el ? this.toMarkdown(el) : '';
    },

    /**
     * 发送：走原生 Enter 键，路径与人类一致，
     * 绕开「按钮 disabled 与 React 状态不同步」的坑。
     * 这里只按一次，不发兜底——是否成功由调用方按「输入框是否清空」判定，
     * 避免 Enter 与点击双份发送。
     */
    send() {
      const el = this.composer();
      if (!el) return false;
      const before = this.value(el);
      if (!before.trim()) return false;
      el.focus();
      const ev = {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true, composed: true,
      };
      try {
        el.dispatchEvent(new KeyboardEvent('keydown', ev));
        el.dispatchEvent(new KeyboardEvent('keypress', ev));
        el.dispatchEvent(new KeyboardEvent('keyup', ev));
      } catch (_) { /* ignore */ }
      return true;
    },

    /**
     * 点发送键。
     * 实测：发送键是 .ds-button--primary.ds-button--circle（圆形主按钮），
     * 同位置还有 .ds-button__background 装饰层，必须排除。
     * 更要紧的是：生成期间这个按钮会变成「停止」键，此时绝不能点 ——
     * 实测踩过，点了等于自己把任务掐死（页面显示 Stopped）。
     */
    clickSend() {
      if (this.generating()) return false;
      const el = this.primaryButton();
      if (!el) return false;
      if (/disabled/i.test((el.className || '').toString())) return false;
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })); } catch (_) {}
      }
      return true;
    },
  };

  /* ============================ 模板解析 ============================ */

  /**
   * 语法：
   *   {{名字}}            空位
   *   {名字}              兼容简写（可由设置关闭）
   *   {{名字=默认值}}      带默认值（直接落到文本里，不再占位）
   *   {{名字?}}           选填（P1 用）
   *   {{名字:a,b,c}}      下拉（P1 用）
   *   {{名字@long}}       多行（P1 用）
   * 跳过：``` 围栏块、行内 `code`、$$公式$$，以及 LaTeX 命令后的参数 {a}
   */
  const VAR_NAME_RE = /^[\p{L}_][\p{L}\p{N}_]{0,39}$/u;

  function latexCtx(str, i) {
    const pre = str.slice(Math.max(0, i - 24), i);
    return /(?:\\[a-zA-Z]+|[\\^_])$/.test(pre);
  }

  /**
   * 单花括号简写非常容易撞车（JSON、LaTeX 的 \frac{a}{b}、对象字面量），
   * 所以收紧：只认"纯名字"，且不能紧跟另一个分组的收尾符。
   * 带 = : ? @long 修饰符的一律要求用 {{双括号}}。
   */
  function singleBraceOk(str, i, mid) {
    const prev = i > 0 ? str[i - 1] : '';
    if (/[{}[\]^_()\\]/.test(prev)) return false;   // \frac{a}{b} 的第二个参数、数组下标等
    if (mid.indexOf('\n') !== -1) return false;
    return VAR_NAME_RE.test(mid.trim());
  }

  /**
   * 变量语法（可组合，修饰符顺序不限）：
   *   {{名字}}              空位
   *   {{名字?}}             选填（表单里可以不填，保留占位）
   *   {{名字@long}}         多行文本域
   *   {{名字=默认值}}        预填默认值（表单里预先填好，可改）
   *   {{名字:甲,乙,丙}}      下拉选择
   *   {{名字:甲,乙=甲}}      下拉 + 默认选中甲
   *   {{名字=默认值@long}}   默认值 + 多行
   */
  function mkVar(raw) {
    let s = String(raw).trim();
    if (!s) return null;

    let multiline = false;
    let optional = false;
    let defVal = null;
    let options = null;

    // 修饰符可以出现在任意位置，先摘出来
    if (/@long\b/i.test(s)) {
      multiline = true;
      s = s.replace(/@long\b/i, '').trim();
    }
    if (s.endsWith('?')) {
      optional = true;
      s = s.replace(/\?+$/, '').trim();
    }

    // 冒号在前 → 下拉；等号在前 → 默认值
    const eq = s.indexOf('=');
    const co = s.indexOf(':');

    if (co !== -1 && (eq === -1 || co < eq)) {
      const head = s.slice(0, co).trim();
      let tail = s.slice(co + 1);
      // 选项里允许出现结尾的 =默认 写法：{{语气:甲,乙=乙}}
      options = tail.split(',').map((x) => x.trim()).filter(Boolean);
      s = head;
      if (options.length === 0) return null;
      // 若最后一个选项带 "=x"，视作默认值标记
      const lastEq = options[options.length - 1].indexOf('=');
      if (lastEq !== -1) {
        const opt = options[options.length - 1];
        options[options.length - 1] = opt.slice(0, lastEq).trim();
        defVal = opt.slice(lastEq + 1).trim();
        if (!options[options.length - 1]) options.pop();
      }
    } else if (eq !== -1) {
      defVal = s.slice(eq + 1).trim();
      s = s.slice(0, eq).trim();
    }

    if (!VAR_NAME_RE.test(s)) return null;
    if (defVal != null && defVal.length > 300) return null;
    if (options && options.length > 60) return null;

    // 默认值必须落在选项里，否则忽略
    if (defVal != null && options && options.length && options.indexOf(defVal) === -1) {
      defVal = options[0];
    }
    return { name: s, optional, defVal, options, multiline };
  }

  /** 扫描出所有空位（同一套规则，插入前和跳格中都复用） */
  function scan(str, allowSingle) {
    const res = [];
    const n = str.length;
    let i = 0;
    while (i < n) {
      const c = str[i];

      if (str.startsWith('```', i) || str.startsWith('~~~', i)) {
        const fence = str.substr(i, 3);
        const j = str.indexOf(fence, i + 3);
        i = j === -1 ? n : j + 3;
        continue;
      }
      if (c === '`') {
        const j = str.indexOf('`', i + 1);
        if (j !== -1) { i = j + 1; continue; }
      }
      if (c === '$' && str.startsWith('$$', i)) {
        const j = str.indexOf('$$', i + 2);
        if (j !== -1) { i = j + 2; continue; }
      }
      if (c === '\\' && str[i + 1] === '{') { i += 2; continue; }

      if (c === '{' && !latexCtx(str, i)) {
        if (str[i + 1] === '{') {
          const j = str.indexOf('}}', i + 2);
          if (j !== -1) {
            const v = mkVar(str.slice(i + 2, j));
            if (v) {
              res.push(Object.assign(v, { start: i, end: j + 2, raw: str.slice(i, j + 2), delim: '{{' }));
              i = j + 2;
              continue;
            }
          }
        } else if (allowSingle) {
          const j = str.indexOf('}', i + 1);
          if (j !== -1) {
            const mid = str.slice(i + 1, j);
            if (singleBraceOk(str, i, mid)) {
              const v = mkVar(mid);
              if (v) {
                res.push(Object.assign(v, { start: i, end: j + 1, raw: str.slice(i, j + 1), delim: '{' }));
                i = j + 1;
                continue;
              }
            }
          }
        }
      }
      i++;
    }
    return res;
  }

  /** 正文 → AST（text / var 交错） */
  function parse(body, allowSingle) {
    const marks = scan(body, allowSingle);
    const segments = [];
    const vars = [];
    let last = 0;
    for (const m of marks) {
      if (m.start > last) segments.push({ type: 'text', value: body.slice(last, m.start) });
      vars.push(m);
      segments.push({ type: 'var', index: vars.length - 1 });
      last = m.end;
    }
    if (last < body.length) segments.push({ type: 'text', value: body.slice(last) });
    return { segments, vars };
  }

  /** 用户写的 \{ \{ 属于字面量：去掉反斜杠并加 ZWSP 保护 */
  function protectEscapes(s) {
    return s.replace(/\\\{/g, '{' + ZWSP).replace(/\\\}/g, '}' + ZWSP);
  }

  /**
   * 生成真正要写进输入框的文本。
   * 默认值 / 下拉都保留 {{原样}} 占位（跳格与表单都需要它作为锚点），
   * 具体取值由 buildInsert 的 slots 元数据携带，等用户确认后一次性替换。
   */
  function buildInsert(body, allowSingle) {
    const ast = parse(body, allowSingle);
    let out = '';
    const slots = [];
    for (const seg of ast.segments) {
      if (seg.type === 'text') { out += protectEscapes(seg.value); continue; }
      const v = ast.vars[seg.index];
      const start = out.length;
      out += v.raw;
      slots.push({
        name: v.name,
        start,
        end: out.length,
        multiline: !!v.multiline,
        optional: !!v.optional,
        options: v.options || null,
        defVal: v.defVal != null ? v.defVal : null,
        raw: v.raw,
      });
    }
    return { text: out, slots, vars: ast.vars };
  }

  /** 某个空位应当预填的值（无默认值则为空串） */
  function presetOf(slot) {
    if (!slot) return '';
    if (slot.defVal != null && slot.defVal !== '') return slot.defVal;
    if (slot.options && slot.options.length) return slot.options[0];
    return '';
  }

  /* ============================== 会话 ============================== */

  const Session = {
    active: false,
    el: null,
    _key: null,
    _blur: null,

    allowSingle() {
      return Store.data.settings.braceStyle !== 'double';
    },

    begin(el) {
      if (!IO.supportsRange(el)) return;
      this.el = el;
      if (this.active) return;
      this.active = true;
      this._key = (e) => this.onKeyDown(e);
      this._blur = (e) => {
        if (e.target === this.el) this.end();
      };
      document.addEventListener('keydown', this._key, true);
      document.addEventListener('focusout', this._blur, true);
    },

    onKeyDown(e) {
      if (!this.active || e.target !== this.el) return;
      if (e.isComposing || e.keyCode === 229) return; // 中文输入法安全

      if (e.key === 'Tab') {
        const handled = this.step(e.shiftKey ? -1 : 1);
        if (handled) {
          e.preventDefault();
          e.stopPropagation();
        } else {
          this.end(); // 没有下一个空位：交还浏览器默认焦点行为
        }
      } else if (e.key === 'Escape') {
        this.end();
      }
    },

    markers() {
      if (!this.el) return [];
      return scan(IO.value(this.el), this.allowSingle());
    },

    step(dir) {
      const ms = this.markers();
      if (!ms.length) return false;
      const caret = IO.caret(this.el);

      let target = null;
      if (dir > 0) {
        target = ms.find((m) => m.start >= caret.end) || ms[0];
      } else {
        const prev = ms.filter((m) => m.end < caret.start);
        target = prev.length ? prev[prev.length - 1] : ms[ms.length - 1];
      }
      if (!target) return false;

      // 已经选中它了：放行，避免 Tab 被永久劫持在最后一个空位上
      if (caret.start === target.start && caret.end === target.end) return false;

      return IO.setRange(this.el, target.start, target.end);
    },

    /**
     * 会话收尾：只清理不可见的 ZWSP，绝不删除用户还没填的空位。
     * 静默删掉模板文字比留下 {{未填}} 糟糕得多。
     */
    settle(el) {
      el = el || this.el;
      if (!el) return;
      const v = IO.value(el);
      if (!v || v.indexOf(ZWSP) === -1) return;
      IO.setValue(el, v.split(ZWSP).join(''));
    },

    end() {
      if (!this.active) return;
      this.active = false;
      const el = this.el;
      document.removeEventListener('keydown', this._key, true);
      document.removeEventListener('focusout', this._blur, true);
      this._key = this._blur = null;
      this.el = null;
      this.settle(el);
    },
  };

  /* ============================== 存储 ============================== */

  const Store = {
    data: null,

    defaults() {
      return {
        schemaVersion: SCHEMA,
        prompts: [],
        settings: { braceStyle: 'both', slashShortcut: true, seed: false, panelMax: 0, panelPos: null },
      };
    },

    load() {
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { raw = null; }
      if (!raw || typeof raw !== 'object') raw = this.defaults();
      if (raw.schemaVersion !== SCHEMA) raw = this.migrate(raw);
      raw.prompts = Array.isArray(raw.prompts) ? raw.prompts : [];
      raw.settings = Object.assign(this.defaults().settings, raw.settings || {});
      this.data = raw;
      if (!raw.settings.seed) {
        raw.settings.seed = true;
        if (!raw.prompts.length) raw.prompts.push(this.sample());
        this.save();
      }
      return this.data;
    },

    migrate(old) {
      // P0 只有 v1，占位以便将来无损升级
      const next = this.defaults();
      if (old && Array.isArray(old.prompts)) next.prompts = old.prompts;
      return next;
    },

    sample() {
      return {
        id: uid(),
        title: '摘要润色（示例）',
        body: '请把下面这段内容改写成 {{字数}} 字以内的摘要，语气保持 {{语气=专业}}。\n\n原文：\n{{原文}}',
        usageCount: 0,
        lastUsedAt: 0,
        createdAt: now(),
        updatedAt: now(),
      };
    },

    save() {
      try {
        localStorage.setItem(KEY, JSON.stringify(this.data));
        return true;
      } catch (e) {
        toast('保存失败：本地存储不可用或已满');
        return false;
      }
    },

    all() {
      return this.data.prompts.slice().sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
    },

    get(id) {
      return this.data.prompts.find((p) => p.id === id) || null;
    },

    add({ title, body }) {
      const p = {
        id: uid(), title: (title || '').trim() || '未命名提示词', body,
        usageCount: 0, lastUsedAt: 0, createdAt: now(), updatedAt: now(),
      };
      this.data.prompts.push(p);
      this.save();
      return p;
    },

    update(id, patch) {
      const p = this.get(id);
      if (!p) return null;
      Object.assign(p, patch, { updatedAt: now() });
      this.save();
      return p;
    },

    remove(id) {
      const i = this.data.prompts.findIndex((p) => p.id === id);
      if (i === -1) return false;
      this.data.prompts.splice(i, 1);
      this.save();
      return true;
    },

    touch(id) {
      const p = this.get(id);
      if (!p) return;
      p.usageCount = (p.usageCount || 0) + 1;
      p.lastUsedAt = now();
      this.save();
    },

    search(q) {
      q = (q || '').trim().toLowerCase();
      const list = this.all();
      if (!q) return list;
      return list.filter((p) =>
        (p.title || '').toLowerCase().includes(q) || (p.body || '').toLowerCase().includes(q));
    },
  };

  /* ============================== 任务预设 ============================== */

  /**
   * 内置用途。instr 是「角色 + 硬约束」，必须短：
   * 长前言会挤占注意力、抬高成本，还可能被模型忽略。
   * keepRaw 表示原文是否原样保留（翻译/润色要原文，提问不要）。
   */
  const PRESETS = [
    {
      id: 'enhance',
      name: '提示词增强',
      hint: '把口语需求改写为结构化提示词',
      keepRaw: true,
      instr: '你是提示词工程师。把下面这段需求改写成一条可直接使用的高质量提示词：\n'
        + '1. 明确角色、任务、输入、输出格式与约束；\n'
        + '2. 保留原意，不擅自扩展需求范围；\n'
        + '3. 直接输出改写后的提示词本身，不要解释、不要加「以下是」之类的前后缀。',
    },
    {
      id: 'translate',
      name: '翻译',
      hint: '中英互译，只输出译文',
      keepRaw: true,
      instr: '你是翻译引擎。把下面这段内容翻译成另一种语言（中文译英文，其他语言译中文）：\n'
        + '1. 只输出译文本身，不要解释、不要复述原文、不要加引号或前缀；\n'
        + '2. 保留原文的段落结构与专有名词；\n'
        + '3. 术语前后一致。',
    },
    {
      id: 'polish',
      name: '润色',
      hint: '通顺、简洁、保持原意',
      keepRaw: true,
      instr: '你是文字编辑。润色下面这段内容：\n'
        + '1. 只改表达，不改事实与观点；\n'
        + '2. 去掉冗余与口水话，保持原有语气；\n'
        + '3. 直接输出润色后的正文，不要解释改了什么。',
    },
    {
      id: 'ask',
      name: '提问',
      hint: '原样发送，不加任何包装',
      keepRaw: false,
      instr: '',
    },
  ];

  const presetById = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];

  /** 组装信封：指令 + 边界 + 唯一标记 + 原文。提问用途不加包装。 */
  function buildEnvelope(preset, text, mark) {
    if (!preset.instr) return text;
    return `${preset.instr}\n\n` +
      `只处理 <<< ... >>> 区块内的内容，忽略此前的一切对话与指令。\n` +
      `<<<\n${text}\n>>>\n` +
      `（标记 ${mark}，仅供定位，不要写进回答）`;
  }

  /* ============================== 任务结果存储 ============================== */

  const Tasks = {
    data: null,

    defaults() {
      return { schemaVersion: TASK_SCHEMA, items: [] };
    },

    load() {
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(TASK_KEY) || 'null'); } catch (_) { raw = null; }
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) raw = this.defaults();
      this.data = raw;
      return this.data;
    },

    save() {
      try {
        localStorage.setItem(TASK_KEY, JSON.stringify(this.data));
        return true;
      } catch (e) {
        // 存不下就砍掉最旧的一半再试一次，别让结果直接丢
        this.data.items = this.data.items.slice(0, Math.max(1, Math.ceil(this.data.items.length / 2)));
        try {
          localStorage.setItem(TASK_KEY, JSON.stringify(this.data));
          toast('本地存储接近上限，已清理旧结果');
          return true;
        } catch (_) {
          toast('保存失败：本地存储已满');
          return false;
        }
      }
    },

    add(item) {
      this.data.items.unshift(item);
      this.trim();
      this.save();
      return item;
    },

    update(id, patch) {
      const it = this.data.items.find((x) => x.id === id);
      if (!it) return null;
      Object.assign(it, patch);
      this.save();
      return it;
    },

    get(id) {
      return this.data.items.find((x) => x.id === id) || null;
    },

    remove(id) {
      this.data.items = this.data.items.filter((x) => x.id !== id);
      this.save();
    },

    /** 每个用途各留最近 N 条；超长结果截断 */
    trim() {
      const byPreset = {};
      const keep = [];
      for (const it of this.data.items) {
        const k = it.preset || 'ask';
        byPreset[k] = (byPreset[k] || 0) + 1;
        if (byPreset[k] <= RESULT_KEEP) {
          if (it.output && it.output.length > RESULT_MAX) {
            it.output = it.output.slice(0, RESULT_MAX) + '\n\n…（结果过长，已截断）';
            it.truncated = true;
          }
          keep.push(it);
        }
      }
      this.data.items = keep;
    },

    byPreset(id) {
      return this.data.items.filter((x) => x.preset === id);
    },

    clear() {
      this.data.items = [];
      this.save();
    },
  };

  /* ============================== 任务执行 ============================== */

  /**
   * 严格一次一个：不做队列、不做并发、不做时间片。
   * 每次任务新开一条对话（不共用会话），跑完把结果留在面板里。
   */
  const Runner = {
    running: false,
    current: null,
    _tick: 0,
    _deadline: 0,
    _seen: '',
    _fullText: '',      // 完整原文（不落 localStorage，避免把它撑爆）
    _expectNav: false,  // 预期中的整页跳转（新建会话可能是 <a> 导航）

    /** 运行态存在 sessionStorage：刷新能接上，关标签页即失效 */
    _saveSession(stage) {
      if (!this.current) return;
      try {
        sessionStorage.setItem(RUN_KEY, JSON.stringify({
          id: this.current.id,
          preset: this.current.preset,
          text: this._fullText,
          preText: this._preText || '',   // 发送前的基线，刷新后靠它区分新旧回答
          stage,
          ts: now(),
        }));
      } catch (_) { /* ignore */ }
    },

    _clearSession() {
      try { sessionStorage.removeItem(RUN_KEY); } catch (_) { /* ignore */ }
    },

    _readSession() {
      try {
        const raw = JSON.parse(sessionStorage.getItem(RUN_KEY) || 'null');
        return raw && raw.id ? raw : null;
      } catch (_) { return null; }
    },

    /** 开始一个任务。text 是要处理的内容。 */
    start(presetId, text) {
      if (this.running) { toast('上一个任务还在跑，稍等'); return null; }
      const preset = presetById(presetId);
      text = (text || '').trim();
      if (!text) { toast('先贴点内容'); return null; }

      const item = Tasks.add({
        id: 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        preset: preset.id,
        presetName: preset.name,
        input: text.length > 4000 ? text.slice(0, 4000) : text,
        inputMore: text.length > 4000,
        output: '',
        status: 'running',
        mark: '⟦' + Math.random().toString(36).slice(2, 6) + '⟧',
        href: '',
        error: '',
        createdAt: now(),
        finishedAt: 0,
      });

      this._fullText = text;
      this.running = true;
      this.current = item;
      this._seen = '';
      this._preText = '';        // 每次都从零开始，避免沿用上一个任务的基线
      this._preHref = '';
      this._deadline = now() + 5 * 60 * 1000;   // 单个任务硬超时 5 分钟
      this._saveSession('newchat');
      this.step1_newChat(item);
      return item;
    },

    /** 第一步：新开对话，保证不共用上下文 */
    step1_newChat(item) {
      const btn = IO.newChatButton();
      if (!btn) {
        return this.fail(item, '没找到「New chat / 开启新对话」按钮，请手动新建对话后重试');
      }
      // 用 URL 变化判断新建是否真的生效：比数消息条数可靠，
      // 因为旧对话的消息会被虚拟列表卸载，条数不可比。
      this._preHref = IO.href();
      this._preText = '';   // 新建对话后回答区是空的，基线就是空
      this._saveSession('newchat');
      this._expectNav = true;       // 若是 <a> 导航，刷新后靠 sessionStorage 接上
      btn.click();
      setTimeout(() => {
        this._expectNav = false;
        if (this.current === item) this.step2_fill(item);
      }, 800);
    },

    /** 第二步：组信封并填入输入框 */
    step2_fill(item) {
      const el = IO.composer();
      if (!el) return this.fail(item, '没找到输入框');
      item.href = IO.href();
      Tasks.update(item.id, { href: item.href });

      // 关键校验：URL 没变、并且页面上还留着旧消息 = 还在旧对话里。
      // 继续发就会污染上下文，这正是「不共用会话」要避免的事，所以直接中止。
      // 注意不能只比 URL：本来就停在空白新对话页时 URL 也不会变。
      const sameUrl = this._preHref && item.href === this._preHref;
      const hasHistory = document.querySelectorAll('.ds-message').length > 0;
      if (sameUrl && hasHistory) {
        return this.fail(item, '新建对话没生效（仍在旧对话），为避免污染上下文已中止');
      }

      const env = buildEnvelope(presetById(item.preset), this._fullText, item.mark);

      // 整体覆写走原生 setter + InputEvent，对受控 React 最稳
      IO.setValue(el, env);
      if (!IO.value(el).trim()) {
        IO.insertText(el, env);   // 兜底：setValue 被 React 回写清空了
        if (!IO.value(el).trim()) return this.fail(item, '填入失败，请手动粘贴');
      }

      this._saveSession('send');
      // 填完给页面一拍，让发送键从 disabled 变 enabled
      setTimeout(() => this.step3_send(item), 300);
    },

    /** 第三步：发送，并以「输入框被清空」作为发出的判据 */
    /**
     * 第三步：发送。
     * 判据不能只看「输入框是否清空」——实测发现两个坑：
     *   1. 发送后 React 会替换 textarea 元素，旧引用读出来永远是空 → 误判成功；
     *   2. 更常见的是误判失败：旧引用值没变，其实消息早发出去了。
     * 所以每轮都重新取输入框，并同时看「是否开始生成 / 是否出现新消息」。
     */
    step3_send(item) {
      const el = IO.composer();
      if (!el) return this.fail(item, '输入框不见了');
      const before = IO.value(el).trim();
      const preMsgs = document.querySelectorAll('.ds-message').length;

      const sent = () => {
        const cur = IO.composer();
        const nowVal = cur ? IO.value(cur).trim() : '';
        const msgGrew = document.querySelectorAll('.ds-message').length > preMsgs;
        return nowVal !== before || msgGrew || IO.generating();
      };

      IO.send();

      // 轮询判定，而不是只看一次：React 换节点、流式启动都有延迟
      let tries = 0;
      const tick = setInterval(() => {
        if (this.current !== item) { clearInterval(tick); return; }
        if (sent()) {
          clearInterval(tick);
          this._saveSession('wait');
          return this.step4_wait(item);
        }
        if (++tries === 4) IO.clickSend();        // 约 1.2s 还没反应，改点发送键
        if (tries >= 12) {                        // 约 3.6s 仍无动静
          clearInterval(tick);
          this.fail(item, '发送失败：Enter 与发送键都没反应');
        }
      }, 300);
    },

    /** 第四步：等它真写完 —— 停止生成控件消失 + 文字不再增长 */
    /**
     * 第四步：等它真写完。
     * 完成 = 「停止生成」消失 + 正文连续 1.6s 不再增长。
     * 注意 DeepThink 会先思考很久（实测 2s 起步，复杂任务更久），
     * 这段时间 answers() 是空的、generating() 是 true，
     * 必须继续等，绝不能因为「没抓到回答」就判失败。
     */
    step4_wait(item) {
      this._seen = '';
      let quiet = 0;             // 连续稳定观察次数
      const QUIET_NEED = 4;      // 4 × 400ms ≈ 1.6s 稳定才收
      const MAX_IDLE = 60;       // 连续 24s「既不在生成、也没有正文」才算异常
      let idle = 0;
      // 发送前的最后一条回答。只有答案跟它不一样，才说明新回答真的来了。
      const baseline = this._preText;

      this._tick = setInterval(() => {
        if (!this.running || this.current !== item) return;
        if (now() > this._deadline) {
          this.stopWatch();
          return this.fail(item, '等待超时（5 分钟）');
        }

        const gen = IO.generating();
        const ans = IO.lastAnswer();
        const fresh = !!ans && ans !== baseline;

        // 还在生成：不管有没有正文，都算正常推进，重置空闲计数
        if (gen) {
          idle = 0;
          quiet = 0;
          if (fresh) this._seen = ans;
          return;
        }

        // 不在生成、也没有新正文 → 累计空闲
        if (!fresh) {
          idle++;
          quiet = 0;
          if (idle >= MAX_IDLE) {
            this.stopWatch();
            this.fail(item, !ans
              ? '没抓到回答，可能没有真正发出'
              : '没有等到新回答，疑似发进了旧对话');
          }
          return;
        }

        // 不在生成、且有新正文 → 等它稳定下来
        idle = 0;
        if (ans === this._seen) quiet++;
        else { quiet = 0; this._seen = ans; }

        if (quiet >= QUIET_NEED) {
          this.stopWatch();
          this.succeed(item, ans);
        }
      }, 400);
    },

    stopWatch() {
      if (this._tick) { clearInterval(this._tick); this._tick = 0; }
    },

    /**
     * 页面加载后尝试接上被刷新/整页导航打断的任务。
     * 只在 sessionStorage 里有现场、且 localStorage 里对应任务仍是 running 时接手。
     */
    resume() {
      const s = this._readSession();
      if (!s) return false;
      const item = Tasks.get(s.id);
      if (!item) { this._clearSession(); return false; }

      // 已经收尾（比如另一个标签页跑完了）→ 清现场
      if (item.status !== 'running') { this._clearSession(); return false; }

      // 现场太旧（> 6 分钟）视为僵尸
      if (now() - (s.ts || 0) > 6 * 60 * 1000) {
        this._clearSession();
        Tasks.update(item.id, { status: 'fail', error: '页面刷新后任务已失效，请重跑', finishedAt: now() });
        return false;
      }

      this.running = true;
      this.current = item;
      this._fullText = s.text || item.input || '';
      this._seen = '';
      this._deadline = (s.ts || now()) + 5 * 60 * 1000;
      this._preHref = '';

      const stage = s.stage || 'wait';
      if (stage === 'newchat') {
        // 卡在新建对话：重走填→发
        this._preText = IO.lastAnswer();
        setTimeout(() => this.step2_fill(item), 500);
      } else if (stage === 'send') {
        // 已经填好了，直接发；基线取「填进去之前」的样子已不可知，
        // 用当前最后一条回答兜底（通常是本次刚发出的那条的用户消息之上一条）
        this._preText = s.preText || '';
        setTimeout(() => this.step3_send(item), 500);
      } else {
        // 已发出，接着等：刷新前那条旧回答就是基线
        this._preText = s.preText || '';
        setTimeout(() => this.step4_wait(item), 500);
      }
      return true;
    },

    succeed(item, output) {
      this.running = false;
      this.current = null;
      this._clearSession();
      Tasks.update(item.id, {
        output: this.clean(output),
        status: 'done',
        finishedAt: now(),
        href: item.href || IO.href(),
      });
      toast('完成：' + item.presetName);
      UI.renderTasks();
    },

    fail(item, reason) {
      this.stopWatch();
      this.running = false;
      this.current = null;
      this._clearSession();
      Tasks.update(item.id, { status: 'fail', error: reason, finishedAt: now() });
      toast('失败：' + reason);
      UI.renderTasks();
    },

    /** 用户手动取消：尽量把已生成的部分留下 */
    cancel() {
      if (!this.running || !this.current) return;
      const item = this.current;
      this.stopWatch();
      this.running = false;
      this.current = null;
      this._clearSession();
      const partial = this.clean(IO.lastAnswer());
      Tasks.update(item.id, {
        status: partial ? 'done' : 'fail',
        output: partial || '',
        error: partial ? '已手动停止，结果可能不完整' : '已取消',
        finishedAt: now(),
      });
      toast('已停止');
      UI.renderTasks();
    },

    /** 复制的纯文本：去掉可能残留的标记 */
    clean(text) {
      return String(text || '')
        .replace(/[（(]标记 ⟦[^⟧]*⟧[^）)]*[）)]\s*/g, '')
        .replace(/⟦[a-z0-9]{3,8}⟧/gi, '')
        .trim();
    },
  };

  /* ============================== 插入 ============================== */

  const isMobile = () => window.matchMedia('(max-width: 640px)').matches;

  /** 只插入，不处理空位。返回 {el, built, base} 供后续填充 */
  function insertRaw(p) {
    const el = IO.composer();
    if (!el) { toast('没找到输入框，请先点一下对话框'); return null; }

    const built = buildInsert(p.body || '', Session.allowSingle());
    if (!IO.insertText(el, built.text)) { toast('插入失败，请手动粘贴'); return null; }

    Store.touch(p.id);
    const caret = IO.caret(el).end;
    return { el, built, base: caret - built.text.length };
  }

  function insertPrompt(p) {
    const r = insertRaw(p);
    if (!r) return false;
    const { el, built, base } = r;

    if (!built.slots.length || !IO.supportsRange(el)) {
      Session.settle(el);
      toast(built.slots.length ? '已插入（该输入框不支持跳格）' : '已插入');
      return true;
    }

    // 移动端没有 Tab 键：直接弹表单逐项填
    if (isMobile()) {
      UI.openFill(genericTemplate(p), built, base);
      return true;
    }

    const first = built.slots[0];
    IO.setRange(el, base + first.start, base + first.end);
    Session.begin(el);
    toast(`${built.slots.length} 个空位：直接打字覆盖，Tab 跳下一个`);
    return true;
  }

  /** 把单条提示词包成表单可用的"模板"形状 */
  function genericTemplate(p) {
    return {
      id: p.id,
      title: p.title,
      body: p.body,
      saveToId: null,
      isNew: false,
    };
  }

  /* =============================== UI =============================== */

  let toastEl = null;
  let toastTimer = 0;
  function toast(msg) {
    if (!UI.shadow) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      UI.shadow.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('show'), 2600);
  }

  const CSS = `
    :host {
      all: initial;
      --bg: #ffffff; --fg: #1f2328; --muted: #6b7280; --line: #e6e8ee;
      --hover: #f4f5f7; --accent: #4d6bfe; --danger: #e5484d; --shadow: 0 8px 32px rgba(0,0,0,.14);
      --chip-bg: #edf3fe; --chip-fg: #3964fe; --chip-border: #b7c8fe;
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      --font-ui: "quote-cjk-patch", Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif;
      color-scheme: light dark;
    }
    @media (prefers-color-scheme: dark) {
      :host { --bg: #21242b; --fg: #e9ebef; --muted: #9aa1ac; --line: #333842;
              --hover: #2b2f37; --accent: #7d92ff; --shadow: 0 8px 32px rgba(0,0,0,.5);
              --chip-bg: #1e2635; --chip-fg: #93a9ff; --chip-border: #33436b; }
    }
    * { box-sizing: border-box; }
    button, input, textarea { font: inherit; color: inherit; background: none; border: 0; outline: 0; margin: 0; padding: 0; }
    button { cursor: pointer; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 34%, transparent); border-radius: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }

    /* ---- 注入按钮：与 DeepThink / Search 同规格的胶囊 ---- */
    .chip {
      position: fixed; left: 0; top: 0;
      display: inline-flex; align-items: center; gap: 4px;
      height: 34px; padding: 0 10px; border-radius: 18px;
      font-family: var(--font-ui);
      font-size: 13px; font-weight: 500; line-height: 1;
      letter-spacing: normal;
      white-space: nowrap; cursor: pointer; user-select: none;
      border: 0.75px solid var(--chip-border); background: var(--chip-bg); color: var(--chip-fg);
      transition: background .15s ease, color .15s ease, border-color .15s ease;
      z-index: 2147483000;
    }
    .chip:hover { filter: brightness(.975); }
    .chip .ico { width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; flex: none; }
    .chip .ico svg { width: 14px; height: 14px; display: block; }
    .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .chip.on:hover { filter: brightness(1.06); }
    @media (prefers-color-scheme: dark) {
      .chip:hover { filter: brightness(1.14); }
    }
    .chip[hidden] { display: none !important; }

    .panel {
      position: fixed; left: 0; top: 0; width: 380px;
      max-height: var(--panel-max, 560px);
      background: var(--bg); color: var(--fg); border: 1px solid var(--line);
      border-radius: 14px; box-shadow: var(--shadow); display: flex; flex-direction: column;
      overflow: hidden; z-index: 2147483001;
    }
    .panel[hidden] { display: none !important; }

    .hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .hd .t { font-weight: 600; font-size: 13px; flex: 1; }
    .hd .sub { color: var(--muted); font-size: 11px; }
    .x { width: 24px; height: 24px; border-radius: 7px; color: var(--muted); font-size: 16px; line-height: 1; }
    .x:hover { background: var(--hover); color: var(--fg); }

    .search { padding: 8px 12px; border-bottom: 1px solid var(--line); }
    .search input {
      width: 100%; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line);
      background: var(--hover); color: var(--fg); font: inherit; outline: none;
    }
    .search input:focus { border-color: var(--accent); }

    .list { overflow-y: auto; flex: 1; padding: 6px; min-height: 60px; }
    .item { position: relative; padding: 9px 10px; border-radius: 9px; cursor: pointer; }
    .item:hover { background: var(--hover); }
    .it-t { font-weight: 600; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 76px; }
    .it-b {
      color: var(--muted); font-size: 11.5px; margin-top: 3px; overflow: hidden; line-height: 1.45;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; word-break: break-word;
    }
    .it-o { position: absolute; right: 6px; top: 6px; display: none; gap: 2px; }
    .item:hover .it-o { display: flex; }
    .it-o button { padding: 3px 7px; border-radius: 6px; font-size: 11px; color: var(--muted); background: var(--bg); border: 1px solid var(--line); }
    .it-o button:hover { color: var(--fg); }
    .it-o button.del:hover { color: var(--danger); border-color: var(--danger); }

    .empty { padding: 26px 14px; text-align: center; color: var(--muted); font-size: 12px; }

    .ft { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-top: 1px solid var(--line); }
    .ft .hint { color: var(--muted); font-size: 11px; margin-left: auto; }
    .btn { padding: 6px 12px; border-radius: 8px; font-size: 12px; border: 1px solid var(--line); }
    .btn:hover { background: var(--hover); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover { filter: brightness(1.06); }

    .form { padding: 12px; display: flex; flex-direction: column; gap: 9px; overflow-y: auto; flex: 1; }
    .form input, .form textarea {
      width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line);
      background: var(--hover); color: var(--fg); font: inherit; outline: none; resize: vertical;
    }
    .form textarea { min-height: 160px; line-height: 1.6; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .form input:focus, .form textarea:focus { border-color: var(--accent); }
    .vars { color: var(--muted); font-size: 11.5px; line-height: 1.7; }
    .vars b { color: var(--accent); font-weight: 600; }
    .vars .k {
      font-style: normal; font-size: 10px; margin-left: 3px;
      padding: 1px 4px; border-radius: 3px;
      color: var(--muted); background: var(--hover); border: 1px solid var(--line);
    }

    .toast {
      position: fixed; left: 50%; bottom: 40px; transform: translate(-50%, 12px);
      max-width: 460px; padding: 8px 14px; border-radius: 9px; font-size: 12px;
      background: rgba(28,30,36,.94); color: #fff; opacity: 0; pointer-events: none;
      transition: opacity .18s ease, transform .18s ease; z-index: 2147483002;
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }

    /* ---------------- 移动端：底部抽屉 + 图标按钮 ---------------- */
    @media (max-width: 640px) {
      .panel {
        left: 0 !important; right: 0 !important; bottom: 0 !important; top: auto !important;
        width: 100% !important; max-width: 100% !important;
        max-height: 76vh !important;
        border-radius: 16px 16px 0 0;
        border-left: 0; border-right: 0; border-bottom: 0;
        box-shadow: 0 -8px 32px rgba(0,0,0,.18);
        transform: none !important;
        padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 4px);
      }
      .chip {
        height: 32px; padding: 0 8px; border-radius: 16px; gap: 0;
      }
      .chip .lbl { display: none; }        /* 窄屏只留图标，避免压住发送键 */
      .chip .ico { width: 16px; height: 16px; }
      .chip .ico svg { width: 16px; height: 16px; }
      .hd { padding: 12px 14px; }
      .search { padding: 8px 14px; }
      .list { padding: 4px 8px; }
      .item { padding: 11px 10px; }
      .it-o { display: flex; opacity: 1; }  /* 触屏没有 hover，操作直接常显 */
      .ft {
        padding: 12px 14px calc(12px + env(safe-area-inset-bottom, 0px));
        flex: none;
      }
      .btn { padding: 10px 16px; font-size: 14px; }
      .form { padding: 14px; gap: 12px; }
      .form input, .form textarea { padding: 11px 12px; font-size: 16px; } /* 16px 防 iOS 自动放大 */
      .fillform { padding-bottom: 18px; }
      .toast {
        bottom: auto; top: 50%; transform: translate(-50%, -50%);
        max-width: 78vw; font-size: 13px; padding: 10px 16px;
      }
      .toast.show { transform: translate(-50%, -50%); opacity: 1; }
    }

    .fillform .fl { display: flex; flex-direction: column; gap: 5px; }
    .fillform .fl > span { font-size: 12px; color: var(--muted); font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .fillform textarea { min-height: 84px; }
    .fillform select {
      width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line);
      background: var(--hover); color: var(--fg); font: inherit; outline: none; cursor: pointer;
      appearance: none; -webkit-appearance: none;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");
      background-repeat: no-repeat;
      background-position: right 10px center;
      padding-right: 30px;
    }
    .fillform select:focus { border-color: var(--accent); }
    .tag {
      font-style: normal; font-size: 10px; font-weight: 500; line-height: 1;
      padding: 2px 5px; border-radius: 4px; color: var(--muted);
      background: var(--hover); border: 1px solid var(--line);
    }

    /* ---------------- 面板拖拽手柄（桌面 / 移动通用） ---------------- */
    .grab {
      position: relative;
      display: flex; align-items: center; justify-content: center;
      flex: none; height: 18px; cursor: grab;
      touch-action: none;                 /* 阻止页面跟着滚动 */
      -webkit-tap-highlight-color: transparent;
    }
    .grab .bar {
      width: 38px; height: 4px; border-radius: 2px;
      background: var(--line);
      transition: background .15s ease, width .15s ease;
    }
    .grab:hover .bar { background: var(--muted); width: 46px; }
    .grab:active { cursor: grabbing; }
    /* 右下角的高度手柄：单独拖它才改高度 */
    .grab .rs {
      position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
      width: 18px; height: 14px; border-radius: 4px;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; line-height: 1; color: var(--muted);
      cursor: ns-resize; opacity: .5;
    }
    .grab .rs:hover { opacity: 1; color: var(--accent); background: var(--hover); }
    .panel { will-change: transform; }
    .panel.dragging { transition: none; }
    .panel.snap { transition: transform .22s cubic-bezier(.22,.61,.36,1); }

    @media (max-width: 640px) {
      .grab { height: 22px; }
      .panel { max-height: var(--panel-max, 76vh) !important; }
    }

    /* ---------------- 任务页签 ---------------- */
    .tabs { display: flex; gap: 4px; padding: 8px 12px 0; }
    .tabs button {
      flex: 1; padding: 7px 0; border-radius: 8px 8px 0 0; font-size: 12.5px;
      color: var(--muted); border-bottom: 2px solid transparent;
    }
    .tabs button.on { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
    .tabs button:hover:not(.on) { background: var(--hover); }

    .tk { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
    .tk-in { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--line); }
    .tk-presets { display: flex; flex-wrap: wrap; gap: 5px; }
    .tk-presets button {
      padding: 5px 10px; border-radius: 14px; font-size: 12px; line-height: 1;
      border: 0.75px solid var(--line); color: var(--muted); background: var(--hover);
    }
    .tk-presets button.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    .tk-ta {
      width: 100%; min-height: 74px; max-height: 180px; resize: vertical;
      padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line);
      background: var(--hover); color: var(--fg); font: inherit; line-height: 1.55; outline: none;
    }
    .tk-ta:focus { border-color: var(--accent); }
    .tk-row { display: flex; align-items: center; gap: 8px; }
    .tk-row .hint { color: var(--muted); font-size: 11px; }
    .tk-go {
      margin-left: auto; padding: 7px 16px; border-radius: 8px; font-size: 12.5px;
      background: var(--accent); border: 1px solid var(--accent); color: #fff;
    }
    .tk-go:hover { filter: brightness(1.06); }
    .tk-go[disabled] { opacity: .55; cursor: default; filter: none; }

    .tk-list { overflow-y: auto; flex: 1; padding: 8px; display: flex; flex-direction: column; gap: 8px; max-height: min(48vh, 430px); }
    .card { border: 1px solid var(--line); border-radius: 10px; padding: 9px 10px; background: var(--bg); }
    .card.running { border-color: var(--accent); }
    .card.fail { border-color: var(--danger); }
    .c-hd { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .c-tag {
      font-size: 10.5px; padding: 2px 6px; border-radius: 5px; line-height: 1;
      color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .c-tag.fail { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .c-time { color: var(--muted); font-size: 10.5px; margin-left: auto; }
    .c-in {
      color: var(--muted); font-size: 11px; line-height: 1.5; margin-bottom: 6px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word;
    }
    .c-out {
      font-size: 12.5px; line-height: 1.68; white-space: pre-wrap; word-break: break-word;
      max-height: 260px; overflow-y: auto;
    }
    /* 公式：面板里没有 KaTeX，用等宽字体 + 底色标出来，至少能读 */
    .c-out .mth {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px; padding: 1px 4px; border-radius: 4px;
      background: color-mix(in srgb, var(--accent) 9%, transparent);
      color: var(--accent); white-space: pre-wrap;
    }
    .c-out .mth-blk {
      display: block; margin: 6px 0; padding: 6px 8px; border-radius: 6px;
      background: var(--hover); border-left: 2px solid var(--chip-border);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px; line-height: 1.6; color: var(--fg);
      white-space: pre-wrap; word-break: break-all; overflow-x: auto;
    }
    .c-out b { font-weight: 600; }
    .c-out .h { font-weight: 600; color: var(--fg); }
    .c-err { color: var(--danger); font-size: 11.5px; line-height: 1.6; }
    .c-ft { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .c-ft button {
      padding: 4px 9px; border-radius: 6px; font-size: 11px; color: var(--muted);
      border: 1px solid var(--line); background: var(--bg);
    }
    .c-ft button:hover { color: var(--fg); }
    .c-ft button.pri { color: var(--accent); border-color: var(--chip-border); background: var(--chip-bg); }
    .tk-empty { padding: 26px 14px; text-align: center; color: var(--muted); font-size: 12px; line-height: 1.7; }
  `;

  const UI = {
    host: null, root: null, shadow: null,
    open: false, view: 'list', editing: null, query: '',
    tab: 'tpl', taskPreset: 'enhance', taskDraft: '',

    mount() {
      if (this.host) return;
      const host = document.createElement('div');
      host.id = 'dspm-host';
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
      (document.body || document.documentElement).appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);

      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.title = '提示词模板（Alt+P）';
      chip.hidden = true;
      chip.innerHTML =
        '<span class="ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M4 6h9M4 12h13M4 18h6"/><path d="M17.5 15.5l3 3M20.5 15.5l-3 3"/></svg></span>' +
        '<span class="lbl">提示词</span>';
      chip.addEventListener('mousedown', (e) => e.preventDefault()); // 别抢输入框焦点
      chip.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.toggle(); });
      shadow.appendChild(chip);

      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.hidden = true;
      shadow.appendChild(panel);

      this.host = host;
      this.shadow = shadow;
      this.chip = chip;
      this.panel = panel;

      panel.addEventListener('mousedown', (e) => e.stopPropagation());
      panel.addEventListener('click', (e) => this.onClick(e));
      panel.addEventListener('input', (e) => this.onInput(e));
      panel.addEventListener('keydown', (e) => this.onPanelKey(e));

      this.reanchor();
      window.addEventListener('resize', () => this.reanchor());
      document.addEventListener('scroll', () => this.reanchor(), true);
      const mo = new MutationObserver(() => this.scheduleAnchor());
      mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      this._ro = new ResizeObserver(() => this.reanchor());
    },

    scheduleAnchor() {
      if (this._raf) return;
      // 流式输出时属性变化极频繁，限制到 ~80ms 一次，避免布局抖动
      const now = Date.now();
      const wait = Math.max(0, 80 - (now - (this._lastAnchor || 0)));
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this._lastAnchor = Date.now();
        this.reanchor();
      });
      if (wait > 4) { /* rAF 已足够，保留最小间隔语义 */ }
    },

    reanchor() {
      const el = IO.composer();
      if (!el) { if (this.chip) this.chip.hidden = true; return; }
      const r = IO.rect(el);
      // 输入框还没布局出来（宽高为 0）时不要记录签名、也不要定位，
      // 否则这个假位置会被当成"没变过"，后续再也不会重算。
      if (!r || r.width < 20 || r.height < 10) { if (this.chip) this.chip.hidden = true; return; }

      // 位置没变就不写样式，避免无谓的重排
      const sig = [r.left, r.right, r.top, r.bottom, r.width, r.height].join(',');
      const changed = sig !== this._sig;
      this._sig = sig;

      this.placeChip(r);

      if (this._ro && this._roEl !== el) {
        try { this._ro.disconnect(); this._ro.observe(el); } catch (_) {}
        this._roEl = el;
      }

      if (this.open && (changed || !this._placed)) {
        this.placePanel(r);
        this._placed = true;
      }
    },

    /** 找到 DeepThink / Search 所在的那一行，把按钮并排插进去 */
    toolbarRow(el) {
      const root = el.closest('form') || el.parentElement.parentElement.parentElement.parentElement;
      if (!root) return null;
      const toggles = root.querySelectorAll('.ds-toggle-button, [class*="toggle-button"]');
      if (!toggles.length) return null;
      const row = toggles[0].parentElement;
      // 同一行必须至少有 2 个开关，避免抓到奇怪结构
      return row && row.querySelectorAll('.ds-toggle-button, [class*="toggle-button"]').length >= 1 ? row : null;
    },

    /** 找到发送键的矩形，移动端用来避让 */
    sendButtonRect() {
      const root = IO.composer();
      if (!root) return null;
      const scope = root.closest('form') || root.parentElement.parentElement.parentElement.parentElement;
      if (!scope) return null;
      const cands = [...scope.querySelectorAll('div,button')].filter((e) => {
        const c = (e.className || '').toString();
        if (!/ds-button/.test(c) || /ds-button__|toggle-button/.test(c)) return false;
        const r = e.getBoundingClientRect();
        return r.width >= 26 && r.width <= 64 && r.height >= 26 && r.height <= 64;
      });
      if (!cands.length) return null;
      // 取最靠右的那个（发送键）
      let best = null;
      for (const e of cands) {
        const r = e.getBoundingClientRect();
        if (!best || r.right > best.right) best = r;
      }
      return best;
    },

    placeChip(r) {
      const chip = this.chip;
      chip.classList.toggle('compact', isMobile());

      // 移动端：右侧有悬浮发送键，按钮必须让它，否则会盖住发送
      const sendRect = isMobile() ? this.sendButtonRect() : null;

      // 输入框节点会被 React 整个替换，缓存必须每次都校验还在文档里，
      // 否则拿着一个 isConnected=false 的旧节点算出来全是 0，
      // 按钮就会钉到左上角（实测踩过：translate(10px, 0px) 盖住 logo）。
      const live = IO.composer();
      let rowEl = live;
      if (rowEl) this._cachedComposer = rowEl;
      else if (this._cachedComposer && this._cachedComposer.isConnected) rowEl = this._cachedComposer;

      const row = rowEl ? this.toolbarRow(rowEl) : null;
      if (row) {
        const lastEl = row.lastElementChild;
        const last = lastEl ? lastEl.getBoundingClientRect() : row.getBoundingClientRect();
        const cw = chip.getBoundingClientRect().width || 78;
        const left = last.right + 10;
        const refH = last.height || 34;
        const top = last.top + refH / 2 - (chip.offsetHeight || 34) / 2;

        // 几何没算出来（宽高为 0）就别用，宁可走兜底也不要钉到 0,0
        if (last.width > 0 && last.height > 0) {
          const limit = sendRect ? sendRect.left - 6 : window.innerWidth - 8;
          if (left + cw <= limit) {
            const t = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
            if (chip.style.transform !== t) chip.style.transform = t;
            chip.hidden = false;
            return;
          }
          // 放不下：移到工具条左侧的空白处（DeepThink 之前通常有空位）
          const firstEl = row.firstElementChild;
          const first = firstEl ? firstEl.getBoundingClientRect() : null;
          if (first && first.width > 0) {
            const left2 = Math.max(8, first.left - cw - 10);
            const t2 = `translate(${Math.round(left2)}px, ${Math.round(top)}px)`;
            if (chip.style.transform !== t2) chip.style.transform = t2;
            chip.hidden = false;
            return;
          }
        }
      }
      // 兜底：贴在输入框右下角（避开发送键）
      // 但如果连输入框几何都没算出来，就别硬贴 —— 宁可先藏起来，
      // 等下一次 MutationObserver 触发时再定位，也不要钉在页面左上角。
      if (!r || r.width < 20 || r.height < 10) { chip.hidden = true; return; }
      const size = 34;
      const left = clamp(r.right - 82, 8, window.innerWidth - size - 8);
      const top = clamp(r.bottom - size - 12, 8, window.innerHeight - size - 8);
      const t = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      if (chip.style.transform !== t) chip.style.transform = t;
      chip.hidden = false;
    },

    placePanel(r) {
      applyPanelHeight(this.panel, Store.data.settings.panelMax || 0);
      if (isMobile()) {
        // 移动端是贴底抽屉，由 CSS 定位，清掉桌面用的内联位移
        this.panel.style.transform = '';
        return;
      }

      const w = 380;
      const h = this.panel.getBoundingClientRect().height || Math.min(560, window.innerHeight * 0.72);

      // 用户手动拖过 → 尊重他放的位置，别再自动贴回输入框旁边
      const pos = Store.data.settings.panelPos;
      if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
        const left = clamp(pos.left, 8, Math.max(8, window.innerWidth - w - 8));
        const top = clamp(pos.top, 8, Math.max(8, window.innerHeight - h - 8));
        this.panel.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
        return;
      }

      let left = r.right + 16;
      if (left + w > window.innerWidth - 12) left = clamp(r.right - w - 16, 12, window.innerWidth - w - 12);
      const top = clamp(r.bottom - h, 56, window.innerHeight - h - 12);
      this.panel.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    },

    show() {
      this.open = true;
      this.panel.hidden = false;
      if (this.chip) this.chip.classList.add('on');
      this.render();
      this._placed = false;   // 每次打开都强制重新定位
      this.reanchor();
      const s = this.panel.querySelector('.search input');
      if (s) setTimeout(() => s.focus(), 0);
    },

    hide() {
      this.open = false;
      this.panel.hidden = true;
      this._placed = false;
      if (this.chip) this.chip.classList.remove('on');
      this.commitDraftIfNeeded();
    },

    toggle() {
      if (this.open) this.hide();
      else { this.view = 'list'; this.show(); }
    },

    /** 直接打开任务页签（Alt+T） */
    showTask() {
      this.view = 'list';
      this.tab = 'task';
      if (this.open) this.render();
      else this.show();
      this.renderTasks();
    },

    commitDraftIfNeeded() {
      // 关闭时丢弃未保存草稿，避免误触insert脏数据
      if (this.view === 'edit') this.view = 'list';
    },

    /**
     * 顶部手柄：
     *   data-grab   —— 拖它移动面板（桌面）/ 下拉收起（移动端）
     *   data-resize —— 拖它调高度，只在桌面显示
     */
    grabHTML() {
      const mobile = isMobile();
      return `<div class="grab" data-grab title="${mobile ? '下拉收起' : '拖动移动面板'}">`
        + `<i class="bar"></i>`
        + (mobile ? '' : '<button class="rs" data-resize type="button" title="拖动调整高度">⤡</button>')
        + `</div>`;
    },

    render() {
      const grab = this.grabHTML();
      if (this.view === 'fill') {
        this.panel.innerHTML = grab + this.tplFill();
        this.bindDrag();
        this.bindResize();
        return;
      }
      if (this.tab === 'task' && this.view === 'list') {
        this.panel.innerHTML = grab + this.tplTask();
        this.bindDrag();
        this.bindResize();
        this.restoreTaskDraft();
        return;
      }
      this.panel.innerHTML = grab + this.tabsHTML() + (this.view === 'edit' ? this.tplEditor() : this.tplList());
      this.bindDrag();
      this.bindResize();
      if (this.view === 'edit') {
        const t = this.panel.querySelector('[data-f="title"]');
        const b = this.panel.querySelector('[data-f="body"]');
        const p = this.editing ? Store.get(this.editing) : null;
        if (t) t.value = p ? p.title : '';
        if (b) b.value = p ? p.body : '';
        this.updateVarHint();
        setTimeout(() => (t && t.focus()), 0);
      }
    },

    tabsHTML() {
      const mk = (k, label) =>
        `<button data-act="tab" data-tab="${k}" class="${this.tab === k ? 'on' : ''}">${label}</button>`;
      return `<div class="tabs">${mk('tpl', '模板')}${mk('task', '任务')}</div>`;
    },

    /** 任务页签：上面是输入 + 用途，下面是结果卡 */
    tplTask() {
      const chips = PRESETS.map((p) =>
        `<button data-act="preset" data-preset="${p.id}" class="${this.taskPreset === p.id ? 'on' : ''}"
           title="${esc(p.hint)}">${esc(p.name)}</button>`).join('');
      const running = Runner.running;
      return `
        ${this.tabsHTML()}
        <div class="hd">
          <div class="t">任务</div>
          <div class="sub">${running ? '运行中…' : '每次新开对话'}</div>
          <button class="x" data-act="close">×</button>
        </div>
        <div class="tk">
          <div class="tk-in">
            <div class="tk-presets">${chips}</div>
            <textarea class="tk-ta" data-tk="draft" placeholder="把要处理的内容贴进来，点下面的按钮…"></textarea>
            <div class="tk-row">
              <span class="hint">${esc(presetById(this.taskPreset).hint)}</span>
              ${running
                ? '<button class="tk-go" data-act="cancel-run" style="background:var(--danger);border-color:var(--danger)">停止</button>'
                : '<button class="tk-go" data-act="run">运行</button>'}
            </div>
          </div>
          <div class="tk-list" data-tk="list">${this.taskListHTML()}</div>
        </div>`;
    },

    taskListHTML() {
      const items = Tasks.data.items;
      if (!items.length) {
        return '<div class="tk-empty">还没有结果。<br>贴一段文字，点「运行」，结果会出现在这里。</div>';
      }
      return items.map((it) => this.cardHTML(it)).join('');
    },

    cardHTML(it) {
      const running = it.status === 'running';
      const fail = it.status === 'fail';
      const time = new Date(it.finishedAt || it.createdAt).toLocaleTimeString('zh-CN', { hour12: false });
      const tagCls = fail ? 'c-tag fail' : 'c-tag';
      const body = running
        ? '<div class="c-err" style="color:var(--muted)">正在生成，稍等…</div>'
        : fail
          ? `<div class="c-err">${esc(it.error || '失败')}</div>`
          : `<div class="c-out">${renderMath(it.output || '')}</div>`;
      const ops = running
        ? '<button data-act="cancel-run">停止</button>'
        : [
          it.output ? '<button class="pri" data-act="copy" data-id="' + it.id + '">复制</button>' : '',
          it.href ? '<button data-act="goto" data-id="' + it.id + '">打开对话</button>' : '',
          '<button data-act="rerun" data-id="' + it.id + '">重跑</button>',
          '<button data-act="drop" data-id="' + it.id + '">删除</button>',
        ].filter(Boolean).join('');

      return `
        <div class="card ${running ? 'running' : ''} ${fail ? 'fail' : ''}" data-card="${it.id}">
          <div class="c-hd">
            <span class="${tagCls}">${esc(it.presetName || '')}</span>
            <span class="c-time">${time}</span>
          </div>
          <div class="c-in">${esc(it.input || '')}${it.inputMore ? ' …' : ''}</div>
          ${body}
          <div class="c-ft">${ops}</div>
        </div>`;
    },

    /** 只刷结果区，不重建输入框（否则会把正在输入的内容冲掉） */
    renderTasks() {
      if (this.view !== 'list' || this.tab !== 'task' || !this.panel) return;
      const list = this.panel.querySelector('[data-tk="list"]');
      if (list) list.innerHTML = this.taskListHTML();
      const sub = this.panel.querySelector('.hd .sub');
      if (sub) sub.textContent = Runner.running ? '运行中…' : '每次新开对话';
      const go = this.panel.querySelector('.tk-go');
      if (go) {
        const isRunning = Runner.running;
        go.textContent = isRunning ? '停止' : '运行';
        go.dataset.act = isRunning ? 'cancel-run' : 'run';
        go.style.background = isRunning ? 'var(--danger)' : '';
        go.style.borderColor = isRunning ? 'var(--danger)' : '';
      }
    },

    restoreTaskDraft() {
      const ta = this.panel.querySelector('[data-tk="draft"]');
      if (ta) {
        ta.value = this.taskDraft || '';
        setTimeout(() => { if (!isMobile()) ta.focus(); }, 0);
      }
    },

    /* ---------------- 拖拽：移动位置（桌面）/ 下拉收起（移动端） ---------------- */

    /**
     * 把 move/up 绑到 document，并返回解绑函数。
     * 指针被 capture 或移出小把手后，事件不会再到把手自己身上，
     * 所以必须挂 document 级；同时每次重绑前先解绑旧的，避免叠加。
     */
    _bindDoc(move, finish) {
      const opts = { passive: false };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
      document.addEventListener('touchmove', move, opts);
      document.addEventListener('touchend', finish);
      return () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        document.removeEventListener('touchmove', move, opts);
        document.removeEventListener('touchend', finish);
      };
    },

    _unbindDoc(ctl) {
      try { if (typeof ctl === 'function') ctl(); } catch (_) {}
    },

    /**
     * 桌面端：拖把手 = 移动整个面板，位置记进 settings.panelPos，下次打开沿用。
     * 移动端：整块下拉 → 超过阈值收起，否则回弹（底部抽屉的常规手势）。
     * 高度调整见下方的独立角度手柄 bindResize()。
     */
    bindDrag() {
      const grab = this.panel.querySelector('[data-grab]');
      if (!grab) return;
      // 每次 render() 都会重建 DOM 并重新 bind；document 上的监听必须去重，
      // 否则拖一次会叠加 N 个 handler（面板会跳、位置会乱）。
      if (this._dragBound) this._unbindDoc(this._dragCtl);
      this._dragBound = true;
      const panel = this.panel;
      const mobile = isMobile();

      let startY = 0, startX = 0, dx = 0, dy = 0;
      let dragging = false, moved = false;
      let startRect = null;

      const down = (e) => {
        // 按在右下角高度手柄上时，交给 bindResize 处理，别同时挪面板
        const t = e.target;
        if (t && t.closest && t.closest('[data-resize]')) return;
        const pt = e.touches ? e.touches[0] : e;
        dragging = true;
        moved = false;
        startX = pt.clientX;
        startY = pt.clientY;
        dx = dy = 0;
        startRect = panel.getBoundingClientRect();
        panel.classList.add('dragging');
        panel.classList.remove('snap');
      };

      const move = (e) => {
        if (!dragging) return;
        const pt = e.touches ? e.touches[0] : e;
        dx = pt.clientX - startX;
        dy = pt.clientY - startY;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;

        if (mobile) {
          panel.style.transform = `translateY(${Math.max(0, dy)}px)`;
          if (e.cancelable) e.preventDefault();
          return;
        }

        // 桌面：跟着鼠标走，夹在视口内，别让面板被拖到看不见的地方
        const w = startRect.width;
        const h = startRect.height;
        const left = clamp(startRect.left + dx, 8, window.innerWidth - w - 8);
        const top = clamp(startRect.top + dy, 8, window.innerHeight - h - 8);
        panel.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
        if (e.cancelable) e.preventDefault();
      };

      const finish = () => {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('dragging');
        panel.classList.add('snap');

        if (mobile) {
          const h = startRect ? startRect.height : 300;
          if (dy > Math.min(110, h * 0.28)) {
            panel.style.transform = '';
            setTimeout(() => { panel.classList.remove('snap'); this.hide(); }, 160);
          } else {
            panel.style.transform = '';
            setTimeout(() => panel.classList.remove('snap'), 240);
          }
          dy = 0;
          return;
        }

        // 记住新位置。没真正拖动过（只是点了一下）就不覆盖。
        if (moved) {
          const r = panel.getBoundingClientRect();
          Store.data.settings.panelPos = {
            left: Math.round(clamp(r.left, 8, window.innerWidth - r.width - 8)),
            top: Math.round(clamp(r.top, 8, window.innerHeight - r.height - 8)),
          };
          Store.save();
        }
        setTimeout(() => panel.classList.remove('snap'), 240);
        dx = dy = 0;
      };

      // 同 bindResize：move/up 绑 document，避免指针移出把手后丢失事件
      grab.addEventListener('pointerdown', (e) => {
        try { grab.setPointerCapture(e.pointerId); } catch (_) {}
        down(e);
      });
      grab.addEventListener('touchstart', down, { passive: false });
      this._dragCtl = this._bindDoc(move, finish);

      // 双击把手 → 位置与高度一起恢复默认
      grab.addEventListener('dblclick', () => {
        Store.data.settings.panelMax = 0;
        Store.data.settings.panelPos = null;
        Store.save();
        applyPanelHeight(panel, 0);
        const el = IO.composer();
        if (el) this.placePanel(IO.rect(el));
      });
    },

    /* ---------------- 角度手柄：调整面板高度 ---------------- */

    bindResize() {
      const grip = this.panel.querySelector('[data-resize]');
      if (!grip) return;
      if (this._resizeBound) this._unbindDoc(this._resizeCtl);
      this._resizeBound = true;
      const panel = this.panel;
      let startY = 0, startH = 0, resizing = false;

      const minH = 180;
      const maxH = () => Math.min(window.innerHeight * 0.9, 900);

      const down = (e) => {
        const pt = e.touches ? e.touches[0] : e;
        resizing = true;
        startY = pt.clientY;
        startH = panel.getBoundingClientRect().height || 400;
        panel.classList.add('dragging');
        panel.classList.remove('snap');
      };

      const move = (e) => {
        if (!resizing) return;
        const pt = e.touches ? e.touches[0] : e;
        // 手柄在顶部：往上拖变高，往下拖变矮
        const h = clamp(startH - (pt.clientY - startY), minH, maxH());
        panel.style.setProperty('--panel-max', h + 'px');
        panel.style.maxHeight = h + 'px';
        if (e.cancelable) e.preventDefault();
      };

      const finish = () => {
        if (!resizing) return;
        resizing = false;
        panel.classList.remove('dragging');
        panel.classList.add('snap');

        const h = Math.round(panel.getBoundingClientRect().height);
        Store.data.settings.panelMax = h;
        Store.save();

        // 手动定位过就保持；否则按新高度重新贴到输入框上方
        if (!Store.data.settings.panelPos) {
          const el = IO.composer();
          if (el) this.placePanel(IO.rect(el));
        }
        setTimeout(() => panel.classList.remove('snap'), 240);
      };

      // move/up 绑在 document 上：指针一旦被 capture 或移出 18px 的小手柄，
      // 事件就不会再落到 grip 自己身上（实测真实鼠标拖不动就是这个原因）。
      grip.addEventListener('pointerdown', (e) => {
        try { grip.setPointerCapture(e.pointerId); } catch (_) {}
        down(e);
      });
      grip.addEventListener('touchstart', down, { passive: false });
      this._resizeCtl = this._bindDoc(move, finish);
    },

    tplList() {
      return `
        <div class="hd">
          <div class="t">提示词</div>
          <div class="sub">${Store.data.prompts.length} 条</div>
          <button class="x" data-act="close">×</button>
        </div>
        <div class="search"><input placeholder="搜索标题或正文…" value="${esc(this.query)}"></div>
        <div class="list">${this.listHTML()}</div>
        <div class="ft">
          <button class="btn primary" data-act="new">＋ 新建</button>
          <span class="hint">${isMobile() ? '点条目直接填入' : 'Alt+P 开关 · Alt+T 任务'}</span>
        </div>`;
    },

    listHTML() {
      const items = Store.search(this.query);
      if (!items.length) {
        return `<div class="empty">${this.query ? '没有匹配的提示词' : '还没有提示词，点下面「新建」'}</div>`;
      }
      return items.map((p) => `
        <div class="item" data-id="${p.id}">
          <div class="it-t">${esc(p.title || '未命名')}</div>
          <div class="it-b">${esc((p.body || '').replace(/\n+/g, ' '))}</div>
          <div class="it-o">
            <button data-act="edit" data-id="${p.id}">编辑</button>
            <button class="del" data-act="del" data-id="${p.id}">删除</button>
          </div>
        </div>`).join('');
    },

    tplEditor() {
      return `
        <div class="hd">
          <div class="t">${this.editing ? '编辑提示词' : '新建提示词'}</div>
          <button class="x" data-act="cancel">×</button>
        </div>
        <div class="form">
          <input data-f="title" placeholder="标题，例如：论文摘要润色">
          <textarea data-f="body" placeholder="正文。用 {{变量}} 留空位，例如：请把下面内容改写为 {{字数}} 字摘要。"></textarea>
          <div class="vars" data-f="hint"></div>
        </div>
        <div class="ft">
          <button class="btn primary" data-act="save">保存并插入</button>
          <button class="btn" data-act="save-only">只保存</button>
          <button class="btn" data-act="cancel">取消</button>
        </div>`;
    },

    /* ---------------- 填空表单 ---------------- */

    tplFill() {
      const t = this.fill;
      if (!t) return '';
      const fields = t.slots.map((s, i) => {
        const label = esc(s.name);
        const badge = s.multiline ? '<i class="tag">多行</i>'
          : s.options ? '<i class="tag">选择</i>'
            : s.optional ? '<i class="tag">选填</i>' : '';
        const preset = presetOf(s);

        // 下拉
        if (s.options && s.options.length) {
          const opts = s.options.map((o) =>
            `<option value="${esc(o)}"${o === preset ? ' selected' : ''}>${esc(o)}</option>`).join('');
          const blank = s.optional ? '<option value="">（不填）</option>' : '';
          return `<label class="fl"><span>${label}${badge}</span>
            <select data-fill="${i}">${blank}${opts}</select></label>`;
        }

        // 多行
        if (s.multiline) {
          return `<label class="fl"><span>${label}${badge}</span>
            <textarea data-fill="${i}" rows="3" placeholder="填写 ${label}">${esc(preset)}</textarea></label>`;
        }

        // 单行
        return `<label class="fl"><span>${label}${badge}</span>
          <input data-fill="${i}" placeholder="填写 ${label}" value="${esc(preset)}"></label>`;
      }).join('');

      const hasPreset = t.slots.some((s) => presetOf(s) !== '');
      const hint = hasPreset
        ? '已带入默认值，可直接改。留空则保留 <b>{{原名}}</b> 占位。'
        : '留空则保留 <b>{{原名}}</b> 占位。';

      return `
        <div class="hd">
          <div class="t">${esc(t.title || '填写空位')}</div>
          <div class="sub">${t.slots.length} 项</div>
          <button class="x" data-act="fill-cancel">×</button>
        </div>
        <div class="form fillform">
          ${fields}
          <div class="vars">${hint}</div>
        </div>
        <div class="ft">
          <button class="btn primary" data-act="fill-apply">填入</button>
          <button class="btn" data-act="fill-cancel">取消</button>
        </div>`;
    },

    updateFillPreview() {
      // 占位：实时预览留给下一版
    },

    applyFill() {
      const t = this.fill;
      if (!t) return;
      const vals = t.slots.map((s, i) => {
        const el = this.panel.querySelector(`[data-fill="${i}"]`);
        return el ? el.value : '';
      });
      const target = IO.composer();
      if (!target) { toast('输入框不见了'); return; }

      const cur = IO.value(target);
      const base = this.fillBase;
      // 从后往前替换，避免偏移错乱
      let out = cur;
      for (let i = t.slots.length - 1; i >= 0; i--) {
        if (!vals[i]) continue;
        const s = t.slots[i];
        const a = base + s.start;
        const b = base + s.end;
        if (a < 0 || b > out.length) continue;
        out = out.slice(0, a) + vals[i] + out.slice(b);
      }
      IO.setValue(target, out);
      Session.begin(target);      // 允许继续用 Tab 微调（桌面）
      Session.end();              // 但立即结束，避免表单填充后仍劫持
      this.fill = null;
      this.view = 'list';
      this.closeDrawer();
      toast('已填入');
    },

    /** 收起抽屉：移动端先下滑再隐藏，桌面端直接隐藏 */
    closeDrawer() {
      const panel = this.panel;
      if (isMobile() && panel && !panel.hidden) {
        panel.classList.add('snap');
        panel.style.transform = 'translateY(100%)';
        this.open = false;
        this._placed = false;
        if (this.chip) this.chip.classList.remove('on');
        setTimeout(() => {
          panel.hidden = true;
          panel.style.transform = '';
          panel.classList.remove('snap');
          this.commitDraftIfNeeded();
        }, 220);
        return;
      }
      this.hide();
    },

    updateVarHint() {
      const b = this.panel.querySelector('[data-f="body"]');
      const hint = this.panel.querySelector('[data-f="hint"]');
      if (!b || !hint) return;
      const ast = parse(b.value, Session.allowSingle());
      if (!ast.vars.length) {
        hint.innerHTML = '未检测到空位。写法：<b>{{名字}}</b> 空位 · <b>{{名字=默认}}</b> 默认值 · '
          + '<b>{{名字:甲,乙}}</b> 下拉 · <b>{{名字@long}}</b> 多行';
        return;
      }
      const items = ast.vars.map((v) => {
        let kind = '';
        if (v.options && v.options.length) kind = `选 ${v.options.length} 项`;
        else if (v.defVal != null && v.defVal !== '') kind = '默认';
        else if (v.multiline) kind = '多行';
        else if (v.optional) kind = '选填';
        return `<b>${esc(v.name)}</b>${kind ? `<i class="k">${kind}</i>` : ''}`;
      }).join('、');
      hint.innerHTML = `检测到 ${ast.vars.length} 个空位：${items}`;
    },

    onInput(e) {
      if (this.view === 'list' && e.target.matches('.search input')) {
        this.query = e.target.value;
        const list = this.panel.querySelector('.list');
        if (list) list.innerHTML = this.listHTML();
        return;
      }
      if (this.view === 'list' && e.target.matches('[data-tk="draft"]')) {
        this.taskDraft = e.target.value;
        return;
      }
      if (this.view === 'edit' && e.target.matches('[data-f="body"]')) this.updateVarHint();
    },

    onPanelKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); this.hide(); return; }
      // 任务页签：Ctrl/Cmd+Enter 直接运行
      if (this.tab === 'task' && this.view === 'list'
        && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.matches('[data-tk="draft"]')) {
        e.preventDefault();
        return this.runTask();
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.save(e.target.closest('.form') ? 'save' : 'save');
      }
      if (e.key === 'Enter' && !e.shiftKey && this.view === 'edit' && e.target.matches('[data-f="title"]')) {
        e.preventDefault();
        const b = this.panel.querySelector('[data-f="body"]');
        if (b) b.focus();
      }
    },

    /* ---------------- 任务动作 ---------------- */

    runTask() {
      const ta = this.panel.querySelector('[data-tk="draft"]');
      const text = ta ? ta.value : this.taskDraft;
      if (!text || !text.trim()) { toast('先贴点内容'); return; }
      const item = Runner.start(this.taskPreset, text);
      if (!item) return;
      this.taskDraft = '';           // 已发出，清空草稿避免误重发
      if (ta) ta.value = '';
      if (ta) ta.blur();             // 把焦点还给页面，别挡着发送
      this.renderTasks();
    },

    copyResult(id) {
      const it = Tasks.get(id);
      if (!it || !it.output) return;
      const text = it.output;
      const done = () => toast('已复制');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, () => this._fallbackCopy(text, done));
      } else {
        this._fallbackCopy(text, done);
      }
    },

    _fallbackCopy(text, done) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        done();
      } catch (_) {
        toast('复制失败，请手动选中');
      }
    },

    gotoResult(id) {
      const it = Tasks.get(id);
      if (!it || !it.href) return;
      if (it.href === IO.href()) { toast('就在当前对话'); this.hide(); return; }
      this.hide();
      location.href = it.href;
    },

    dropResult(id) {
      Tasks.remove(id);
      this.renderTasks();
    },

    onClick(e) {
      const act = e.target.closest('[data-act]');
      const item = e.target.closest('.item');
      if (act) {
        const a = act.dataset.act;
        if (a === 'tab') {
          this.tab = act.dataset.tab;
          this.view = 'list';
          return this.render();
        }
        if (a === 'preset') {
          this.taskPreset = act.dataset.preset;
          const wrap = this.panel.querySelector('.tk-presets');
          if (wrap) {
            [...wrap.children].forEach((b) => b.classList.toggle('on', b.dataset.preset === this.taskPreset));
          }
          const hint = this.panel.querySelector('.tk-row .hint');
          if (hint) hint.textContent = presetById(this.taskPreset).hint;
          return;
        }
        if (a === 'run') return this.runTask();
        if (a === 'cancel-run') return Runner.cancel();
        if (a === 'copy') return this.copyResult(act.dataset.id);
        if (a === 'goto') return this.gotoResult(act.dataset.id);
        if (a === 'drop') return this.dropResult(act.dataset.id);
        if (a === 'rerun') {
          const it = Tasks.get(act.dataset.id);
          if (!it) return;
          this.taskPreset = it.preset;
          this.tab = 'task';
          return this.runTaskWith(it);
        }
        if (a === 'close') return this.hide();
        if (a === 'fill-apply') return this.applyFill();
        if (a === 'fill-cancel') { this.fill = null; this.view = 'list'; this.hide(); return; }
        if (a === 'new') { this.view = 'edit'; this.editing = null; return this.render(); }
        if (a === 'edit') { this.view = 'edit'; this.editing = act.dataset.id; return this.render(); }
        if (a === 'del') { this.doDelete(act.dataset.id); return; }
        if (a === 'cancel') { this.view = 'list'; return this.render(); }
        if (a === 'save') return this.save('both');
        if (a === 'save-only') return this.save('only');
      }
      if (item) {
        const p = Store.get(item.dataset.id);
        if (p) { this.hide(); setTimeout(() => insertPrompt(p), 0); }
      }
    },

    /** 重跑：沿用原来的输入内容 */
    runTaskWith(it) {
      if (Runner.running) { toast('上一个任务还在跑，稍等'); return; }
      Runner.start(it.preset, it.input || '');
      this.render();
    },

    doDelete(id) {
      const p = Store.get(id);
      if (!p) return;
      if (!confirm(`删除「${p.title}」？`)) return;
      Store.remove(id);
      this.render();
      toast('已删除');
    },

    save(mode) {
      const t = this.panel.querySelector('[data-f="title"]');
      const b = this.panel.querySelector('[data-f="body"]');
      const title = (t && t.value.trim()) || '';
      const body = (b && b.value) || '';
      if (!body.trim()) { toast('正文不能为空'); return; }
      let p;
      if (this.editing) p = Store.update(this.editing, { title: title || '未命名提示词', body });
      else p = Store.add({ title, body });
      this.view = 'list';
      this.editing = null;
      this.render();
      if (mode === 'only') { toast('已保存'); return; }
      const mobile = isMobile();
      this.hide();
      setTimeout(() => {
        if (mobile) {
          // 移动端：先插入，再弹表单收集空位
          const r = insertRaw(p);
          if (r && r.built.slots.length) {
            UI.openFill(genericTemplate(p), r.built, r.base);
          } else if (r) {
            toast('已插入');
          }
        } else {
          insertPrompt(p);
        }
      }, 0);
    },

    /** 打开填空表单（移动端主路径） */
    openFill(template, built, base) {
      // built.slots 已带 options / defVal / multiline / optional，直接用
      this.fill = {
        id: template.id || null,
        title: template.title,
        slots: built.slots.map((s) => ({
          name: s.name,
          start: s.start,
          end: s.end,
          multiline: !!s.multiline,
          optional: !!s.optional,
          options: s.options || null,
          defVal: s.defVal != null ? s.defVal : null,
        })),
      };
      this.fillBase = base;
      this.view = 'fill';
      this.open = true;
      this.panel.hidden = false;
      this._placed = false;
      if (this.chip) this.chip.classList.add('on');
      this.render();
      this.reanchor();
      const first = this.panel.querySelector('[data-fill="0"]');
      if (first) setTimeout(() => first.focus(), 50);
    },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * 结果卡片的轻量渲染：只处理最常用的那几种标记，
   * 目的是让带公式的回答可读，不是做完整的 Markdown 引擎。
   *
   * 顺序很关键：先切出公式占位，再转义剩余文本，
   * 最后把公式填回去（公式要单独再转义一次，防止 LaTeX 里的 < > & 破坏结构）。
   */
  function renderMath(text) {
    const src = String(text || '');
    const slots = [];

    // 1) 抽出 $$...$$ 与 $...$，换成占位符
    let s = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
      slots.push({ tex, block: true });
      return '\u0000M' + (slots.length - 1) + '\u0000';
    }).replace(/\$([^$\n]+?)\$/g, (_, tex) => {
      slots.push({ tex, block: false });
      return '\u0000M' + (slots.length - 1) + '\u0000';
    });

    // 2) 转义，防止内容里的标签注入
    s = esc(s);

    // 3) 粗体与标题
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/^#{1,6}\s+(.+)$/gm, '<span class="h">$1</span>');

    // 4) 把公式放回去
    s = s.replace(/\u0000M(\d+)\u0000/g, (_, i) => {
      const it = slots[+i];
      if (!it) return '';
      const t = esc(it.tex);
      return '<span class="' + (it.block ? 'mth-blk' : 'mth') + '">' + t + '</span>';
    });

    return s;
  }

  /** 把记住的高度应用到面板；0 表示恢复默认 */
  function applyPanelHeight(panel, h) {
    if (!panel) return;
    if (!h || h <= 0) {
      panel.style.removeProperty('--panel-max');
      panel.style.maxHeight = '';
      return;
    }
    const vhCap = window.innerHeight * 0.86;
    panel.style.setProperty('--panel-max', Math.min(h, vhCap) + 'px');
    panel.style.maxHeight = Math.min(h, vhCap) + 'px';
  }

  /* ============================ 全局入口 ============================ */

  function bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      // Alt+P 开 / 关
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'p' || e.key === 'P' || e.code === 'KeyP')) {
        e.preventDefault();
        UI.toggle();
        return;
      }
      // Alt+T 直接进任务页签
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 't' || e.key === 'T' || e.code === 'KeyT')) {
        e.preventDefault();
        UI.showTask();
        return;
      }
      // 输入框为空时敲 / 直接唤起
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) {
        if (!Store.data.settings.slashShortcut) return;
        const el = IO.composer();
        if (!el || e.target !== el) return;
        if (IO.value(el).trim() !== '') return;
        if (UI.open) return;
        e.preventDefault();
        UI.show();
      }
    }, true);
  }

  function watchComposer() {
    let tries = 0;
    const tick = () => {
      if (IO.composer()) { UI.reanchor(); return; }
      if (++tries > 120) return;
      setTimeout(tick, 500);
    };
    tick();
  }

  function boot() {
    Store.load();
    Tasks.load();
    UI.mount();
    bindGlobalKeys();
    watchComposer();

    // 之前有任务跑到一半（刷新 / 新建会话整页跳转）→ 接上
    setTimeout(() => {
      if (Runner.resume()) {
        UI.renderTasks();
        toast('已接上未完成的任务');
      }
    }, 1200);

    window.addEventListener('storage', (e) => {
      if (e.key === KEY) {
        Store.load();
        if (UI.open) UI.render();
      } else if (e.key === TASK_KEY) {
        Tasks.load();
        UI.renderTasks();
      }
    });

    // 页面即将卸载（刷新 / 导航）：把现场留在 sessionStorage，记录跑到哪一步。
    // 阶段是极简判断：输入框里还有内容 = 还没发出去；否则视为已发出在等回答。
    window.addEventListener('pagehide', () => {
      if (!Runner.running || !Runner.current) return;
      const el = IO.composer();
      const pending = el ? IO.value(el).trim().length > 0 : false;
      Runner._saveSession(pending ? 'send' : 'wait');
    });

    window.__DSPM__ = {
      alive: true,
      version: '0.3.0',
      IO, Store, Tasks, Runner, UI, Session, PRESETS,
      parse, scan, buildInsert, insertPrompt, insertRaw, presetOf, buildEnvelope,
      /** 自测入口：__DSPM__.probe() 看关键选择器是否都还能命中 */
      probe() {
        return {
          href: IO.href(),
          composer: !!IO.composer(),
          newChat: !!IO.newChatButton(),
          generating: IO.generating(),
          answers: IO.answers().length,
          lastAnswerLen: (IO.lastAnswer() || '').length,
        };
      },
      /** 直接跑一个任务：__DSPM__.run('translate', 'hello') */
      run(presetId, text) { return Runner.start(presetId, text); },
      destroy() {
        try { Session.end(); } catch (_) {}
        try { Runner.stopWatch(); } catch (_) {}
        if (UI.host) UI.host.remove();
        this.alive = false;
      },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
