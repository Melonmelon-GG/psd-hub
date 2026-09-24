import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';

import './styles/tokens.css';
import './styles/global.css';
import './styles/components.css';
import './styles/pages.css';

/** 应用入口 */
const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载节点，请检查 index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
