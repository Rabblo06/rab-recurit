import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './reference-ui.css'
import './shared/motion.css'
import App from './App'
import { initTheme } from './shared/lib/theme'
import { canonicalLoopbackUrl } from './shared/lib/loopback-host'

// Local development only: keep the page on the same loopback alias as the API so the session cookie is same-site
// (see loopback-host.ts). Production builds never include this branch.
const loopbackTarget = import.meta.env.DEV
  ? canonicalLoopbackUrl(window.location.href, import.meta.env.VITE_API_URL ?? 'http://localhost:3000/rest/v1')
  : null

if (loopbackTarget) {
  window.location.replace(loopbackTarget)
} else {
  initTheme()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
