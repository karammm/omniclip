import { render } from 'preact';
import { NATIVE } from './api';
import { App } from './App';
import './styles.css';

render(<App />, document.getElementById('app')!);

if (!NATIVE && 'serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // offline support is a nice-to-have
  });
}
