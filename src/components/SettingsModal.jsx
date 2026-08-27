import { useEffect, useState } from 'react'
import Select from 'react-select'
import ollamaLogo from '../../assets/provider-logos/ollama.svg'
import codexLogo from '../../assets/provider-logos/codex.svg'
import claudeCodeLogo from '../../assets/provider-logos/claude-code.svg'

const selectStyles = { container: base => ({ ...base, width: '100%' }), control: base => ({ ...base, minHeight: 38, background: '#17191c', border: '1px solid #454b51', boxShadow: 'none' }), valueContainer: base => ({ ...base, padding: '0 10px' }), menuPortal: base => ({ ...base, zIndex: 100 }), menu: base => ({ ...base, background: '#24272a', color: '#f3f4f6' }), menuList: base => ({ ...base, background: '#24272a', padding: 4 }), option: (base, state) => ({ ...base, background: state.isFocused ? '#343a3f' : '#24272a', color: '#f3f4f6', cursor: 'pointer' }), singleValue: base => ({ ...base, color: '#edf0f2' }), input: base => ({ ...base, color: '#edf0f2' }), placeholder: base => ({ ...base, color: '#89939a' }) }
const providers = [{ value: 'ollama', label: 'Ollama', description: 'Local HTTP service' }, { value: 'codex', label: 'Codex', description: 'Native CLI with ChatGPT OAuth' }, { value: 'claude', label: 'Claude', description: 'Native CLI with Claude OAuth' }]
const languages = ['English', 'Italian', 'Spanish', 'French', 'German', 'Portuguese', 'Chinese', 'Japanese'].map(language => ({ value: language, label: language }))
const reasoningOptions = [{ value: 'instant', label: 'Instant' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]

function ProviderLogo({ provider }) {
  const logos = { ollama: ollamaLogo, codex: codexLogo, claude: claudeCodeLogo }
  return <img className={`provider-logo provider-logo-${provider}`} src={logos[provider]} alt="" aria-hidden="true" />
}

export default function SettingsModal({ settings, setSettings, models, modelsLoading, loadModels, aiStatus, aiStatusLoading, refreshAiStatus, loginAiProvider, aiError, save, onClose }) {
  const provider = settings.provider || 'ollama'
  const providerDefinition = providers.find(option => option.value === provider) || providers[0]
  const providerSettings = settings.providers?.[provider] || { model: '', reasoning: 'instant', ...(provider === 'ollama' ? { endpoint: 'http://localhost:11434' } : {}) }
  const modelOptions = models.map(model => ({ value: model, label: model }))
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    setConnected(false)
    if (!settings.aiEnabled) return
    if (provider === 'ollama') void connect()
    else { void refreshAiStatus(provider); void loadModels(provider) }
  }, [settings.aiEnabled, provider, providerSettings.endpoint])

  async function connect() {
    const result = await loadModels('ollama', settings.providers?.ollama?.endpoint)
    setConnected(Array.isArray(result))
  }

  function changeProvider(value) {
    setConnected(false)
    setSettings({ ...settings, provider: value })
  }

  function updateProviderSettings(changes) {
    setSettings(value => ({ ...value, providers: { ...value.providers, [provider]: { ...value.providers?.[provider], ...changes } } }))
  }

  const nativeProvider = provider !== 'ollama'
  const statusText = aiStatusLoading
    ? 'Checking client status…'
    : !aiStatus?.installed
      ? `${providerDefinition.label} CLI not found`
      : aiStatus.authenticated
        ? 'Authenticated'
        : 'Not authenticated'
  const providerConnected = aiStatus?.provider === provider && aiStatus.authenticated

  return <div className="modal-backdrop settings-backdrop" onClick={onClose}>
    <div className="settings-modal" onClick={event => event.stopPropagation()}>
      <div className="settings-menu"><p className="eyebrow">SETTINGS</p><button className="settings-menu-item active">General</button></div>
      <section className="settings-body">
        <div className="settings-head"><div><p className="eyebrow">PREFERENCES</p><h2>General</h2></div><button className="console-close-button" onClick={onClose}>×</button></div>
        <label className="settings-toggle-row"><span><strong>Enable AI generation</strong><small>Use the selected provider for commit, stash, release and project assistance.</small></span><button type="button" className={`settings-toggle ${settings.aiEnabled ? 'enabled' : ''}`} role="switch" aria-checked={settings.aiEnabled} onClick={() => setSettings({ ...settings, aiEnabled: !settings.aiEnabled })}><span /></button></label>
        {settings.aiEnabled && <div className="settings-ai-fields">
          <div className="settings-provider-picker"><span className="settings-field-label">Provider</span><div className="settings-provider-pills" role="radiogroup" aria-label="AI provider">{providers.map(option => <button key={option.value} type="button" className={`settings-provider-pill ${provider === option.value ? 'active' : ''}`} role="radio" aria-checked={provider === option.value} onClick={() => changeProvider(option.value)}><ProviderLogo provider={option.value} /><span><strong>{option.label}</strong><small>{option.description}</small></span></button>)}</div></div>
          {nativeProvider ? <>
            <div className={`settings-provider-status ${providerConnected ? 'connected' : ''}`}><div><strong>{providerDefinition.label} client</strong><small>{statusText}. Pulse does not store or handle OAuth tokens.</small></div><div className="settings-provider-actions"><button className={`ghost ${providerConnected ? 'settings-connected' : ''}`} onClick={() => refreshAiStatus(provider)} disabled={aiStatusLoading}>{aiStatusLoading ? 'Checking…' : 'Refresh status'}</button>{!providerConnected && <button className="primary" onClick={loginAiProvider} disabled={!aiStatus?.installed || aiStatusLoading}>Login</button>}</div></div>
            <label>Model<Select className="settings-select" classNamePrefix="project-select" isClearable={false} value={modelOptions.find(option => option.value === providerSettings.model) || (providerSettings.model ? { value: providerSettings.model, label: providerSettings.model } : { value: '', label: 'Client default' })} options={[{ value: '', label: 'Client default' }, ...modelOptions]} placeholder="Select a model" onChange={option => updateProviderSettings({ model: option?.value || '' })} isLoading={modelsLoading} menuPortalTarget={document.body} styles={selectStyles} /></label>
          </> : <>
            <label>Ollama endpoint<div className="settings-endpoint-group"><input value={providerSettings.endpoint || ''} onChange={event => { setConnected(false); updateProviderSettings({ endpoint: event.target.value }) }} /><button className={`ghost ${connected ? 'settings-connected' : ''}`} onClick={connect} disabled={modelsLoading || connected}>{modelsLoading ? 'Connecting…' : connected ? 'Connected' : 'Connect'}</button></div></label>
            <label>Model<Select className="settings-select" classNamePrefix="project-select" isClearable={false} value={modelOptions.find(option => option.value === providerSettings.model) || null} options={modelOptions} placeholder="Select a model" onChange={option => updateProviderSettings({ model: option?.value || '' })} isLoading={modelsLoading} menuPortalTarget={document.body} styles={selectStyles} /></label>
          </>}
          <label>Message language<Select className="settings-select" classNamePrefix="project-select" isClearable={false} value={languages.find(option => option.value === settings.language) || languages[0]} options={languages} onChange={option => setSettings({ ...settings, language: option?.value || 'English' })} menuPortalTarget={document.body} styles={selectStyles} /></label>
          <label>Reasoning<Select className="settings-select" classNamePrefix="project-select" isClearable={false} value={reasoningOptions.find(option => option.value === providerSettings.reasoning) || reasoningOptions[0]} options={reasoningOptions} onChange={option => updateProviderSettings({ reasoning: option?.value || 'instant' })} menuPortalTarget={document.body} styles={selectStyles} /></label>
        </div>}
        {aiError && <p className="modal-error">{aiError}</p>}
        <div className="settings-footer"><button className="ghost" onClick={onClose}>Cancel</button><button className="primary" onClick={save}>Save</button></div>
      </section>
    </div>
  </div>
}
