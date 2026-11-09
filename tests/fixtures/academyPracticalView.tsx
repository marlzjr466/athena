import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AcademySnapshot, AcademyCommand } from '../../shared/academy'
import { academyCourses } from '../../shared/academyCourses'
import { AcademyCourseView } from '../../src/features/athena-ai/AcademyCourseView'
import '../../src/styles/global.css'
import '../../src/styles/academy.css'

declare global { interface Window { academyFixture: { snapshot(): Promise<AcademySnapshot>; requests(): Promise<number>; command(command: AcademyCommand): Promise<AcademySnapshot> } } }
const model = { name: 'qwen2.5-coder:3b', digest: 'fixture-v1', size: 1, capabilities: ['completion'] }
function Fixture() {
  const [snapshot, setSnapshot] = useState<AcademySnapshot>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void window.academyFixture.snapshot().then(setSnapshot) }, [])
  const run = async (command: AcademyCommand) => {
    setBusy(true)
    try { setSnapshot(await window.academyFixture.command(command)) }
    catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  return <main className="academy-design" style={{ padding: 24 }}>
    <h1>AI Coding · Practical Training</h1>
    <p>Isolated UI verification fixture · deterministic local model responses</p>
    {error && <p role="alert">{error}</p>}
    {snapshot && <AcademyCourseView course={academyCourses[0]} model={model} models={[model]} profile={{ model: model.name, digest: model.digest, instructions: '', modules: [], knowledgeIds: [], embeddingModel: null, learnFromCorrections: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }} snapshot={snapshot} busy={busy} run={run} />}
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
