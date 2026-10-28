import React from 'react';
import { createRoot } from 'react-dom/client';
import { view } from '@forge/bridge';
import { Router } from './router.jsx';
import './components/theme.css';
import './components/brand.css';
import './components/reading.css';

// Jira's light/dark theme: the host loads the design tokens (`--ds-*`) and sets the colour mode on <html>.
// A failure only costs the theme (theme.css falls back to the light token values), so it is not fatal.
view.theme.enable().catch(() => {});

createRoot(document.getElementById('root')).render(<React.StrictMode><Router /></React.StrictMode>);
