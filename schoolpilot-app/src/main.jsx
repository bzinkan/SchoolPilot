import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { installRuntimeTelemetry, RuntimeErrorBoundary } from './lib/runtimeTelemetry.js'

installRuntimeTelemetry()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <RuntimeErrorBoundary>
      <App />
    </RuntimeErrorBoundary>
  </StrictMode>,
)
