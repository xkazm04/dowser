import React from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { Router } from './router.jsx';
import './components/theme.css';
import './components/brand.css';
import { variantId } from './variants/index.js';

// Jira's light/dark theme: the host loads the design tokens (`--ds-*`) and sets the colour mode on <html>.
// A failure only costs the theme (theme.css falls back to the light token values), so it is not fatal.
view.theme.enable().catch(() => {});

// Visual prototypes (dev server only): the variant id scopes its CSS, and the switcher floats bottom right.
if (import.meta.env.DEV) {
  document.documentElement.setAttribute('data-variant', String(variantId()));
  import('./variants/VariantSwitch.jsx').then(({ VariantSwitch }) => {
    createRoot(document.body.appendChild(document.createElement('div'))).render(<VariantSwitch />);
  });
}

createRoot(document.getElementById('root')).render(<React.StrictMode><Router /></React.StrictMode>);
