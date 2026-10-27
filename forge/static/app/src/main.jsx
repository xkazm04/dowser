import React from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from './router.jsx';

createRoot(document.getElementById('root')).render(<React.StrictMode><Router /></React.StrictMode>);
