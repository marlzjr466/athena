// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'
import { mlxWorker } from '../electron/main/ai/mlxWorker'
it('strictly parses native or complete JSON tool requests without executing prose', () => {
  const helper = '    def tool_calls' + mlxWorker.split('    def tool_calls')[1].split('    def generate')[0]
  const script = `import json,re,textwrap\nexec(textwrap.dedent(${JSON.stringify(helper)}))\ntools=[{'function':{'name':'read_file'}}]\nvalid={'name':'read_file','arguments':{'path':'src/main.tsx'}}\nraw=json.dumps(valid)\nassert tool_calls(raw,tools)==[valid]\nassert tool_calls(chr(96)*3+'json\\n'+raw+'\\n'+chr(96)*3,tools)==[valid]\nassert tool_calls('<tool_call>'+raw+'</tool_call>',tools)==[valid]\nassert tool_calls('I read the file. '+raw,tools)==[]\nassert tool_calls('{broken',tools)==[]\nfor call in [{'name':'write_file','arguments':{}},{'name':'read_file','arguments':[]},{'name':'read_file','arguments':{},'execute':True}]:\n try:\n  tool_calls(json.dumps(call),tools)\n except ValueError:\n  continue\n raise Exception('Invalid tool call accepted')\nfor text in ['text <tool_call>'+raw+'</tool_call>', '<tool_call>'+raw+'</tool_call><tool_call>', '<tool_call>'+raw+'</tool_call> trailing', '{\"name\":\"read_file\",\"name\":\"read_file\",\"arguments\":{}}']:\n try:\n  tool_calls(text,tools)\n except ValueError:\n  continue\n raise Exception('Ambiguous tool output accepted')\nprint('Strict parser checks passed')\n`
  expect(execFileSync('python3', ['-c', script], { encoding: 'utf8' })).toContain('Strict parser checks passed')
})
