// Must run before App.jsx is evaluated: it installs the Tauri-backed window APIs.
import './tauriBridge.mjs';
import React from 'react';
import { createRoot } from 'react-dom/client';
import 'pretendard/dist/web/variable/pretendardvariable.css';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <App />
);
