// Dev-only floating switcher between the visual prototypes and between light and dark. Rendered by main.jsx only
// under import.meta.env.DEV. Changing the hash reloads the page (both dev bridges reload on hashchange).
import React from 'react';
import { VARIANTS, variantId } from './index.js';
import './switch.css';

function setHashParam(key, value) {
  const hash = location.hash.slice(1) || 'inbox';
  const [surface, ...rest] = hash.split('&');
  const kept = rest.filter((p) => !p.startsWith(`${key}=`) && p !== key);
  if (value !== undefined) kept.push(`${key}=${value}`);
  location.hash = [surface, ...kept].join('&');
}

export function VariantSwitch() {
  const current = variantId();
  const mode = document.documentElement.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light';
  return (
    <div className="dwv-switch" role="group" aria-label="Prototype variant (dev only)">
      {VARIANTS.map((v) => (
        <button
          key={v.id} type="button" className="dwv-switch__btn" aria-pressed={v.id === current}
          onClick={() => setHashParam('v', v.id === 0 ? undefined : v.id)}
        >
          <span className="dwv-switch__n">{v.id}</span>{v.label}
        </button>
      ))}
      <button
        type="button" className="dwv-switch__btn"
        onClick={() => setHashParam('mode', mode === 'dark' ? 'light' : 'dark')}
      >
        {mode === 'dark' ? 'Light' : 'Dark'}
      </button>
    </div>
  );
}
