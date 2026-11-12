/**
 * The script the browser agent runs inside a page (in a hidden WebView on the phone or the PC).
 * It lists what can be used on the page — links, buttons and fields, each with a number — and
 * clicks, types or scrolls by that number. It never types into password or card fields, and it
 * marks elements that look like paying, ordering, sending or deleting as risky, so Carino asks
 * the user first.
 */
export const PAGE_AGENT = String.raw`(function () {
  if (window.__carinoAgent) return;
  var RISKY = /\b(pay|buy|purchase|order|checkout|check out|place order|book now|confirm|subscribe|send|submit|delete|remove|transfer|donate|sign up|register)\b/i;
  var SECRET = /(password|passcode|pin|cvv|cvc|card.?number|cc-number|cc-csc|security code|iban|ssn)/i;
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }
  function label(el) {
    var t = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.name || '').replace(/\s+/g, ' ').trim();
    if (!t && el.id) { var l = document.querySelector('label[for="' + el.id + '"]'); if (l) t = l.innerText.trim(); }
    return t.slice(0, 80);
  }
  function secret(el) {
    var hint = [el.type, el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), el.getAttribute('aria-label')].join(' ');
    return el.type === 'password' || SECRET.test(hint);
  }
  var items = [];
  window.__carinoAgent = {
    snapshot: function () {
      items = [];
      var els = document.querySelectorAll('a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [contenteditable=true]');
      var out = [];
      for (var i = 0; i < els.length && out.length < 150; i++) {
        var el = els[i];
        if (!visible(el) || el.disabled) continue;
        var tag = el.tagName.toLowerCase();
        var kind = tag === 'a' ? 'link' : tag === 'select' ? 'select' : (tag === 'input' || tag === 'textarea' || el.isContentEditable) && !/^(button|submit|checkbox|radio)$/.test(el.type) ? 'field' : el.type === 'checkbox' || el.getAttribute('role') === 'checkbox' ? 'checkbox' : 'button';
        var name = label(el);
        if (!name && kind !== 'field') continue;
        items.push(el);
        var row = { n: items.length, kind: kind, label: name };
        if (kind === 'field') { row.value = secret(el) ? '(hidden)' : String(el.value || '').slice(0, 60); if (secret(el)) row.secret = true; }
        if (kind === 'select') row.options = Array.prototype.slice.call(el.options, 0, 20).map(function (o) { return o.text.trim(); });
        if (kind !== 'field' && (RISKY.test(name) || el.type === 'submit')) row.risky = true;
        if (tag === 'a') row.href = String(el.href).slice(0, 200);
        out.push(row);
      }
      var text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, 12000);
      return JSON.stringify({ url: location.href, title: document.title, text: text, elements: out });
    },
    act: function (n, op, value, allowRisky) {
      var el = items[n - 1];
      if (!el || !document.contains(el)) return JSON.stringify({ error: 'That item is gone; look at the page again.' });
      if (op === 'type' || op === 'select') {
        if (secret(el)) return JSON.stringify({ error: 'Carino never types passwords, PINs or card details. Ask the user to do that part.' });
        el.focus();
        if (op === 'select') {
          var opt = Array.prototype.find.call(el.options, function (o) { return o.text.trim().toLowerCase() === String(value).toLowerCase() || o.value === value; });
          if (!opt) return JSON.stringify({ error: 'No such option.' });
          el.value = opt.value;
        } else if (el.isContentEditable) { el.innerText = value; }
        else {
          var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
          if (setter && setter.set) setter.set.call(el, value); else el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ ok: true });
      }
      if (op === 'click') {
        var name = label(el);
        if (!allowRisky && (RISKY.test(name) || el.type === 'submit')) return JSON.stringify({ needs_confirmation: true, label: name });
        el.scrollIntoView({ block: 'center' });
        el.click();
        return JSON.stringify({ ok: true, clicked: name });
      }
      return JSON.stringify({ error: 'Unknown action' });
    },
    scroll: function (dir) { window.scrollBy(0, (dir === 'up' ? -1 : 1) * window.innerHeight * 0.8); return JSON.stringify({ ok: true }); },
  };
})();`;
