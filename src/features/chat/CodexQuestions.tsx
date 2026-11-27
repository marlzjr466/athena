import { useState } from 'react'
import type { NativeCodexQuestion } from '../../../shared/codex'
import { desktop } from '../../services/desktop'

export function CodexQuestions({request,sessionId}:{request:NativeCodexQuestion;sessionId:string}) {
  const [answers,setAnswers]=useState<Record<string,string>>({}),[pending,setPending]=useState(false),[error,setError]=useState('')
  return <form className="chat-choices" aria-label="Codex questions" onSubmit={event=>{
    event.preventDefault();setPending(true)
    void desktop.chatSession({action:'codex-answer',id:sessionId,requestId:request.requestId,answers:Object.fromEntries(request.questions.map(q=>[q.id,{answers:[answers[q.id] ?? '']}]))})
      .then(r=>{if(!r.ok)setError(r.message ?? 'Could not deliver answer.')}).catch(()=>setError('Could not deliver answer.')).finally(()=>setPending(false))
  }}>
    {request.questions.map(q=><fieldset key={q.id}><legend>{q.question}</legend>
      {q.options?.map(o=><label key={o.label} title={o.description}><input type="radio" name={q.id} checked={answers[q.id]===o.label} onChange={()=>setAnswers(a=>({...a,[q.id]:o.label}))}/>{o.label}</label>)}
      <input className="settings-input" aria-label={`Answer: ${q.question}`} type={q.isSecret?'password':'text'} autoComplete="off" value={answers[q.id] ?? ''} onChange={e=>setAnswers(a=>({...a,[q.id]:e.target.value}))}/>
    </fieldset>)}
    {error&&<p role="alert">{error}</p>}<button className="button secondary" disabled={pending || request.questions.some(q=>!answers[q.id]?.trim())}>Send answer to Codex</button>
  </form>
}
