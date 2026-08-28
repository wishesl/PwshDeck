import ReactDOM from 'react-dom/client'
import App from './App'

// Note: StrictMode is intentionally omitted. It double-mounts effects in dev,
// which would race the pwsh process lifecycle (start/stop/start).
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <App />,
)
