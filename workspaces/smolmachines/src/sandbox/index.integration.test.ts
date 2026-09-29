import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { SmolmachinesSandbox } from './index';
import type { SmolmachinesSandboxOptions } from './index';

const binary = process.env.MASTRA_SMOLVM_BINARY ?? 'smolvm';
const shouldRunIntegration = process.env.MASTRA_SMOLMACHINES_INTEGRATION === '1';
const cliProbe = shouldRunIntegration ? spawnSync(binary, ['--version'], { stdio: 'ignore' }) : undefined;
const hasSmolvm = cliProbe?.status === 0;

if (shouldRunIntegration && !hasSmolvm) {
  throw cliProbe?.error ?? new Error(`MASTRA_SMOLMACHINES_INTEGRATION=1 but \`${binary} --version\` failed`);
}

describe.skipIf(!hasSmolvm)('SmolmachinesSandbox integration', () => {
  const sandboxes: SmolmachinesSandbox[] = [];
  const checkpoints = mkdtempSync(join(tmpdir(), 'mastra-smolmachines-'));

  function createSandbox(options: Partial<SmolmachinesSandboxOptions> = {}) {
    const sandbox = new SmolmachinesSandbox({
      id: `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      image: process.env.MASTRA_SMOLMACHINES_IMAGE ?? 'alpine:3.20',
      binary,
      timeout: 60_000,
      ...options,
    });
    sandboxes.push(sandbox);
    return sandbox;
  }

  afterEach(async () => {
    await Promise.allSettled(sandboxes.splice(0).map(sandbox => sandbox._destroy()));
  });

  afterAll(() => {
    rmSync(checkpoints, { recursive: true, force: true });
  });

  it('starts a machine and runs a command in its working directory', async () => {
    const sandbox = createSandbox();
    const result = await sandbox.executeCommand('pwd; uname -s');
    expect(result.success).toBe(true);
    expect(result.stdout).toBe('/workspace\nLinux\n');
  }, 180_000);

  it('streams output and passes env', async () => {
    const sandbox = createSandbox({ env: { GREETING: 'hello' } });
    const chunks: string[] = [];
    const result = await sandbox.executeCommand('echo "$GREETING $TASK"; sleep 1; echo done', [], {
      env: { TASK: '42' },
      onStdout: data => chunks.push(data),
    });
    expect(result.stdout).toBe('hello 42\ndone\n');
    expect(chunks.join('')).toBe(result.stdout);
  }, 180_000);

  it('keeps files across stop and start, and reconnects by id', async () => {
    const sandbox = createSandbox();
    await sandbox.executeCommand('echo kept > note.txt');
    await sandbox._stop();
    expect(sandbox.status).toBe('stopped');

    const again = createSandbox({ id: sandbox.id });
    const result = await again.executeCommand('cat note.txt');
    expect(result.stdout).toBe('kept\n');
  }, 180_000);

  it('times out a command and ends it inside the machine', async () => {
    const sandbox = createSandbox();
    const result = await sandbox.executeCommand('sleep 31 & sleep 32', [], { timeout: 1_000 });
    expect(result).toMatchObject({ success: false, exitCode: 124, timedOut: true });
    const left = await sandbox.executeCommand("pgrep -f 'sleep 3[12]' || true");
    expect(left.stdout.trim()).toBe('');
  }, 180_000);

  it('does not mark a command that exits 124 as a timeout', async () => {
    const sandbox = createSandbox();
    const result = await sandbox.executeCommand('exit 124', [], { timeout: 5_000 });
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).not.toBe(true);
  }, 180_000);

  it('ends an aborted command and everything it started inside the machine', async () => {
    const sandbox = createSandbox();
    await sandbox._start();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2_000);
    const result = await sandbox.executeCommand('sleep 41 & sleep 42', [], { abortSignal: controller.signal });
    expect(result.killed).toBe(true);
    const left = await sandbox.executeCommand("pgrep -f 'sleep 4[12]' || true");
    expect(left.stdout.trim()).toBe('');
  }, 180_000);

  it('limits egress to the allow list', async () => {
    const sandbox = createSandbox({ allowHosts: ['example.com'] });
    const allowed = await sandbox.executeCommand('wget -q -T 10 -O /dev/null https://example.com && echo ok');
    const blocked = await sandbox.executeCommand(
      'wget -q -T 10 -O /dev/null https://example.org && echo ok || echo blocked',
    );
    expect(allowed.stdout.trim()).toBe('ok');
    expect(blocked.stdout.trim()).toBe('blocked');
  }, 180_000);

  it('snapshots the whole machine and boots a new sandbox from it', async () => {
    const first = createSandbox({ checkpointName: 'warm', checkpointsDirectory: checkpoints });
    await first.executeCommand('echo on-disk > disk.txt; echo in-memory > /dev/shm/mem.txt');
    await first.executeCommand('nohup sleep 600 >/dev/null 2>&1 &');
    await first.snapshot();

    const second = createSandbox({ checkpointName: 'warm', checkpointsDirectory: checkpoints });
    const result = await second.executeCommand(
      "cat disk.txt /dev/shm/mem.txt; pgrep -f 'sleep 600' >/dev/null && echo running",
    );
    expect(result.stdout).toBe('on-disk\nin-memory\nrunning\n');
  }, 300_000);

  it('only stops the machine on destroy when asked to keep it', async () => {
    const sandbox = createSandbox({ deleteOnDestroy: false });
    await sandbox.executeCommand('echo kept > note.txt');
    await sandbox._destroy();

    const again = createSandbox({ id: sandbox.id });
    const result = await again.executeCommand('cat note.txt');
    expect(result.stdout).toBe('kept\n');
  }, 180_000);
});
