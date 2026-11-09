import { spawn } from 'node:child_process'

export function recognizeScreenText(binary: string, png: Uint8Array, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if(png.length > 20_000_000)throw new Error('Screen image is too large for local text recognition.')
  return new Promise((resolve,reject)=>{
    const deadline=AbortSignal.any([signal,AbortSignal.timeout(15000)])
    const child=spawn(binary,[],{stdio:['pipe','pipe','pipe'],signal:deadline})
    let output='',failed=false
    const fail=(error:Error)=>{if(!failed){failed=true;reject(error)}}
    child.on('error',()=>fail(new Error(deadline.aborted?'Screen reading cancelled.':'Local screen reader is unavailable. Rebuild Athena or choose a vision model.')))
    child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>150000){child.kill();fail(new Error('Screen text exceeded the recognition limit.'))}})
    child.stderr.resume()
    child.stdin.on('error',()=>{})
    child.on('close',code=>{
      if(failed)return
      if(code!==0){fail(new Error('Local screen reading failed. Try a clearer screen or a vision model.'));return}
      try { const value=JSON.parse(output);if(typeof value.text!=='string')throw new Error();resolve(value.text.slice(0,24000)) }
      catch {fail(new Error('Local screen reader returned an invalid result.'))}
    })
    child.stdin.end(png)
  })
}
