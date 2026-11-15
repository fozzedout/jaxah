/* Read the real shell before placing the report over it. */
if (location.pathname === '/diagnostic') {
  window.addEventListener('load', function () {
    setTimeout(async function () {
      const lines = [];
      const errorName = e => (e && e.name) || 'Error';
      function measure(label, fn) {
        try { lines.push(label + ' ' + fn()); }
        catch (e) { lines.push(label + ' ERR ' + errorName(e)); home.push('ERR ' + label + ' ' + ((e && e.message) || String(e))); }
      }
      const name = el => el.tagName + (el.id ? '#' + el.id : '');
      const fullName = el => name(el) + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '');
      const style = el => getComputedStyle(el);
      const required = id => { const el = document.getElementById(id); if (!el) throw new Error('missing ' + id); return el; };
      const home = [], sheet = [];
      try {
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
      try {
        const meta = document.querySelector('meta[name="theme-color"]');
        const manifest = document.querySelector('link[rel="manifest"]');
        if (!manifest) throw new Error('missing manifest');
        const response = await fetch(manifest.href, { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        lines.push('META theme-color=' + (meta ? meta.content : 'NULL') + ' manifest background_color=' + data.background_color + ' theme_color=' + data.theme_color);
      } catch (e) { lines.push('META ERR ' + errorName(e)); home.push('ERR META ' + ((e && e.message) || String(e))); }
      const message = e => (e && e.message) || String(e);
      const round = n => Math.round(n * 10) / 10;
      const rectText = r => 'top=' + round(r.top) + ' bottom=' + round(r.bottom) + ' left=' + round(r.left) + ' right=' + round(r.right);
      function insetProbe() {
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top);width:1px';
        document.body.appendChild(probe);
        try { return probe.getBoundingClientRect().height; } finally { probe.remove(); }
      }
      let insetTop;
      try { insetTop = insetProbe(); } catch (e) { home.push('ERR BAND ' + message(e)); }
      function capture(out, isSheet) {
        const take = (label, fn) => { try { out.push(label + ' ' + fn()); } catch (e) { out.push('ERR ' + label + ' ' + message(e)); } };
        take('PHONEMQ', () => '(max-width: 767.98px)=' + matchMedia('(max-width: 767.98px)').matches);
        take('BAND', () => { if (insetTop === undefined) throw new Error('inset unavailable'); return 'insetTop=' + round(insetTop) + ' band=[0,' + round(insetTop + 8) + ')'; });
        take('WHISPER', () => {
          const el = document.querySelector('#whisper, .whisper');
          if (!el) return 'missing';
          const r = el.getBoundingClientRect(), c = style(el);
          const visible = c.display !== 'none' && c.visibility === 'visible' && Number(c.opacity) > 0 && r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0;
          return rectText(r) + ' display=' + c.display + ' visibility=' + c.visibility + ' opacity=' + c.opacity + ' visible=' + (visible ? 'yes' : 'no');
        });
        try {
          let found = 0, top = 0;
          for (const el of document.querySelectorAll('*')) {
            try {
              const c = style(el), values = [c.backdropFilter, c.getPropertyValue('-webkit-backdrop-filter')];
              const backdrop = values.find(v => v && v !== 'none');
              if (!backdrop) continue;
              found++;
              const r = el.getBoundingClientRect(), zero = r.width <= 0 || r.height <= 0;
              const inBand = !zero && insetTop !== undefined && r.top < insetTop + 8 && r.bottom > 0;
              if (inBand) top++;
              let ancestor = el.parentElement;
              while (ancestor && style(ancestor).position === 'static') ancestor = ancestor.parentElement;
              out.push('GLASS ' + fullName(el) + ' ' + rectText(r) + ' bg=' + c.backgroundColor + ' z=' + c.zIndex + ' vis=' + c.visibility + ' backdrop=' + backdrop + ' anchor=' + (ancestor ? name(ancestor) : 'NONE') + ' TOP-BAND ' + (zero ? 'no(zero-size)' : insetTop === undefined ? 'unknown' : inBand ? 'yes' : 'no'));
            } catch (e) { let id = 'element'; try { id = fullName(el); } catch {} out.push('ERR GLASS ' + id + ': ' + message(e)); }
          }
          if (!found) out.push('GLASS none');
          if (insetTop === undefined) out.push('ERR GLASSTOP inset unavailable');
          else out.push('GLASSTOP ' + top);
        } catch (e) { out.push('ERR GLASS ' + message(e)); }
        if (isSheet) {
          for (const [label, selector, missing] of [['TITLE', '.window .w-title', '.w-title'], ['WINDOW', '.window', '.window']]) {
            try {
              const el = document.querySelector(selector);
              if (!el) { out.push('ERR missing ' + missing); continue; }
              const c = style(el);
              out.push(label + ' ' + rectText(el.getBoundingClientRect()) + ' position=' + c.position + ' backgroundColor=' + c.backgroundColor + ' backdrop=' + c.backdropFilter + ' webkit=' + c.getPropertyValue('-webkit-backdrop-filter'));
            } catch (e) { out.push('ERR ' + label + ' ' + message(e)); }
          }
        }
      }
      capture(home, false);
      try {
        const tile = document.querySelector('.tile');
        if (!tile) sheet.push('ERR no .tile');
        else {
          tile.click();
          const deadline = Date.now() + 3000;
          while (!document.querySelector('.window') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
          if (!document.querySelector('.window')) sheet.push('ERR timeout waiting for .window');
          await new Promise(resolve => setTimeout(resolve, 700));
        }
      } catch (e) { sheet.push('ERR opening .tile: ' + message(e)); }
      capture(sheet, true);
      } catch (e) { sheet.push('ERR ' + ((e && e.message) || String(e))); }
      finally {
        const report = document.createElement('pre');
        report.style.cssText = 'position:fixed;inset:0;z-index:2147483647;margin:0;padding:max(12px, env(safe-area-inset-top)) 14px max(12px, env(safe-area-inset-bottom));overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#080d10;color:#fff;font:16px/1.45 ui-monospace,monospace;';
        const text = lines.concat('== HOME ==', home, '== SHEET ==', sheet).flat().join('\n\n');
        const bytes = new TextEncoder().encode(text);
        const truncated = bytes.length > 65536;
        const payload = truncated ? new TextDecoder().decode(bytes.slice(0, 65536), { stream: true }) : text;
        const suffix = truncated ? ' truncated' : '';
        let sendLine = 'SEND pending' + suffix;
        report.textContent = text + '\n\n' + sendLine;
        document.body.appendChild(report);
        function failed(e) {
          sendLine = 'SEND failed ' + ((e && (e.message || e.name)) || String(e)) + suffix;
          report.textContent = text + '\n\n' + sendLine;
        }
        try {
          fetch('/api/tape?source=jaxah-diagnostic', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: payload })
            .then(res => { sendLine = 'SEND ' + (res.ok ? 'ok ' : 'failed ') + res.status + suffix; report.textContent = text + '\n\n' + sendLine; })
            .catch(failed);
        } catch (e) { failed(e); }
      }
    }, 1500);
  });
}
