// ==UserScript==
// @name         DeepSeek 提示词增强（DSPM）
// @name:en      DeepSeek Prompt Enhancer
// @namespace    https://github.com/victorymt/deepseek-prompt-enhancer
// @version      0.2.2
// @description  提示词模板管理：{{变量}} 插入输入框，支持默认值、下拉选择、多行、选填；桌面 Tab 跳格，移动端表单填充。
// @description:en  Prompt template manager for DeepSeek: insert {{variables}}, with defaults, dropdowns, multiline and optional fields.
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
 *   UI       —— Shadow DOM 面板
 */

(function () {
  'use strict';

  if (window.__DSPM__ && window.__DSPM__.alive) return;

  /* ============================ 常量 / 工具 ============================ */

  const ZWSP = '\u200B';            // 用来"保护"用户原义花括号，避免被当成空位
  const KEY = 'dspm.v1';
  const SCHEMA = 1;

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
        settings: { braceStyle: 'both', slashShortcut: true, seed: false, panelMax: 0 },
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
      display: flex; align-items: center; justify-content: center;
      flex: none; height: 18px; cursor: grab;
      touch-action: none;                 /* 阻止页面跟着滚动 */
      -webkit-tap-highlight-color: transparent;
    }
    .grab::before {
      content: ''; width: 38px; height: 4px; border-radius: 2px;
      background: var(--line);
      transition: background .15s ease, width .15s ease;
    }
    .grab:hover::before { background: var(--muted); width: 46px; }
    .grab:active { cursor: grabbing; }
    .panel { will-change: transform; }
    .panel.dragging { transition: none; }
    .panel.snap { transition: transform .22s cubic-bezier(.22,.61,.36,1); }

    @media (max-width: 640px) {
      .grab { height: 22px; }
      .panel { max-height: var(--panel-max, 76vh) !important; }
    }
  `;

  const UI = {
    host: null, root: null, shadow: null,
    open: false, view: 'list', editing: null, query: '',

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
      if (!r || r.width < 20) { if (this.chip) this.chip.hidden = true; return; }

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

      const row = this.toolbarRow(this._cachedComposer || (this._cachedComposer = IO.composer()));
      if (row) {
        const last = row.lastElementChild ? row.lastElementChild.getBoundingClientRect() : row.getBoundingClientRect();
        const cw = chip.getBoundingClientRect().width || 78;
        const left = last.right + 10;
        const refH = last.height || 34;
        const top = last.top + refH / 2 - (chip.offsetHeight || 34) / 2;

        const limit = sendRect ? sendRect.left - 6 : window.innerWidth - 8;
        if (left + cw <= limit) {
          const t = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
          if (chip.style.transform !== t) chip.style.transform = t;
          chip.hidden = false;
          return;
        }
        // 放不下：移到工具条左侧的空白处（DeepThink 之前通常有空位）
        const first = row.firstElementChild ? row.firstElementChild.getBoundingClientRect() : null;
        if (first) {
          const left2 = Math.max(8, first.left - cw - 10);
          const t2 = `translate(${Math.round(left2)}px, ${Math.round(top)}px)`;
          if (chip.style.transform !== t2) chip.style.transform = t2;
          chip.hidden = false;
          return;
        }
      }
      // 兜底：贴在输入框右下角（避开发送键）
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

    commitDraftIfNeeded() {
      // 关闭时丢弃未保存草稿，避免误触insert脏数据
      if (this.view === 'edit') this.view = 'list';
    },

    render() {
      const grab = '<div class="grab" data-grab></div>';
      if (this.view === 'fill') {
        this.panel.innerHTML = grab + this.tplFill();
        this.bindDrag();
        return;
      }
      this.panel.innerHTML = grab + (this.view === 'edit' ? this.tplEditor() : this.tplList());
      this.bindDrag();
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

    /* ---------------- 拖拽手柄：下拉关闭 + 调整高度 ---------------- */

    /**
     * 移动端：整块下拉 → 超过阈值收起，否则回弹。
     * 桌面端：下拉 → 缩小 max-height（当作缩放抽屉）；继续往下超过阈值则关闭。
     * 高度会记进 settings.panelMax，下次打开沿用。
     */
    bindDrag() {
      const grab = this.panel.querySelector('[data-grab]');
      if (!grab) return;
      const panel = this.panel;
      const mobile = isMobile();

      let startY = 0, dy = 0, dragging = false, startH = 0, moved = false;

      const minH = 180;
      const maxH = () => Math.min(window.innerHeight * 0.86, 900);

      const down = (e) => {
        dragging = true;
        moved = false;
        startY = (e.touches ? e.touches[0] : e).clientY;
        startH = panel.getBoundingClientRect().height || 300;
        dy = 0;
        panel.classList.add('dragging');
        panel.classList.remove('snap');
      };
      const move = (e) => {
        if (!dragging) return;
        const y = (e.touches ? e.touches[0] : e).clientY;
        dy = y - startY;
        if (Math.abs(dy) > 3) moved = true;

        if (mobile) {
          panel.style.transform = `translateY(${Math.max(0, dy)}px)`;
        } else {
          // 桌面：往下拖缩高度，往上拖撑高
          const h = clamp(startH - dy, minH, maxH());
          panel.style.setProperty('--panel-max', h + 'px');
          panel.style.transform = 'translateY(0px)';
          panel.style.maxHeight = h + 'px';
        }
        if (e.cancelable) e.preventDefault();
      };

      const finish = () => {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('dragging');
        panel.classList.add('snap');

        if (mobile) {
          const h = startH || 300;
          if (dy > Math.min(110, h * 0.28)) {
            panel.style.transform = '';
            setTimeout(() => { panel.classList.remove('snap'); this.hide(); }, 160);
          } else {
            panel.style.transform = '';
            setTimeout(() => panel.classList.remove('snap'), 240);
          }
        } else {
          const h = clamp(startH - dy, minH, maxH());
          panel.style.transform = '';
          if (dy > 0 && h <= minH + 4) {
            // 已缩到最小还继续往下拽 → 关闭（保留原先记住的高度，不覆盖成最小值）
            setTimeout(() => { panel.classList.remove('snap'); this.hide(); }, 120);
          } else {
            // 记录高度
            Store.data.settings.panelMax = Math.round(h);
            Store.save();
            panel.style.maxHeight = h + 'px';
            setTimeout(() => panel.classList.remove('snap'), 240);
            setTimeout(() => this.placePanel(IO.rect(IO.composer())), 240);
          }
        }
        dy = 0;
      };

      grab.addEventListener('pointerdown', (e) => {
        try { grab.setPointerCapture(e.pointerId); } catch (_) {}
        down(e);
      });
      grab.addEventListener('pointermove', move);
      grab.addEventListener('pointerup', finish);
      grab.addEventListener('pointercancel', finish);
      grab.addEventListener('touchstart', down, { passive: false });
      grab.addEventListener('touchmove', move, { passive: false });
      grab.addEventListener('touchend', finish);
      // 双击手柄 → 恢复默认高度
      grab.addEventListener('dblclick', () => {
        Store.data.settings.panelMax = 0;
        Store.save();
        applyPanelHeight(panel, 0);
        this.placePanel(IO.rect(IO.composer()));
      });
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
          <span class="hint">${isMobile() ? '点条目直接填入' : 'Alt+P 开关'}</span>
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
      if (this.view === 'edit' && e.target.matches('[data-f="body"]')) this.updateVarHint();
    },

    onPanelKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); this.hide(); return; }
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

    onClick(e) {
      const act = e.target.closest('[data-act]');
      const item = e.target.closest('.item');
      if (act) {
        const a = act.dataset.act;
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
    UI.mount();
    bindGlobalKeys();
    watchComposer();

    window.addEventListener('storage', (e) => {
      if (e.key !== KEY) return;
      Store.load();
      if (UI.open) UI.render();
    });

    window.__DSPM__ = {
      alive: true,
      version: '0.2.2',
      IO, Store, UI, Session, parse, scan, buildInsert, insertPrompt, insertRaw, presetOf,
      destroy() {
        try { Session.end(); } catch (_) {}
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
