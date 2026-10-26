import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initInstallTracking } from './lib/install';
import { installAudioUnlock } from './lib/sound';
import { registerServiceWorker } from './lib/sw';
import { boot } from './lib/sync';
import { initTheme } from './lib/theme';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/screens.css';

initTheme();
initInstallTracking();
installAudioUnlock();
void registerServiceWorker();
void boot();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
