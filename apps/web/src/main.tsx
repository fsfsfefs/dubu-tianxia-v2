import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';

if (navigator.userAgent.includes('DubuTablet/')) {
  document.documentElement.dataset.platform = 'android';
  void import('./android-tablet.css');
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
