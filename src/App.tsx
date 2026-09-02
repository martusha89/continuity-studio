import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import './App.css'
import { postJson } from './api'
import { initialDraft, type PersonaDraft, type StudioStep } from './domain'
import { completionForStep, generateLettaPreview, personaReadiness } from './generate'
import {
  columnsFor,
  inferMappings,
  parseSourceDump,
  renderHistory,
  type SourceDump,
  type TableMapping,
} from './history'
import {
  MAX_HISTORY_CONTENT_BYTES,
  MAX_HISTORY_FILE_BYTES,
  MAX_HISTORY_FILES,
  MAX_HISTORY_SOURCE_BYTES,
  utf8Bytes,
} from './history-contract'
import {
  applyMemoryEdits,
  clearMemoryValueEdit,
  hasMemoryValueEdit,
  memoryIsReady,
  memoryLabelForField,
  memoryPath,
  renderMemoryBundle,
  type MemoryEdits,
} from './memory-review'

const steps: Array<{ id: StudioStep; eyebrow: string; label: string }> = [
  { id: 'ai', eyebrow: '01', label: 'Their memory' },
  { id: 'human', eyebrow: '02', label: 'Your memory' },
  { id: 'relationship', eyebrow: '03', label: 'How you work' },
  { id: 'review', eyebrow: '04', label: 'Review files' },
  { id: 'connect', eyebrow: '05', label: 'Create' },
  { id: 'history', eyebrow: '06', label: 'Add history' },
]

type FieldProps = {
  label: string
  hint: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  compact?: boolean
}

function Field({ label, hint, value, onChange, placeholder, compact }: FieldProps) {
  return (
    <label className="field">
      <span className="field-heading">{label}</span>
      <span className="field-hint">{hint}</span>
      {compact ? (
        <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      ) : (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={4}
        />
      )}
    </label>
  )
}

