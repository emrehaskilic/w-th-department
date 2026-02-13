import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import Dashboard from './components/Dashboard';
import ConfigurationError from './components/ConfigurationError';
import { isProxyApiKeyConfigured } from './services/proxyAuth';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isProxyApiKeyConfigured() ? (
      <Dashboard />
    ) : (
      <ConfigurationError message="VITE_PROXY_API_KEY ortam degiskeni eksik. Lutfen .env.local dosyasini kontrol edin." />
    )}
  </React.StrictMode>
);
