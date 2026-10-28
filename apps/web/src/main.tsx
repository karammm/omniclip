import { render } from 'preact';
import { BASE_CSS } from '@omniclip/ui';
import { NATIVE } from './api';
import { App } from './App';
import './styles.css';

// shared design system first, so the app's own styles.css can build on it
const base = document.createElement('style');
base.textContent = BASE_CSS;
document.head.prepend(base);

render(<App />, document.getElementById('app')!);

if (!NATIVE && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // offline support is a nice-to-have
  });
}
