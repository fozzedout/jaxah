/* Read the real shell before placing the report over it. */
if (location.pathname === '/diagnostic') {
  window.addEventListener('load', function () {
    setTimeout(async function () {
      const lines = [];
      const errorName = e => (e && e.name) || 'Error';
      function measure(label, fn) {
        try { lines.push(label + ' ' + fn()); }
        catch (e) { lines.push(label + ' ERR ' + errorName(e)); }
      }
      const name = el => el.tagName + (el.id ? '#' + el.id : '');
      const fullName = el => name(el) + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');
      const style = el => getComputedStyle(el);
      const required = id => { const el = document.getElementById(id); if (!el) throw new Error('missing ' + id); return el; };
      measure('BUNDLE', () => {
        const link = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find(el => /(?:^|\/)shell\.css(?:[?#]|$)/.test(el.getAttribute('href') || ''));
        if (!link) throw new Error('missing stylesheet');
        return 'shell=' + link.getAttribute('href') + ' build=' + required('build-stamp').textContent;
      });
      measure('STANDALONE', () => 'navigator.standalone=' + String(navigator.standalone) + ' display-mode:standalone=' + matchMedia('(display-mode: standalone)').matches);
      measure('VIEWPORT', () => innerWidth + ' x ' + innerHeight + ' dpr=' + devicePixelRatio + ' screen=' + screen.width + ' x ' + screen.height);
      measure('INSET', () => {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top);width:1px';
        document.body.appendChild(probe);
        try { return '--sat=' + JSON.stringify(style(document.documentElement).getPropertyValue('--sat')) + ' env=' + probe.getBoundingClientRect().height + 'px'; }
        finally { probe.remove(); }
      });
      measure('TINT', () => { const el = required('status-tint'), rect = el.getBoundingClientRect(); return 'top=' + rect.top + ' height=' + rect.height + ' background=' + style(el).backgroundColor; });
      measure('STATUSBAR', () => { const el = required('statusbar'), rect = el.getBoundingClientRect(), css = style(el); return 'top=' + rect.top + ' height=' + rect.height + ' background=' + css.backgroundColor + ' backdrop=' + css.backdropFilter + ' webkit=' + css.getPropertyValue('-webkit-backdrop-filter'); });
      measure('ATTOP', () => [4, 10, 20].map(y => { const el = document.elementFromPoint(innerWidth / 2, y); return y + ':' + (el ? fullName(el) + ' bg=' + style(el).backgroundColor : 'NULL'); }).join(' | '));
      measure('STACK', () => { let el = document.elementFromPoint(innerWidth / 2, 10); const stack = []; while (el) { const css = style(el); stack.push(name(el) + ' bg=' + css.backgroundColor + ' z=' + css.zIndex + ' backdrop=' + (css.backdropFilter || css.getPropertyValue('-webkit-backdrop-filter'))); if (el === document.body) break; el = el.parentElement; } return stack.join(' > ') || 'NULL'; });
      measure('GLASSCOUNT', () => { const found = Array.from(document.querySelectorAll('*')).filter(el => { const css = style(el), a = css.backdropFilter, b = css.getPropertyValue('-webkit-backdrop-filter'); return (a && a !== 'none') || (b && b !== 'none'); }); return found.length + (found.length ? ' ' + found.map(name).join(', ') : ''); });
      const report = document.createElement('pre');
      report.style.cssText = 'position:fixed;inset:0;z-index:2147483647;margin:0;padding:max(12px, env(safe-area-inset-top)) 14px max(12px, env(safe-area-inset-bottom));overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#080d10;color:#fff;font:16px/1.45 ui-monospace,monospace;';
      report.textContent = lines.join('\n\n') + '\n\nMETA loading';
      document.body.appendChild(report);
      try {
        const meta = document.querySelector('meta[name="theme-color"]');
        const manifest = document.querySelector('link[rel="manifest"]');
        if (!manifest) throw new Error('missing manifest');
        const response = await fetch(manifest.href, { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        lines.push('META theme-color=' + (meta ? meta.content : 'NULL') + ' manifest background_color=' + data.background_color + ' theme_color=' + data.theme_color);
      } catch (e) { lines.push('META ERR ' + errorName(e)); }
      report.textContent = lines.join('\n\n');
    }, 1500);
  });
}
