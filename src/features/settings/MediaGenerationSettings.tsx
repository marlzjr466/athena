import '../../styles/mediaGeneration.css'
import { useState } from 'react'
import {
  mediaDefaults,
  mediaSettingsSchema,
  isVideoOperation,
  type MediaCatalog,
  type MediaSettings,
  type MediaOptions,
  type MediaOperation,
} from '../../../shared/mediaGeneration'
import { Section, SettingRow, SettingsDisclosure, Toggle } from '../../components/ui/Controls'
import { CustomSelect } from '../../components/ui/CustomSelect'
import { useAthena } from '../../store/athenaStore'
import { desktop } from '../../services/desktop'
import type { InferenceConnection } from '../../../shared/thirdPartyInference'

const modes = {
  auto: 'Auto — Smart Routing',
  selected: 'Prefer Selected Model',
  preferred: 'Prefer Configured Provider',
  'no-charges': 'No Additional API Charges',
  local: 'Local Only',
  manual: 'Manual Selection',
}
const names: Record<string, string> = {
  quality: 'Default quality',
  size: 'Default dimensions',
  format: 'Default output format',
  aspect: 'Default aspect ratio',
  resolution: 'Default resolution',
  duration: 'Default duration',
  count: 'Default image count',
}
const values = {
  quality: ['auto', 'low', 'medium', 'high'],
  size: ['auto', '1024x1024', '1536x1024', '1024x1536'],
  format: ['png', 'jpeg', 'webp'],
  aspect: ['16:9', '9:16', '1:1'],
  resolution: ['480p', '720p', '1080p'],
  duration: Array.from({ length: 15 }, (_, i) => i + 1),
  count: [1, 2, 3, 4],
}
function NumberControl({
  label,
  value,
  min,
  max,
  step = 1,
  save,
}: {
  label: string
  value: number | null
  min: number
  max: number
  step?: number
  save(value: number | null): void
}) {
  return (
    <input
      className="settings-input"
      key={String(value)}
      aria-label={label}
      type="number"
      min={min}
      max={max}
      step={step}
      placeholder="No limit"
      defaultValue={value ?? ''}
      onBlur={(e) => save(e.target.value ? Number(e.target.value) : null)}
    />
  )
}
export function MediaGenerationSettings() {
  const { snapshot, update } = useAthena()
  const settings = snapshot?.settings.mediaGeneration ?? mediaDefaults()
  const [catalog, setCatalog] = useState<MediaCatalog>(),
    [profiles, setProfiles] = useState<InferenceConnection[]>([])
  const [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const [workflowOp, setWorkflowOp] = useState<MediaOperation>('image'),
    [connection, setConnection] = useState(''),
    [protocol, setProtocol] = useState<'images' | 'xai-video'>('images')
  async function save(patch: Partial<MediaSettings>) {
    const current = useAthena.getState().snapshot?.settings.mediaGeneration ?? settings
    const parsed = mediaSettingsSchema.safeParse({ ...current, ...patch })
    if (!parsed.success) {
      setNotice('Check the entered value and try again.')
      return
    }
    try {
      await update({ mediaGeneration: parsed.data })
      setNotice(useAthena.getState().error || 'Media settings saved.')
    } catch {
      setNotice('Could not save media settings. Try again.')
    }
  }
  async function refresh(includedOnly = false) {
    if (busy) return
    setBusy(true)
    try {
      const [result, connections] = await Promise.all([
        desktop.mediaGeneration({ action: 'catalog', includedOnly }),
        desktop.inferenceConnections({ action: 'list' }),
      ])
      if ('routes' in result) setCatalog(result)
      setProfiles(connections.connections)
      setNotice(
        includedOnly
          ? 'Checked verified no-additional-charge routes. No generation was submitted.'
          : 'Provider check finished. Availability is checked again before generation.',
      )
    } catch {
      setNotice('Could not check providers. Previously discovered routes are preserved.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="media-settings">
      <Section
        title="Media generation"
        description="Use the chat input to describe an image or video. Generation uses its own provider without changing your conversation model."
      >
        <SettingRow
          title="Provider availability"
          description="Checks authenticated endpoints and model catalogs without generating media."
        >
          <div className="media-setting-actions">
            <button className="button secondary" disabled={busy} onClick={() => void refresh()}>
              {busy ? 'Checking…' : 'Check generation providers'}
            </button>
            <button className="button secondary" disabled={busy} onClick={() => void refresh(true)}>
              Check no-additional-charge routes
            </button>
          </div>
        </SettingRow>
        {catalog && (
          <div className="media-availability">
            {!catalog.routes.length && (
              <p className="card-description">
                No compatible route found. Connect a generation provider in AI Settings or configure an
                optional local runtime below.
              </p>
            )}
            {catalog.routes.map((r) => (
              <SettingRow
                key={r.id}
                title={`${r.provider} · ${r.model}`}
                description={`${r.native ? 'Native tool' : 'Dedicated endpoint'} · ${r.operations.join(', ')} · ${r.billing === 'api' ? 'Paid API' : r.billing === 'subscription' ? (r.included ? 'Subscription included' : 'Subscription · entitlement checked on request') : r.billing === 'free' ? 'Free tier' : 'Local inference'}`}
              >
                <span className="saved-label">
                  {r.native && !r.included ? 'Confirmation required' : 'Route available'}
                </span>
              </SettingRow>
            ))}
            {!!catalog.accounts?.length && (
              <SettingsDisclosure title="Connected account interfaces">
                {catalog.accounts.map((a, i) => (
                  <SettingRow key={i} title={a.provider} description={a.details}>
                    <span className="saved-label">{a.state}</span>
                  </SettingRow>
                ))}
              </SettingsDisclosure>
            )}
            {!!catalog.notices.length && (
              <SettingsDisclosure title="Unavailable capabilities and setup">
                {catalog.notices.map((n) => (
                  <p className="card-description" key={n}>
                    {n}
                  </p>
                ))}
              </SettingsDisclosure>
            )}
          </div>
        )}
      </Section>
      {(['image', 'video'] as const).map((kind) => {
        const pref = settings[kind],
          label = kind === 'image' ? 'Image' : 'Video'
        const routes =
          catalog?.routes.filter((r) =>
            r.operations.some((op) => isVideoOperation(op) === (kind === 'video')),
          ) ?? []
        const chosen = routes.find((r) => r.id === pref.preferred)
        const eligible = pref.preferred ? (chosen ? [chosen] : []) : routes
        const change = (patch: Partial<typeof pref>) => void save({ [kind]: { ...pref, ...patch } })
        const option = (key: keyof MediaOptions, value: unknown) =>
          change({ defaults: { ...pref.defaults, [key]: value } })
        const connections = [...new Set(routes.map((r) => r.connection))]
        const models = chosen ? routes.filter((r) => r.connection === chosen.connection) : routes
        const controls = [...new Set(eligible.flatMap((r) => r.controls))]
        return (
          <Section key={kind} title={`${label} generation`}>
            <SettingRow title={`Enable ${kind} generation`}>
              <Toggle
                label={`Enable ${kind} generation`}
                checked={pref.enabled}
                onChange={(enabled) => change({ enabled })}
              />
            </SettingRow>
            <SettingRow title="Routing mode">
              <CustomSelect
                ariaLabel={`${label} routing mode`}
                value={pref.mode}
                options={Object.entries(modes).map(([value, label]) => ({
                  value,
                  label,
                }))}
                onChange={(mode) => change({ mode: mode as typeof pref.mode })}
                menuPlacement="auto"
              />
            </SettingRow>
            <SettingRow
              title="Preferred provider"
              description="Accounts and endpoints remain separate. Paid routes require authorization."
            >
              <CustomSelect
                ariaLabel={`${label} preferred provider`}
                value={chosen?.connection ?? (pref.preferred ? 'saved' : '')}
                options={[
                  { value: '', label: 'Automatic' },
                  ...connections.map((value) => ({
                    value,
                    label: routes.find((r) => r.connection === value)!.provider,
                  })),
                  ...(!chosen && pref.preferred
                    ? [
                        {
                          value: 'saved',
                          label: 'Saved provider · check availability',
                        },
                      ]
                    : []),
                ]}
                onChange={(value) => {
                  if (value !== 'saved')
                    change({
                      preferred: routes.find((r) => r.connection === value)?.id ?? '',
                    })
                }}
                menuPlacement="auto"
              />
            </SettingRow>
            <SettingRow title={`Preferred ${kind} model`}>
              <CustomSelect
                ariaLabel={`${label} preferred model`}
                value={pref.preferred}
                options={[
                  { value: '', label: 'Automatic' },
                  ...models.map((r) => ({ value: r.id, label: r.model })),
                  ...(!chosen && pref.preferred
                    ? [
                        {
                          value: pref.preferred,
                          label: 'Saved model · check availability',
                        },
                      ]
                    : []),
                ]}
                onChange={(preferred) => change({ preferred })}
                menuPlacement="auto"
              />
            </SettingRow>
            {!catalog && (
              <p className="card-description">
                Check generation providers to load model-specific defaults. Saved choices remain unchanged.
              </p>
            )}
            {(Object.keys(values) as (keyof typeof values)[])
              .filter((k) => controls.includes(k))
              .map((key) => {
                const supported = values[key].filter((v) =>
                  eligible.some(
                    (r) => r.controls.includes(key) && (!r.values?.[key] || r.values[key]!.includes(v)),
                  ),
                )
                const selected = pref.defaults[key]
                return (
                  <SettingRow key={key} title={names[key]}>
                    <CustomSelect
                      ariaLabel={`${label} ${names[key].toLowerCase()}`}
                      value={selected === undefined ? '' : String(selected)}
                      options={[
                        { value: '', label: 'Provider default' },
                        ...supported.map((v) => ({
                          value: String(v),
                          label: String(v) + (key === 'duration' ? ' seconds' : ''),
                        })),
                        ...(selected !== undefined && !supported.includes(selected as never)
                          ? [
                              {
                                value: String(selected),
                                label: `${selected} · saved, unavailable`,
                              },
                            ]
                          : []),
                      ]}
                      onChange={(v) =>
                        option(
                          key,
                          v === '' ? undefined : ['count', 'duration'].includes(key) ? Number(v) : v,
                        )
                      }
                      menuPlacement="auto"
                    />
                  </SettingRow>
                )
              })}
            {(['transparent', 'audio'] as const)
              .filter((k) => controls.includes(k))
              .map((key) => (
                <SettingRow
                  key={key}
                  title={key === 'transparent' ? 'Transparent background' : 'Generate audio'}
                >
                  <CustomSelect
                    ariaLabel={`${label} ${key}`}
                    value={pref.defaults[key] === undefined ? '' : String(pref.defaults[key])}
                    options={[
                      { value: '', label: 'Provider default' },
                      ...[false, true]
                        .filter((v) =>
                          eligible.some(
                            (r) =>
                              r.controls.includes(key) && (!r.values?.[key] || r.values[key]!.includes(v)),
                          ),
                        )
                        .map((v) => ({
                          value: String(v),
                          label: v ? 'On' : 'Off',
                        })),
                    ]}
                    onChange={(v) => option(key, v === '' ? undefined : v === 'true')}
                    menuPlacement="auto"
                  />
                </SettingRow>
              ))}
            {kind === 'image' && (
              <SettingRow
                title="Progressive previews"
                description="Display intermediate images when the selected endpoint supports them."
              >
                <Toggle
                  label="Progressive image previews"
                  checked={pref.previews}
                  onChange={(previews) => change({ previews })}
                />
              </SettingRow>
            )}
            {kind === 'video' && !controls.includes('format') && (
              <SettingRow
                title="Default output format"
                description="The endpoint returns its supported video format; Athena preserves the original file."
              >
                <span className="saved-label">Provider default</span>
              </SettingRow>
            )}
            {!!Object.keys(pref.defaults).length && (
              <SettingRow
                title="Configured defaults"
                description="Explicit defaults constrain fallback to compatible models."
              >
                <button className="button secondary" onClick={() => change({ defaults: {} })}>
                  Reset to provider defaults
                </button>
              </SettingRow>
            )}
            {routes.length > 1 && (
              <SettingsDisclosure title="Fallback provider priority">
                {[...routes]
                  .sort(
                    (a, b) =>
                      (pref.priority.includes(a.id) ? pref.priority.indexOf(a.id) : 999) -
                      (pref.priority.includes(b.id) ? pref.priority.indexOf(b.id) : 999),
                  )
                  .map((r) => (
                    <SettingRow key={r.id} title={`${r.provider} · ${r.model}`}>
                      <button
                        className="button secondary"
                        onClick={() =>
                          change({
                            priority: [r.id, ...routes.map((o) => o.id).filter((id) => id !== r.id)].slice(
                              0,
                              50,
                            ),
                          })
                        }
                      >
                        Move first
                      </button>
                    </SettingRow>
                  ))}
              </SettingsDisclosure>
            )}
          </Section>
        )
      })}
      <Section title="Usage and billing">
        <SettingRow
          title="Automatic provider fallback"
          description="Fallback follows confirmed rejections. Uncertain requests are preserved to prevent duplicate charges."
        >
          <Toggle
            label="Automatic provider fallback"
            checked={settings.fallback}
            onChange={(fallback) => void save({ fallback })}
          />
        </SettingRow>
        <SettingRow title="Require confirmation before paid generation">
          <Toggle
            label="Require confirmation before paid generation"
            checked={settings.confirmPaid}
            onChange={(confirmPaid) => void save({ confirmPaid })}
          />
        </SettingRow>
        {!settings.confirmPaid &&
          catalog?.routes
            .filter((r) => r.billing === 'api')
            .map((r) => (
              <SettingRow
                key={r.id}
                title={`Authorize ${r.provider} · ${r.model}`}
                description="Allow paid requests within your configured limits."
              >
                <Toggle
                  label={`Authorize ${r.provider} ${r.model}`}
                  checked={settings.paidRoutes.includes(r.id)}
                  onChange={(allow) =>
                    void save({
                      paidRoutes: allow
                        ? [...settings.paidRoutes, r.id]
                        : settings.paidRoutes.filter((id) => id !== r.id),
                    })
                  }
                />
              </SettingRow>
            ))}
        <SettingRow
          title="Maximum paid requests per month"
          description={catalog ? `${catalog.paidRequests} submissions reserved this month.` : undefined}
        >
          <NumberControl
            label="Maximum paid requests per month"
            value={settings.monthlyRequests}
            min={0}
            max={10000}
            save={(v) => void save({ monthlyRequests: v ?? 0 })}
          />
        </SettingRow>
        <SettingRow
          title="Maximum cost per request"
          description="USD. Endpoints without a binding price quote are blocked when a dollar limit is set."
        >
          <NumberControl
            label="Maximum cost per request"
            value={settings.maxCostUSD}
            min={0.01}
            max={10000}
            step={0.01}
            save={(maxCostUSD) => void save({ maxCostUSD })}
          />
        </SettingRow>
        <SettingRow
          title="Monthly spending limit"
          description="USD. Unknown provider charges cannot be safely counted against this limit and prevent new paid submissions."
        >
          <NumberControl
            label="Monthly spending limit"
            value={settings.monthlyCostUSD}
            min={0.01}
            max={100000}
            step={0.01}
            save={(monthlyCostUSD) => void save({ monthlyCostUSD })}
          />
        </SettingRow>
        <SettingsDisclosure title="Usage history">
          {catalog?.history?.length ? (
            catalog.history.map((h) => (
              <p className="card-description" key={h.id}>
                {new Date(h.date).toLocaleString()} · {h.provider} · {h.status}
              </p>
            ))
          ) : (
            <p className="card-description">
              Check generation providers to refresh locally recorded requests.
            </p>
          )}
        </SettingsDisclosure>
      </Section>
      <Section
        title="Local generation"
        description="Optional. No model weights or runtime software are downloaded automatically."
      >
        <SettingRow title="Enable local generation fallback">
          <Toggle
            label="Enable local generation fallback"
            checked={settings.localEnabled}
            onChange={(localEnabled) => void save({ localEnabled })}
          />
        </SettingRow>
        <SettingRow title="Local runtime provider">
          <CustomSelect
            ariaLabel="Local runtime provider"
            value="comfy"
            options={[{ value: 'comfy', label: 'ComfyUI' }]}
          />
        </SettingRow>
        <SettingRow
          title="Endpoint configuration"
          description="Loopback only: http://127.0.0.1 at the configured port."
        >
          <NumberControl
            label="ComfyUI port"
            value={settings.comfyPort}
            min={1024}
            max={65535}
            save={(v) => void save({ comfyPort: v ?? 8188 })}
          />
        </SettingRow>
        <SettingRow
          title="Connection validation"
          description="Checks installed workflow nodes, model files, and device memory."
        >
          <button className="button secondary" disabled={busy} onClick={() => void refresh()}>
            Validate connection
          </button>
        </SettingRow>
        {settings.workflows.map((w, i) => (
          <SettingRow
            key={i}
            title={w.name}
            description={`${w.operation} · ${w.minimumMemoryGB} GiB minimum`}
          >
            <button
              className="button secondary"
              onClick={() =>
                void save({
                  workflows: settings.workflows.filter((_, n) => n !== i),
                })
              }
            >
              Remove workflow
            </button>
          </SettingRow>
        ))}
        <SettingsDisclosure title="Add image or video workflow">
          <p className="card-description">
            Use an API-format workflow with $prompt in the positive text encoder and $image in LoadImage for
            references.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              const d = new FormData(e.currentTarget),
                file = d.get('file')
              if (!(file instanceof File) || file.size > 100000) {
                setNotice('Choose an API workflow JSON file under 100 KB.')
                return
              }
              try {
                const graph = await file.text()
                JSON.parse(graph)
                await save({
                  workflows: [
                    ...settings.workflows,
                    {
                      name: String(d.get('name')),
                      operation: workflowOp,
                      minimumMemoryGB: Number(d.get('memory')),
                      graph,
                    },
                  ],
                })
              } catch {
                setNotice('Choose a valid workflow JSON file.')
              }
            }}
          >
            <SettingRow title="Workflow name">
              <input
                className="settings-input"
                name="name"
                aria-label="Workflow name"
                required
                maxLength={80}
              />
            </SettingRow>
            <SettingRow title="Workflow operation">
              <CustomSelect
                ariaLabel="Workflow operation"
                value={workflowOp}
                options={['image', 'edit-image', 'video', 'animate'].map((value) => ({
                  value,
                  label: value,
                }))}
                onChange={(v) => setWorkflowOp(v as MediaOperation)}
                menuPlacement="auto"
              />
            </SettingRow>
            <SettingRow title="Required device memory (GiB)">
              <input
                className="settings-input"
                name="memory"
                aria-label="Required device memory"
                type="number"
                min=".25"
                step=".25"
                required
              />
            </SettingRow>
            <SettingRow title="Workflow JSON">
              <input
                className="settings-input"
                aria-label="Workflow JSON"
                name="file"
                type="file"
                accept=".json"
                required
              />
            </SettingRow>
            <div className="settings-actions">
              <button className="button secondary" type="submit">
                Add workflow
              </button>
            </div>
          </form>
        </SettingsDisclosure>
        <SettingsDisclosure title="Custom generation endpoints">
          <p className="card-description">
            Use an authorized Third-Party Inference connection implementing the selected media protocol.
            Credentials stay in its existing secure storage.
          </p>
          {settings.custom.map((c, i) => (
            <SettingRow key={i} title={c.model} description={c.protocol}>
              <button
                className="button secondary"
                onClick={() =>
                  void save({
                    custom: settings.custom.filter((_, n) => n !== i),
                  })
                }
              >
                Remove endpoint
              </button>
            </SettingRow>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const d = new FormData(e.currentTarget)
              void save({
                custom: [...settings.custom, { connection, model: String(d.get('model')), protocol }],
              })
            }}
          >
            <SettingRow title="Connection">
              <CustomSelect
                ariaLabel="Custom media connection"
                value={connection}
                options={[
                  { value: '', label: 'Select connection' },
                  ...profiles.filter((p) => p.enabled).map((p) => ({ value: p.id, label: p.name })),
                ]}
                onChange={setConnection}
                menuPlacement="auto"
              />
            </SettingRow>
            <SettingRow title="Model identifier">
              <input
                className="settings-input"
                name="model"
                aria-label="Custom media model"
                required
                maxLength={160}
              />
            </SettingRow>
            <SettingRow title="Protocol">
              <CustomSelect
                ariaLabel="Custom media protocol"
                value={protocol}
                options={[
                  { value: 'images', label: 'OpenAI Images' },
                  { value: 'xai-video', label: 'xAI Video' },
                ]}
                onChange={(v) => setProtocol(v as typeof protocol)}
                menuPlacement="auto"
              />
            </SettingRow>
            <div className="settings-actions">
              <button className="button secondary" type="submit" disabled={!connection}>
                Add endpoint
              </button>
            </div>
          </form>
        </SettingsDisclosure>
      </Section>
      {notice && (
        <p className="card-description" role="status">
          {notice}
        </p>
      )}
    </div>
  )
}
