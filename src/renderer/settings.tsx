import { createRoot } from 'react-dom/client'
import { SettingsApp } from './components/SettingsApp.js'

const container = document.getElementById('root')
if (!container) throw new Error('Missing #root element')
createRoot(container).render(<SettingsApp />)
