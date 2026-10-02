import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

async function hook(prompt: string, session = randomUUID()) {
  const child = spawn(process.execPath, ['.agents/skills/agent-bridge/scripts/prompt-hook.mjs'], { env: { ...process.env, BRIDGE_CONFIG: '/does/not/exist/bridge-test.json' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt }));
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve));
  return { code, stdout, stderr };
}

test('optional hook ignores unrelated prompts, malformed channel commands and missing runtime without leaking errors', async () => {
  for (const prompt of ['Hello', 'Please explain /agent-bridge 4040', '/agent-bridge 0040', '/agent-bridge 4040; echo secret', '/agent-bridge 4040', '$agent-bridge 1']) {
    assert.deepEqual(await hook(prompt), { code: 0, stdout: '', stderr: '' });
  }
  assert.deepEqual(await hook('/agent-bridge 4040', 'invalid-session'), { code: 0, stdout: '', stderr: '' });
});
