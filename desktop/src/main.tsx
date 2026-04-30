import React from 'react';
import ReactDOM from 'react-dom/client';

import './fonts';
import { Overlay } from './Overlay';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Overlay />
  </React.StrictMode>,
);
