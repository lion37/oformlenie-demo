/* dc-lite — минимальный рендерер макетов (шаблон {{…}}, sc-if, sc-for, onX, ref)
   для статической демо-версии сайта. Обновление DOM — бережное (morph), чтобы
   не сбивать фокус ввода и CSS-анимации. */
(function () {
  'use strict';
  const EXPR = /\{\{([\s\S]+?)\}\}/g;
  const fnCache = new Map();

  function evaluate(expr, scope) {
    let fn = fnCache.get(expr);
    if (!fn) {
      try {
        // eslint-disable-next-line no-new-func
        fn = new Function('__s', 'with (__s) { return (' + expr + '); }');
      } catch (e) {
        console.warn('dc-lite: не удалось разобрать выражение', expr);
        fn = () => undefined;
      }
      fnCache.set(expr, fn);
    }
    try { return fn(scope); } catch (e) { return undefined; }
  }

  function interpolate(str, scope) {
    // всё значение — одно выражение (без других {{ }} внутри)
    const whole = str.match(/^\s*\{\{((?:(?!\}\}|\{\{)[\s\S])+)\}\}\s*$/);
    if (whole) return evaluate(whole[1], scope);
    return str.replace(EXPR, (_, e) => {
      const v = evaluate(e, scope);
      return v == null || v === false ? '' : String(v);
    });
  }

  const EVENT_MAP = { onclick: 'click', oninput: 'input', onfocus: 'focus', onblur: 'blur', onkeydown: 'keydown',
    onkeyup: 'keyup', onsubmit: 'submit', onmouseenter: 'mouseenter', onmouseleave: 'mouseleave' };
  const BOOL_PROPS = ['checked', 'disabled', 'readonly', 'selected', 'hidden', 'required'];

  function eventName(attr, el) {
    const a = attr.toLowerCase();
    if (a === 'onchange') {
      const t = (el.getAttribute('type') || '').toLowerCase();
      return (el.tagName === 'INPUT' && !['checkbox', 'radio', 'file'].includes(t)) || el.tagName === 'TEXTAREA' ? 'input' : 'change';
    }
    return EVENT_MAP[a] || a.slice(2);
  }

  // Шаблон → живое дерево (без обработчиков: они хранятся в el.__on)
  function build(node, scope, refs) {
    if (node.nodeType === 3) {
      const t = node.nodeValue;
      return [document.createTextNode(t.indexOf('{{') >= 0 ? interpolate(t, scope) ?? '' : t)];
    }
    if (node.nodeType !== 1) return [];
    const tag = node.tagName.toLowerCase();
    if (tag === 'sc-if') {
      const v = interpolate(node.getAttribute('value') || '', scope);
      return v ? buildChildren(node, scope, refs) : [];
    }
    if (tag === 'sc-for') {
      const list = interpolate(node.getAttribute('list') || '', scope) || [];
      const as = node.getAttribute('as') || 'item';
      const out = [];
      list.forEach((item, i) => {
        const sub = Object.create(scope);
        sub[as] = item;
        sub.$index = i;
        out.push(...buildChildren(node, sub, refs));
      });
      return out;
    }
    const isSvg = node.namespaceURI === 'http://www.w3.org/2000/svg';
    const el = isSvg ? document.createElementNS(node.namespaceURI, node.tagName) : document.createElement(node.tagName);
    el.__on = {};
    for (const a of Array.from(node.attributes)) {
      const name = a.name;
      if (name.startsWith('hint-')) continue;
      const raw = a.value;
      const dyn = raw.indexOf('{{') >= 0;
      const val = dyn ? interpolate(raw, scope) : raw;
      if (/^on[a-z]/i.test(name)) {
        if (typeof val === 'function') el.__on[eventName(name, el)] = val;
        continue;
      }
      if (name === 'ref') { if (typeof val === 'function') refs.push([val, el]); continue; }
      if (BOOL_PROPS.includes(name.toLowerCase())) {
        if (val === false || val === 'false' || val == null) continue;
        el.setAttribute(name, '');
        continue;
      }
      if (name === 'value' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.__value = val == null ? '' : String(val);
      }
      if (val == null || val === false) continue;
      el.setAttribute(name, val === true ? '' : String(val));
    }
    for (const c of buildChildren(node.content || node, scope, refs)) el.appendChild(c);
    return [el];
  }

  function buildChildren(node, scope, refs) {
    const out = [];
    for (const c of Array.from(node.childNodes)) out.push(...build(c, scope, refs));
    return out;
  }

  // Один слушатель на тип события; актуальный обработчик берётся из el.__on
  function syncHandlers(el, on) {
    el.__on = on || {};
    el.__bound = el.__bound || {};
    for (const type of Object.keys(el.__on)) {
      if (!el.__bound[type]) {
        el.__bound[type] = true;
        el.addEventListener(type, (e) => { const h = el.__on[type]; if (h) h(e); });
      }
    }
  }

  function morphAttrs(from, to) {
    for (const a of Array.from(from.attributes)) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
    for (const a of Array.from(to.attributes)) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
    if (to.__value !== undefined && from.value !== to.__value && document.activeElement !== from) from.value = to.__value;
    if (from.tagName === 'INPUT' && (from.type === 'checkbox' || from.type === 'radio')) from.checked = to.hasAttribute('checked');
    syncHandlers(from, to.__on);
  }

  function morph(parent, newKids) {
    const old = Array.from(parent.childNodes);
    let i = 0;
    for (; i < newKids.length; i++) {
      const n = newKids[i];
      const o = old[i];
      if (!o) { prepare(n); parent.appendChild(n); continue; }
      if (o.nodeType === n.nodeType && (o.nodeType === 3 || o.tagName === n.tagName)) {
        if (o.nodeType === 3) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; continue; }
        n.__live = o;               // для ref: живой узел вместо построенного
        morphAttrs(o, n);
        morph(o, Array.from(n.childNodes));
      } else {
        prepare(n);
        parent.replaceChild(n, o);
      }
    }
    for (let j = old.length - 1; j >= i; j--) parent.removeChild(old[j]);
  }

  function prepare(el) {
    if (el.nodeType !== 1) return;
    syncHandlers(el, el.__on);
    if (el.__value !== undefined) el.value = el.__value;
    for (const c of Array.from(el.children)) prepare(c);
  }

  class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(patch, cb) {
      const p = typeof patch === 'function' ? patch(this.state, this.props) : patch;
      this.state = Object.assign({}, this.state, p);
      this.__schedule && this.__schedule();
      if (cb) setTimeout(cb, 0);
    }
  }
  window.DCLogic = DCLogic;

  window.dcMount = function (Component, tpl, root) {
    const comp = new Component({});
    let queued = false;
    const render = () => {
      queued = false;
      const refs = [];
      const scope = comp.renderVals ? comp.renderVals() || {} : {};
      const kids = buildChildren(tpl.content, scope, refs);
      morph(root, kids);
      for (const [fn, el] of refs) {
        // ref указывает на только что построенный узел; после morph живой узел — тот, что в DOM
        fn(el.__live || el);
      }
    };
    comp.__schedule = () => { if (!queued) { queued = true; Promise.resolve().then(render); } };
    render();
    if (comp.componentDidMount) comp.componentDidMount();
    window.addEventListener('pagehide', () => comp.componentWillUnmount && comp.componentWillUnmount());
    return comp;
  };
})();
