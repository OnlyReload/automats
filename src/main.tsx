import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installLtrCanvasPatch } from './render/forceLtrCanvas';
import './styles/global.css';

installLtrCanvasPatch();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
