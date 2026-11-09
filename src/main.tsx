import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import './styles/global.css'
import './styles/ui-overrides.css'


document.documentElement.dataset.surface = new URLSearchParams(window.location.search).get('surface') ?? 'control'
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