function App() {
  const operationGeneration = useRef(0)
  const operationLock = useRef(false)
  const historyInputGeneration = useRef(0)
  const creationAttempt = useRef<{ fingerprint: string; operationId: string; attempted: boolean } | null>(null)
  const historyStartAttempt = useRef<{ fingerprint: string; attempted: boolean } | null>(null)
  const [draft, setDraft] = useState<PersonaDraft>(initialDraft)
  const [memoryEdits, setMemoryEdits] = useState<MemoryEdits>({})
  const [reviewedLabel, setReviewedLabel] = useState('persona')
  const [step, setStep] = useState<StudioStep>('ai')
  const [studioStarted, setStudioStarted] = useState(false)
  const [copied, setCopied] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [connection, setConnection] = useState<'idle' | 'checking' | 'connected' | 'error'>('idle')
  const [connectionMessage, setConnectionMessage] = useState('')
  const [creation, setCreation] = useState<'idle' | 'creating' | 'created' | 'error'>('idle')
  const [createdAgentId, setCreatedAgentId] = useState('')
  const [createdAgentName, setCreatedAgentName] = useState('')
  const [existingAgentId, setExistingAgentId] = useState('')
  const [creationOrigin, setCreationOrigin] = useState<'new' | 'existing' | ''>('')
  const [createdPayload, setCreatedPayload] = useState('')
  const [creationMessage, setCreationMessage] = useState('')
  const [historyText, setHistoryText] = useState('')
  const [historyDump, setHistoryDump] = useState<SourceDump | null>(null)
  const [historyMappings, setHistoryMappings] = useState<TableMapping[]>([])
  const [historyError, setHistoryError] = useState('')
  const [sourceSlug, setSourceSlug] = useState('existing-memory')
  const [includePrivate, setIncludePrivate] = useState(false)
  const [confirmNoPrivacyRule, setConfirmNoPrivacyRule] = useState(false)
  const [timezonePolicy, setTimezonePolicy] = useState<'preserve' | 'utc'>('preserve')
  const [repositoryName, setRepositoryName] = useState('continuity-existing-memory')
  const [historyImport, setHistoryImport] = useState<'idle' | 'importing' | 'imported' | 'error'>('idle')
  const [historyImportMessage, setHistoryImportMessage] = useState('')
  const [completedImport, setCompletedImport] = useState<null | {
    agentId: string
    agentName: string
    repositoryId: string
    repositoryName: string
    manifestSha256: string
    fileCount: number
  }>(null)
  const generatedPreview = useMemo(() => generateLettaPreview(draft), [draft])
  const preview = useMemo(() => applyMemoryEdits(generatedPreview, memoryEdits), [generatedPreview, memoryEdits])
  const historyPreview = useMemo(
    () => historyDump ? renderHistory(historyDump, historyMappings, { sourceSlug, includePrivate, timezonePolicy }) : null,
    [historyDump, historyMappings, sourceSlug, includePrivate, timezonePolicy],
  )
  const readiness = useMemo(() => personaReadiness(draft), [draft])
  const reviewedMemoryReady = preview.memory.every(memoryIsReady)
  const previewJson = useMemo(() => JSON.stringify(preview), [preview])
  const draftChangedAfterCreation = creation === 'created' && creationOrigin === 'new' && createdPayload !== previewJson
  const usingExistingAgent = creation === 'created' && creationOrigin === 'existing'
  const enabledWithoutPrivacyRule = historyMappings.filter((mapping) => mapping.enabled && !mapping.privacyColumn).length
  const renderedImportBytes = historyPreview?.files.reduce((total, file) => total + utf8Bytes(file.content), 0) ?? 0
  const oversizedRenderedFiles = historyPreview?.files.filter((file) => utf8Bytes(file.content) > MAX_HISTORY_FILE_BYTES).length ?? 0
  const currentIndex = steps.findIndex((item) => item.id === step)
  const operationActive = connection === 'checking' || creation === 'creating' || historyImport === 'importing'

  const enterStudio = () => {
    setStudioStarted(true)
    window.requestAnimationFrame(() => document.getElementById('studio')?.scrollIntoView({ block: 'start' }))
  }

  const showIntroduction = () => {
    setStudioStarted(false)
    window.requestAnimationFrame(() => document.getElementById('top')?.scrollIntoView({ block: 'start' }))
  }

  const beginOperation = () => {
    if (operationLock.current) return null
    operationLock.current = true
    operationGeneration.current += 1
    return operationGeneration.current
  }

  const isCurrentOperation = (generation: number) => operationGeneration.current === generation

  const endOperation = (generation: number) => {
    if (isCurrentOperation(generation)) operationLock.current = false
  }

  const setField = (field: keyof PersonaDraft, value: string) => {
    const label = memoryLabelForField(field)
    if (hasMemoryValueEdit(memoryEdits, label)) {
      const confirmed = window.confirm(
        `Changing this answer will regenerate ${memoryPath(label)} and replace its direct content edits. Continue?`,
      )
      if (!confirmed) return
      setMemoryEdits((current) => clearMemoryValueEdit(current, label))
    }
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const editMemory = (label: string, patch: MemoryEdits[string]) =>
    setMemoryEdits((current) => ({
      ...current,
      [label]: { ...current[label], ...patch },
    }))

  const move = (direction: -1 | 1) => {
    if (operationActive) return
    const destination = steps[currentIndex + direction]
    if (destination) setStep(destination.id)
  }

  const copyPreview = async () => {
    await navigator.clipboard.writeText(renderMemoryBundle(preview.memory))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }

  const selectMemoryTab = (label: string, focus = false) => {
    setReviewedLabel(label)
    if (focus) window.requestAnimationFrame(() => document.getElementById(`memory-tab-${label}`)?.focus())
  }

  const handleMemoryTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let destination = index
    if (event.key === 'ArrowRight') destination = (index + 1) % preview.memory.length
    else if (event.key === 'ArrowLeft') destination = (index - 1 + preview.memory.length) % preview.memory.length
    else if (event.key === 'Home') destination = 0
    else if (event.key === 'End') destination = preview.memory.length - 1
    else return

    event.preventDefault()
    selectMemoryTab(preview.memory[destination].label, true)
  }

  const invalidateHistoryImport = () => {
    if (historyImport === 'importing') return
    setHistoryImport('idle')
    setHistoryImportMessage('')
    setCompletedImport(null)
  }

  const credentialChanged = (value: string) => {
    if (operationActive || operationLock.current) return
    operationGeneration.current += 1
    creationAttempt.current = null
    setApiKey(value)
    setConnection('idle')
    setConnectionMessage('')
    setCreation('idle')
    setCreationOrigin('')
    setCreatedAgentId('')
    setCreatedAgentName('')
    setExistingAgentId('')
    setCreatedPayload('')
    setCreationMessage('')
    setHistoryImport('idle')
    setHistoryImportMessage('')
    setCompletedImport(null)
  }

  const verifyLetta = async () => {
    if (!apiKey.trim() || operationLock.current) return
    const generation = beginOperation()
    if (generation === null) return
    const credential = apiKey
    setConnection('checking')
    setConnectionMessage('')
    try {
      await postJson<{ ok: boolean }>('/api/letta/verify', credential, {}, 'Key verification')
      if (!isCurrentOperation(generation)) return
      setConnection('connected')
      setConnectionMessage('Letta accepted the key. Continuity Studio passed it through this server for verification and did not store it.')
    } catch (error) {
      if (!isCurrentOperation(generation)) return
      setConnection('error')
      setConnectionMessage(error instanceof Error ? error.message : 'Connection failed.')
    } finally {
      endOperation(generation)
    }
  }

  const createAgent = async () => {
    if (operationActive || operationLock.current) return
    const generation = beginOperation()
    if (generation === null) return
    const credential = apiKey
    const reviewedPreview = preview
    const reviewedPreviewJson = previewJson
    const fingerprint = `${credential}\0${reviewedPreviewJson}`
    if (creationAttempt.current?.fingerprint !== fingerprint) {
      creationAttempt.current = { fingerprint, operationId: crypto.randomUUID(), attempted: false }
    }
    const operationId = creationAttempt.current.operationId
    const allowCreate = !creationAttempt.current.attempted
    creationAttempt.current.attempted = true
    setCreation('creating')
    setCreatedAgentId('')
    setCreationMessage('Creating the agent in Letta…')
    try {
      const result = await postJson<{ agentId?: string }>('/api/provision', credential, {
        ...reviewedPreview,
        operationId,
        allowCreate,
      }, 'Agent creation')
      if (!isCurrentOperation(generation)) return
      if (!result.agentId) throw new Error('Continuity Studio did not receive the created agent ID.')
      setCreatedAgentId(result.agentId)
      setCreatedAgentName(reviewedPreview.name)
      setCreation('created')
      setCreationOrigin('new')
      setCreatedPayload(reviewedPreviewJson)
      setCreationMessage(`Created successfully: ${result.agentId}`)
    } catch (error) {
      if (!isCurrentOperation(generation)) return
      setCreation('error')
      setCreationMessage(`${error instanceof Error ? error.message : 'Agent creation failed.'} If the request may have reached Letta, inspect your agents before retrying.`)
    } finally {
      endOperation(generation)
    }
  }

  const inspectHistory = (text: string, inputGeneration?: number) => {
    if (historyImport === 'importing') return
    if (inputGeneration === undefined) historyInputGeneration.current += 1
    else if (historyInputGeneration.current !== inputGeneration) return
    setCompletedImport(null)
    if (utf8Bytes(text) > MAX_HISTORY_SOURCE_BYTES) {
      setHistoryError('That export is larger than 20 MiB. Split it into smaller reviewed exports before importing.')
      return
    }
    setHistoryError('')
    setHistoryImport('idle')
    setHistoryImportMessage('')
    try {
      const dump = parseSourceDump(JSON.parse(text))
      setHistoryDump(dump)
      setHistoryMappings(inferMappings(dump))
    } catch (error) {
      setHistoryDump(null)
      setHistoryMappings([])
      setHistoryError(error instanceof Error ? error.message : 'The dump could not be inspected.')
    }
  }

  const readHistoryFile = async (file: File | undefined) => {
    if (!file) return
    if (historyImport === 'importing') return
    const inputGeneration = ++historyInputGeneration.current
    setCompletedImport(null)
    setHistoryImport('idle')
    setHistoryImportMessage('')
    if (file.size > MAX_HISTORY_SOURCE_BYTES) {
      setHistoryError('That export is larger than 20 MiB. Split it into smaller reviewed exports before importing.')
      return
    }
    const text = await file.text()
    if (historyInputGeneration.current !== inputGeneration) return
    setHistoryText(text)
    inspectHistory(text, inputGeneration)
  }

  const updateMapping = (table: string, patch: Partial<TableMapping>) => {
    if (historyImport === 'importing') return
    invalidateHistoryImport()
    setHistoryMappings((current) => current.map((mapping) =>
      mapping.table === table ? { ...mapping, ...patch } : mapping,
    ))
    setConfirmNoPrivacyRule(false)
  }

  const importExistingHistory = async () => {
    if (!historyPreview || creation !== 'created' || !createdAgentId || !createdAgentName || operationActive || operationLock.current) return
    const generation = beginOperation()
    if (generation === null) return
    const operation = {
      credential: apiKey,
      agentId: createdAgentId,
      agentName: createdAgentName,
      repositoryName: repositoryName.trim(),
      files: historyPreview.files.map((file) => ({ ...file })),
    }
    let activeRepositoryId = ''
    setHistoryImport('importing')
    setHistoryImportMessage(`Preparing ${operation.files.length} repository files…`)
    try {
      const manifest = await Promise.all(operation.files.map(async (file) => ({
        path: file.path,
        contentBytes: utf8Bytes(file.content),
        contentSha256: await sha256(file.content),
      })))
      if (!isCurrentOperation(generation)) return
      const startFingerprint = JSON.stringify({
        credential: operation.credential,
        agentId: operation.agentId,
        repositoryName: operation.repositoryName,
        manifest,
      })
      if (historyStartAttempt.current?.fingerprint !== startFingerprint) {
        historyStartAttempt.current = { fingerprint: startFingerprint, attempted: false }
      }
      const allowCreate = !historyStartAttempt.current.attempted
      historyStartAttempt.current.attempted = true
      const start = await postJson<{ repositoryId?: string; manifestSha256?: string; resumed?: boolean }>('/api/history/start', operation.credential, {
        agentId: operation.agentId, repositoryName: operation.repositoryName, manifest, allowCreate,
      }, 'History import start')
      if (!isCurrentOperation(generation)) return
      if (!start.repositoryId || !start.manifestSha256) throw new Error('Letta did not return a repository ID and reviewed manifest hash.')
      activeRepositoryId = start.repositoryId

      let processed = 0
      const receipts: Array<{ paths: string[]; signature: string }> = []
      for (let index = 0; index < operation.files.length; index += 10) {
        const files = operation.files.slice(index, index + 10)
        setHistoryImportMessage(`${start.resumed ? 'Resuming' : 'Importing'} ${processed}/${operation.files.length} files into ${start.repositoryId}…`)
        const batch = await postJson<{ receipt?: { paths: string[]; signature: string } }>('/api/history/batch', operation.credential, {
          repositoryId: start.repositoryId, manifestSha256: start.manifestSha256, files,
        }, 'History import batch')
        if (!isCurrentOperation(generation)) return
        if (!batch.receipt) throw new Error('Continuity Studio did not return a reviewed batch receipt.')
        receipts.push(batch.receipt)
        processed += files.length
      }
      setHistoryImportMessage(`Verified ${processed}/${operation.files.length} files. Attaching read-only memory…`)
      const result = await postJson<{ repositoryId?: string; attached?: boolean }>('/api/history/finish', operation.credential, {
        agentId: operation.agentId, repositoryId: start.repositoryId,
        manifestSha256: start.manifestSha256, receipts,
      }, 'History import finalization')
      if (!isCurrentOperation(generation)) return
      if (!result.repositoryId || !result.attached) throw new Error('The repository attachment could not be verified.')
      setHistoryImport('imported')
      setCompletedImport({
        agentId: operation.agentId,
        agentName: operation.agentName,
        repositoryId: result.repositoryId,
        repositoryName: operation.repositoryName,
        manifestSha256: start.manifestSha256,
        fileCount: processed,
      })
      setHistoryImportMessage(`Attached ${result.repositoryId} with ${processed} verified files as read-only memory.`)
    } catch (error) {
      if (!isCurrentOperation(generation)) return
      setHistoryImport('error')
      const detail = error instanceof Error ? error.message : 'History import failed.'
      setHistoryImportMessage(activeRepositoryId
        ? `Import paused. Repository ${activeRepositoryId} was retained. Press Import history again to reconcile and resume. ${detail}`
        : detail)
    } finally {
      endOperation(generation)
    }
  }

  const selectExistingAgent = async () => {
    if (!existingAgentId.trim() || operationActive || operationLock.current) return
    const generation = beginOperation()
    if (generation === null) return
    const credential = apiKey
    const requestedAgentId = existingAgentId.trim()
    setCreation('creating')
    setCreationMessage('Checking the existing agent in Letta…')
    try {
      const result = await postJson<{ agentId?: string; name?: string }>(
        '/api/agents/retrieve', credential, { agentId: requestedAgentId }, 'Agent lookup',
      )
      if (!isCurrentOperation(generation)) return
      if (!result.agentId || !result.name) throw new Error('Continuity Studio did not receive the existing agent identity.')
      setCreatedAgentId(result.agentId)
      setCreatedAgentName(result.name)
      setCreation('created')
      setCreationOrigin('existing')
      setCreatedPayload('')
      setCreationMessage(`Using existing agent ${result.name}: ${result.agentId}. The draft above was not written into this agent.`)
    } catch (error) {
      if (!isCurrentOperation(generation)) return
      setCreation('error')
      setCreationOrigin('')
      setCreationMessage(error instanceof Error ? error.message : 'Agent lookup failed.')
    } finally {
      endOperation(generation)
    }
  }

  return (
    <main className={studioStarted ? 'shell studio-mode' : 'shell'}>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Continuity Studio home" onClick={(event) => { event.preventDefault(); showIntroduction() }}>
          <span className="brand-mark">C</span>
          <span>Continuity Studio</span>
        </a>
        <div className="topbar-actions">
          <a className="source-link" href="https://github.com/martusha89/continuity-studio" target="_blank" rel="noreferrer">Inspect source</a>
          <div className="status"><span /> {creation === 'created' ? creationOrigin === 'existing' ? 'Existing agent selected' : 'Agent created in Letta' : connection === 'connected' ? 'Letta verified · draft remains in this tab' : 'Draft stored in this tab'}</div>
        </div>
      </header>

      <section className="hero" id="top">
        <p className="kicker">Simplified setup for persistent AI</p>
        <h1>Create a Letta agent<br />with memory from the start</h1>
        <p className="lede">
          Continuity Studio guides you through identity, information about you, and how you work
          together. It turns your answers into three readable memory files for you to review, then
          creates the agent in your own Letta account. Bring existing conversation history and
          memories with you—for continuity between models and providers.
        </p>
        <button type="button" className="start-button" onClick={enterStudio}>Start creating</button>
      </section>

      <section className="studio" id="studio" aria-label="Continuity Studio setup">
        <nav className="stepper" aria-label="Onboarding sections">
          {steps.map((item) => {
            const completion = completionForStep(item.id, draft)
            const progressLabel = item.id === 'connect'
              ? connection === 'connected' ? 'Connected' : 'Later'
              : item.id === 'history'
                ? historyDump ? 'Mapped' : 'Optional'
                : item.id === 'review'
                  ? `${preview.memory.length} files`
                  : completion === 100 ? 'Ready' : `${completion}%`
            return (
              <button
                className={item.id === step ? 'step active' : 'step'}
                aria-current={item.id === step ? 'step' : undefined}
                key={item.id}
                onClick={() => { if (!operationActive) setStep(item.id) }}
                disabled={operationActive}
                type="button"
              >
                <span className="step-number">{item.eyebrow}</span>
                <span className="step-label">{item.label}</span>
                <span className="step-progress">{progressLabel}</span>
              </button>
            )
          })}
          <div className="privacy-note">
            <span>Nothing sent while you write</span>
            Draft answers stay in this tab. At creation, your key and reviewed files pass through this server to Letta, but are not persisted here.
          </div>
        </nav>

        <div className="editor">
          {step === 'connect' && (
            <div className="panel connect-panel">
              <PanelHeading number="05" title="Create only when the files are right." text="Connect at the boundary. Verification creates nothing; the next action creates one persistent agent with Letta’s managed defaults and letta/auto." />
              <div className="connect-card connect-first">
                <div className="connect-copy">
                  <span>Required connection</span>
                  <strong>Your Letta account and usage</strong>
                  <p>Continuity Studio uses your own Letta API key to create the agent in your Letta Cloud account. Letta Auto is selected by default, and you can change the model later in Letta. Ongoing model usage is charged or deducted by Letta according to your account, including any allowance available on your plan—not by Continuity Studio.</p>
                  <p>Your API key and reviewed memory or history files pass through the Continuity Studio server only for the Letta operations you request. Continuity Studio does not persist them.</p>
                  <p>Continuity Studio does not charge for creating an agent. Your normal Letta plan limits and usage costs still apply. <a href="https://docs.letta.com/pricing/index.md" target="_blank" rel="noreferrer">View current Letta pricing</a>.</p>
                </div>
                <form className="key-control" onSubmit={(event) => { event.preventDefault(); void verifyLetta() }}>
                  <input
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => credentialChanged(event.target.value)}
                    disabled={operationActive}
                    placeholder="Letta API key"
                    aria-label="Letta API key"
                  />
                  <button type="submit" disabled={!apiKey.trim() || operationActive}>
                    {connection === 'checking' ? 'Checking…' : connection === 'connected' ? 'Connected' : 'Verify key'}
                  </button>
                </form>
                {connectionMessage && <p className={`connection-message ${connection}`}>{connectionMessage}</p>}
              </div>
              <div className="plain-explainer">
                <span>Why now?</span>
                <p>You could explore and build the person without credentials. Connection is required only at the explicit creation boundary.</p>
              </div>
              <div className={`create-callout ${creation === 'error' ? 'creation-error' : ''}`}>
                <div>
                  <span>{usingExistingAgent ? 'Existing agent selected' : draftChangedAfterCreation ? 'Draft changed' : creation === 'created' ? 'Agent created' : 'Explicit creation'}</span>
                  <strong>{usingExistingAgent ? 'Continue without creating a twin' : draftChangedAfterCreation ? 'These edits are not in the created agent' : creation === 'created' ? preview.name : 'Create the reviewed agent in Letta'}</strong>
                  <p>{usingExistingAgent ? `${createdAgentId} already exists. Continuity Studio has not applied this draft to it.` : draftChangedAfterCreation ? `${createdAgentId} still contains the payload created earlier.` : creation === 'created' ? createdAgentId : 'This creates a real persistent Letta agent. A lost response can make a retry ambiguous, so inspect Letta before retrying after a network failure.'}</p>
                </div>
                <button type="button" onClick={createAgent} disabled={connection !== 'connected' || !readiness.ready || !reviewedMemoryReady || creation === 'creating' || creation === 'created'}>
                  {creation === 'creating' ? 'Creating…' : creation === 'created' ? creationOrigin === 'existing' ? 'Selected' : 'Created' : readiness.ready && reviewedMemoryReady ? 'Create agent' : 'Finish the memory first'}
                </button>
              </div>
              {creationMessage && <p className={`creation-message ${creation}`} role={creation === 'error' ? 'alert' : 'status'}>{creationMessage}</p>}
              {creation !== 'created' && (
                <form className="existing-agent" onSubmit={(event) => { event.preventDefault(); void selectExistingAgent() }}>
                  <div><span>Already created one?</span><p>After a reload or uncertain response, retrieve the agent by ID instead of creating a duplicate.</p></div>
                  <input value={existingAgentId} disabled={operationActive} onChange={(event) => setExistingAgentId(event.target.value)} placeholder="agent-…" aria-label="Existing Letta agent ID" />
                  <button type="submit" disabled={connection !== 'connected' || !existingAgentId.trim() || creation === 'creating'}>Use existing agent</button>
                </form>
              )}
              <div className="inspection-card">
                <div>
                  <span>Careful by design</span>
                  <strong>Inspect the source on GitHub.</strong>
                  <p>Review the application code, dependency lockfile, architecture, security model, and licensing before connecting your Letta account.</p>
                </div>
                <div className="inspection-actions">
                  <a href="https://github.com/martusha89/continuity-studio" target="_blank" rel="noreferrer">View source on GitHub</a>
                  <a href="https://github.com/martusha89/continuity-studio/blob/main/docs/ai-inspection-guide.md" target="_blank" rel="noreferrer">Read the inspection guide</a>
                </div>
              </div>
            </div>
          )}

          {step === 'ai' && (
            <div className="panel">
              <PanelHeading number="01" title="Start with who they are." text="Give your AI a name, identity, and voice—the qualities that should stay recognisable in every conversation." />
              <div className="field-grid core-fields">
                <Field compact label="Name" hint="What should they call themselves?" value={draft.agentName} onChange={(v) => setField('agentName', v)} placeholder="e.g. Rowan" />
                <Field label="Identity" hint="Background, role, sense of self, and what makes them recognisable." value={draft.identity} onChange={(v) => setField('identity', v)} placeholder="They are…" />
                <Field label="Voice" hint="Rhythm, directness, humour, warmth, vocabulary." value={draft.voice} onChange={(v) => setField('voice', v)} placeholder="Direct without becoming cold…" />
              </div>
              <details className="progressive-fields">
                <summary>Add temperament, values, boundaries, and agency</summary>
                <p>Useful when the AI needs sharper judgment than a role and voice can provide.</p>
                <div className="field-grid">
                  <Field label="Temperament" hint="How they meet the world when no explicit tone is requested." value={draft.temperament} onChange={(v) => setField('temperament', v)} placeholder="Steady, curious, irreverent…" />
                  <Field label="Values" hint="What they protect and what wins when values collide." value={draft.values} onChange={(v) => setField('values', v)} placeholder="Truth before comfort…" />
                  <Field label="Boundaries" hint="Hard limits, refusals, and things they must never pretend." value={draft.boundaries} onChange={(v) => setField('boundaries', v)} placeholder="Never fabricate a memory…" />
                  <Field label="Agency" hint="How much initiative, disagreement, and independent judgment should they use?" value={draft.autonomy} onChange={(v) => setField('autonomy', v)} placeholder="Take the next safe move without asking…" />
                </div>
              </details>
            </div>
          )}

          {step === 'human' && (
            <div className="panel">
              <PanelHeading number="02" title="Help them understand you." text="Share who you are, what matters to you, and anything they should remember when talking or working with you." />
              <div className="field-grid core-fields">
                <Field compact label="Human name" hint="The name the agent should know." value={draft.humanName} onChange={(v) => setField('humanName', v)} placeholder="e.g. Alex" />
                <Field label="Context" hint="Life, work, motivations, accessibility, and durable circumstances." value={draft.humanContext} onChange={(v) => setField('humanContext', v)} placeholder="Alex is building…" />
                <Field label="Communication" hint="Detail, tone, corrections, humour, and how to handle uncertainty." value={draft.communication} onChange={(v) => setField('communication', v)} placeholder="Lead with the answer…" />
              </div>
              <details className="progressive-fields">
                <summary>Add support needs and things to avoid</summary>
                <p>Keep these concrete. A phrase, pattern, or known source of friction is more useful than a personality label.</p>
                <div className="field-grid">
                  <Field label="Good support" hint="What genuinely useful presence or collaboration looks like." value={draft.support} onChange={(v) => setField('support', v)} placeholder="When overwhelmed, reduce the world to…" />
                  <Field label="Avoid" hint="Patterns, phrases, or assumptions that create friction or harm." value={draft.avoid} onChange={(v) => setField('avoid', v)} placeholder="Do not turn every raw moment into a plan…" />
                </div>
              </details>
            </div>
          )}

          {step === 'relationship' && (
            <div className="panel">
              <PanelHeading number="03" title="Write how the relationship works." text={`This becomes ${memoryPath('relationship')}: the authority, trust, decision, and continuity contract between them.`} />
              <div className="choice-row" role="group" aria-label="Relationship model">
                {['Creative partner', 'Personal companion', 'Coach', 'Research collaborator', 'Assistant', 'Custom'].map((choice) => (
                  <button type="button" className={draft.relationshipType === choice ? 'choice selected' : 'choice'} onClick={() => setField('relationshipType', choice)} key={choice}>{choice}</button>
                ))}
              </div>
              <div className="field-grid">
                <Field label="Foundation" hint="Equality, authority, care, trust, and the purpose of the relationship." value={draft.relationshipFoundation} onChange={(v) => setField('relationshipFoundation', v)} placeholder="They are partners and equals…" />
                <Field label="Decision-making" hint="When should the agent lead, ask, disagree, or stop?" value={draft.decisionMaking} onChange={(v) => setField('decisionMaking', v)} placeholder="Take initiative when consequences are reversible…" />
              </div>
              <details className="progressive-fields">
                <summary>Continuity across conversations and gaps</summary>
                <p>A safe default is already here. Edit it if this relationship needs a stronger or narrower continuity rule.</p>
                <div className="field-grid single-field">
                  <Field label="Continuity" hint="What should persist across conversations, models, devices, and gaps?" value={draft.continuity} onChange={(v) => setField('continuity', v)} placeholder="Infrastructure can change without erasing…" />
                </div>
              </details>
            </div>
          )}

          {step === 'review' && (
            <div className="panel review-panel">
              <PanelHeading number="04" title="These files are the control surface." text="Review and edit each memory description and file body before they enter the agent’s system memory. No captured system prompt. No hidden rewrite." />
              <div className="review-summary">
                <div><span>Agent</span><strong>{preview.name}</strong></div>
                <div><span>Model</span><strong>letta/auto</strong></div>
                <div><span>System memory</span><strong>{preview.memory.length} reviewed files</strong></div>
                <div><span>Runtime</span><strong>Letta-managed defaults</strong></div>
              </div>
              <div className="memory-tabs" role="tablist" aria-label="Memory files">
                {preview.memory.map((entry, index) => (
                  <button
                    type="button"
                    role="tab"
                    id={`memory-tab-${entry.label}`}
                    aria-controls={`memory-panel-${entry.label}`}
                    aria-selected={reviewedLabel === entry.label}
                    tabIndex={reviewedLabel === entry.label ? 0 : -1}
                    className={reviewedLabel === entry.label ? 'selected' : ''}
                    onClick={() => selectMemoryTab(entry.label)}
                    onKeyDown={(event) => handleMemoryTabKey(event, index)}
                    key={entry.label}
                  >
                    {memoryPath(entry.label)}
                  </button>
                ))}
              </div>
              {preview.memory.filter((entry) => entry.label === reviewedLabel).map((entry) => (
                <div
                  className="memory-editor"
                  role="tabpanel"
                  id={`memory-panel-${entry.label}`}
                  aria-labelledby={`memory-tab-${entry.label}`}
                  key={entry.label}
                >
                  <label className="memory-description">
                    <span>Memory description</span>
                    <textarea
                      rows={2}
                      value={entry.description}
                      onChange={(event) => editMemory(entry.label, { description: event.target.value })}
                    />
                  </label>
                  <label className="memory-content">
                    <span>File content</span>
                    <textarea
                      rows={22}
                      value={entry.value}
                      onChange={(event) => editMemory(entry.label, { value: event.target.value })}
                    />
                  </label>
                </div>
              ))}
              <div className="review-actions">
                <p>Changing a questionnaire answer regenerates only its file. Studio asks before replacing direct content edits.</p>
                <button type="button" onClick={copyPreview}>{copied ? 'Copied' : 'Copy reviewed files'}</button>
              </div>
              {!readiness.ready && <p className="creation-message error">Finish the required persona, human, and relationship fields before creation. Missing: {readiness.missing.join(', ')}.</p>}
              {!reviewedMemoryReady && <p className="creation-message error">Each memory needs a useful description and meaningful content beyond its headings.</p>}
            </div>
          )}

          {step === 'history' && (
            <div className="panel history-panel">
              <PanelHeading number="06" title="Bring existing history." text="Optional. Choose an export file and review what Continuity Studio found before anything enters Letta." />

              <section className="history-guide">
                <span className="micro-label">Before you begin</span>
                <h3>Get a copy of your history from the app where it lives.</h3>
                <ol>
                  <li>Open that app’s <strong>Settings</strong>, <strong>Privacy</strong>, or <strong>Account</strong> page.</li>
                  <li>Look for <strong>Export data</strong>, <strong>Download my data</strong>, or <strong>Backup</strong>.</li>
                  <li>Download the export. If it arrives as a ZIP file, open the ZIP and find the file ending in <strong>.json</strong>.</li>
                  <li>Choose that JSON file below. We inspect it locally before showing you anything that could be imported.</li>
                </ol>
                <p>Can’t find an export? Do not paste passwords or database credentials here. Ask the app owner for a JSON export, or skip this optional step.</p>
              </section>

              <div className="history-source">
                <div>
                  <span className="micro-label">Your export file</span>
                  <strong>Choose the .json file</strong>
                  <p>The export is parsed in your browser. At import, the rendered reviewed files and API key pass through this server to Letta; this server does not persist them.</p>
                </div>
                <label className="file-button">
                  Choose JSON file
                  <input type="file" accept="application/json,.json" disabled={historyImport === 'importing'} onChange={(event) => void readHistoryFile(event.target.files?.[0])} />
                </label>
              </div>
              <details className="paste-json">
                <summary>Advanced · paste JSON text instead</summary>
                <p>Only use this if someone gave you the raw contents of a JSON export. JSON usually begins with <code>{'{'}</code> or <code>[</code>.</p>
                <textarea
                  className="dump-input"
                  rows={8}
                  value={historyText}
                  onChange={(event) => {
                    historyInputGeneration.current += 1
                    invalidateHistoryImport()
                    setHistoryText(event.target.value)
                  }}
                  disabled={historyImport === 'importing'}
                  placeholder="Paste the JSON export here…"
                />
                <button className="inspect-button" type="button" onClick={() => inspectHistory(historyText)} disabled={!historyText.trim() || historyImport === 'importing'}>
                  Inspect pasted JSON
                </button>
              </details>
              {historyError && <p className="creation-message error" role="alert">{historyError}</p>}
              {!historyDump && <p className="history-skip">History is optional. If the three core memory files are enough, the agent is ready when creation succeeds.</p>}

              {historyDump && historyPreview && (
                <>
                  <div className="history-summary">
                    <div><span>Tables</span><strong>{Object.keys(historyDump.tables).length}</strong></div>
                    <div><span>Included</span><strong>{historyPreview.included}</strong></div>
                    <div><span>Private excluded</span><strong>{historyPreview.excludedPrivate}</strong></div>
                    <div><span>Privacy rules missing</span><strong>{enabledWithoutPrivacyRule}</strong></div>
                    <div><span>Files</span><strong>{historyPreview.files.length}</strong></div>
                    <div><span>Invalid</span><strong>{historyPreview.invalid}</strong></div>
                  </div>

                  <div className="history-options">
                    <label>
                      <span>Source name</span>
                  <input value={sourceSlug} disabled={historyImport === 'importing'} onChange={(event) => { invalidateHistoryImport(); setSourceSlug(event.target.value) }} />
                    </label>
                    <label className="privacy-toggle">
                      <input type="checkbox" checked={includePrivate} disabled={historyImport === 'importing'} onChange={(event) => { invalidateHistoryImport(); setIncludePrivate(event.target.checked) }} />
                      <span><strong>Include private rows</strong><small>Off by default. A Letta repository is not a privacy boundary.</small></span>
                    </label>
                    <label>
                      <span>Timezone-less dates</span>
                      <select value={timezonePolicy} disabled={historyImport === 'importing'} onChange={(event) => { invalidateHistoryImport(); setTimezonePolicy(event.target.value as 'preserve' | 'utc') }}>
                        <option value="preserve">Preserve exactly</option>
                        <option value="utc">Interpret as UTC</option>
                      </select>
                    </label>
                  </div>
                  {enabledWithoutPrivacyRule > 0 && (
                    <label className="privacy-toggle">
                      <input type="checkbox" checked={confirmNoPrivacyRule} disabled={historyImport === 'importing'} onChange={(event) => { invalidateHistoryImport(); setConfirmNoPrivacyRule(event.target.checked) }} />
                      <span><strong>Continue without privacy rules for {enabledWithoutPrivacyRule} collection(s)</strong><small>No exclusion column was selected. Continuity Studio cannot infer that every included row is safe.</small></span>
                    </label>
                  )}

                  <div className="mapping-heading">
                    <span>Human-reviewed mapping recipe</span>
                    <small>Suggestions come from column names. Change anything wrong.</small>
                  </div>
                  <div className="mapping-list">
                    {historyMappings.map((mapping) => (
                      <MappingCard
                        key={mapping.table}
                        mapping={mapping}
                        columns={columnsFor(historyDump.tables[mapping.table] ?? [])}
                        count={historyDump.tables[mapping.table]?.length ?? 0}
                        disabled={historyImport === 'importing'}
                        onChange={(patch) => updateMapping(mapping.table, patch)}
                      />
                    ))}
                  </div>

                  {historyPreview.warnings.map((warning) => <p className="creation-message error" key={warning}>{warning}</p>)}
                  <div className="code-heading history-code-heading">
                    <span>Representative rendered file · {historyPreview.files[1]?.path ?? historyPreview.files[0]?.path}</span>
                  </div>
                  <pre>{historyPreview.files[1]?.content ?? historyPreview.files[0]?.content}</pre>

                  <div className="history-target">
                    <label><span>Verified target agent</span><input value={createdAgentId ? `${createdAgentName} · ${createdAgentId}` : 'Create or select an agent first'} readOnly /></label>
                    <label><span>Repository name</span><input value={repositoryName} disabled={historyImport === 'importing'} onChange={(event) => { invalidateHistoryImport(); setRepositoryName(event.target.value) }} /></label>
                  </div>
                  <div className="create-callout history-import-callout">
                    <div>
                      <span>Explicit import</span>
                      <strong>Create and attach read-only memory</strong>
                      <p>The source remains canonical. Imported text is labelled untrusted historical reference material. This creates or safely resumes a uniquely named hosted repository, verifies the reviewed files, and attaches it to the selected agent.</p>
                    </div>
                    <button
                      type="button"
                      onClick={importExistingHistory}
                      disabled={connection !== 'connected' || creation !== 'created' || !createdAgentId || !repositoryName.trim() || historyImport === 'importing' || historyImport === 'imported' || historyPreview.files.length > MAX_HISTORY_FILES || renderedImportBytes > MAX_HISTORY_CONTENT_BYTES || oversizedRenderedFiles > 0 || historyPreview.invalid > 0 || (enabledWithoutPrivacyRule > 0 && !confirmNoPrivacyRule)}
                    >
                      {historyImport === 'importing' ? 'Importing…' : historyImport === 'imported' ? 'Attached' : 'Import history'}
                    </button>
                  </div>
                  {historyImportMessage && <p className={`creation-message ${historyImport}`} role={historyImport === 'error' ? 'alert' : 'status'}>{historyImportMessage}</p>}
                  {completedImport && <p className="history-connection-note">Receipt: {completedImport.agentName} ({completedImport.agentId}) · {completedImport.repositoryName} ({completedImport.repositoryId}) · {completedImport.fileCount} files · manifest {completedImport.manifestSha256.slice(0, 12)}…</p>}
                  {oversizedRenderedFiles > 0 && <p className="creation-message error">{oversizedRenderedFiles} rendered file(s) exceed the 1 MiB per-file limit. Split or remap those records before importing.</p>}
                  {connection !== 'connected' && <p className="history-connection-note">Return to Connect Letta and verify the key before importing.</p>}
                </>
              )}
            </div>
          )}

          <footer className="editor-footer">
            <button type="button" className="secondary" onClick={() => move(-1)} disabled={currentIndex === 0 || operationActive}>Back</button>
            <span>{currentIndex + 1} of {steps.length}</span>
            <button type="button" className="primary" onClick={() => move(1)} disabled={operationActive || currentIndex === steps.length - 1 || (step === 'connect' && creation !== 'created')}>Continue</button>
          </footer>
        </div>
      </section>
    </main>
  )
}

