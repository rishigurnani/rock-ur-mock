import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Ask Chrome to mark our storage PERSISTENT so it's exempt from automatic
// eviction under disk pressure (best-effort — granted by browser heuristics; the
// Backup-all file remains the real guarantee).
void navigator.storage?.persist?.();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