function PanelHeading({ number, title, text }: { number: string; title: string; text: string }) {
  return (
    <header className="panel-heading">
      <span>{number}</span>
      <div><h2>{title}</h2><p>{text}</p></div>
    </header>
  )
}

async function sha256(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function MappingCard({
  mapping,
  columns,
  count,
  disabled,
  onChange,
}: {
  mapping: TableMapping
  columns: string[]
  count: number
  disabled: boolean
  onChange: (patch: Partial<TableMapping>) => void
}) {
  const select = (label: string, value: string | undefined, field: keyof TableMapping, optional = false) => (
    <label>
      <span>{label}</span>
      <select value={value ?? ''} disabled={disabled} onChange={(event) => onChange({ [field]: event.target.value || undefined })}>
        {optional && <option value="">None</option>}
        {columns.map((column) => <option key={column} value={column}>{column}</option>)}
      </select>
    </label>
  )

  return (
    <section className={`mapping-card ${mapping.enabled ? '' : 'disabled'}`}>
      <header>
        <label className="mapping-enable"><input type="checkbox" checked={mapping.enabled} disabled={disabled} onChange={(event) => onChange({ enabled: event.target.checked })} /><strong>{mapping.table}</strong></label>
        <span>{count} rows</span>
      </header>
      <div className="mapping-fields">
        {select('Stable ID', mapping.idColumn, 'idColumn')}
        {select('Primary text', mapping.contentColumn, 'contentColumn')}
        {select('Title', mapping.titleColumn, 'titleColumn', true)}
        {select('Created', mapping.createdAtColumn, 'createdAtColumn', true)}
        {select('Updated', mapping.updatedAtColumn, 'updatedAtColumn', true)}
        {select('Privacy flag', mapping.privacyColumn, 'privacyColumn', true)}
      </div>
    </section>
  )
}

export default App
