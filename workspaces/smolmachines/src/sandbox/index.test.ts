import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { smolmachinesSandboxProvider } from '../provider';
import { SmolmachinesSandbox } from './index';
import type { SmolvmCliResult, SmolvmCommandRunner, SmolvmCommandRunnerOptions } from './index';

interface Machine {
  name: string;
  state: string;
  labels?: Record<string, string>;
  cpus?: number;
  memory_mib?: number;
}

interface Call {
  args: string[];
  options: SmolvmCommandRunnerOptions;
}

type Reply = Partial<SmolvmCliResult> | ((call: Call) => Partial<SmolvmCliResult> | Promise<Partial<SmolvmCliResult>>);

/** A fake `smolvm` CLI that tracks machines and records every call. */
class FakeSmolvm implements SmolvmCommandRunner {
  readonly calls: Call[] = [];
  machines: Machine[] = [];
  exec: Reply = { stdout: '' };

  async run(args: string[], options: SmolvmCommandRunnerOptions = {}): Promise<SmolvmCliResult> {
    const call = { args, options };
    this.calls.push(call);
    const [, verb] = args;
    const name = args[args.indexOf('--name') + 1];
    let reply: Partial<SmolvmCliResult> = {};
    if (verb === 'ls') {
      reply = { stdout: JSON.stringify(this.machines) };
    } else if (verb === 'create') {
      const labels: Record<string, string> = {};
      args.forEach((arg, i) => {
        if (arg === '--label') {
          const [key, value] = args[i + 1]!.split('=');
          labels[key!] = value!;
        }
      });
      this.machines.push({ name: name!, state: 'created', labels });
    } else if (verb === 'start') {
      this.machine(name!).state = 'running';
    } else if (verb === 'stop') {
      this.machine(name!).state = 'stopped';
    } else if (verb === 'delete') {
      this.machines = this.machines.filter(machine => machine.name !== name);
    } else if (verb === 'checkpoint') {
      writeFileSync(args[args.indexOf('-o') + 1]!, 'checkpoint');
    } else if (verb === 'exec') {
      reply = typeof this.exec === 'function' ? await this.exec(call) : this.exec;
    }
    const exitCode = reply.exitCode ?? 0;
    return { success: exitCode === 0, exitCode, stdout: '', stderr: '', executionTimeMs: 1, ...reply };
  }

  machine(name: string): Machine {
    const machine = this.machines.find(m => m.name === name);
    if (!machine) throw new Error(`no machine ${name}`);
    return machine;
  }

  verbs(): string[] {
    return this.calls.map(call => call.args[1]!);
  }

  /** The user command of the last exec, unwrapped from the process-group wrapper. */
  lastCommand(): Call {
    return this.calls.filter(call => call.args[1] === 'exec').at(-1)!;
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(runner: FakeSmolvm, options: ConstructorParameters<typeof SmolmachinesSandbox>[0] = {}) {
  return new SmolmachinesSandbox({ id: 'sb1', runner, ...options });
}

describe('SmolmachinesSandbox lifecycle', () => {
  it('creates, labels and starts a machine, then makes the working directory', async () => {
    const cli = new FakeSmolvm();
    const sb = sandbox(cli, { image: 'python:3.12', cpus: 2, memoryMb: 2048, volumes: { '/host/src': '/src' } });

    await sb._start();

    expect(sb.status).toBe('running');
    expect(cli.verbs()).toEqual(['ls', 'create', 'start', 'exec']);
    const create = cli.calls[1]!.args;
    expect(create).toEqual(expect.arrayContaining(['--name', 'mastra-sb1', '--image', 'python:3.12', '--net']));
    expect(create).toEqual(expect.arrayContaining(['--cpus', '2', '--mem', '2048', '-v', '/host/src:/src']));
    expect(create).toEqual(
      expect.arrayContaining(['--label', 'mastra.sandbox=true', '--label', 'mastra.sandbox.id=sb1']),
    );
    expect(cli.calls[3]!.args.slice(-3)).toEqual(['mkdir', '-p', '/workspace']);
  });

  it('turns an allow list into host-enforced egress rules', async () => {
    const cli = new FakeSmolvm();
    await sandbox(cli, { allowHosts: ['registry.npmjs.org', '*.github.com'], allowCidrs: ['10.0.0.0/8'] })._start();

    const create = cli.calls[1]!.args;
    expect(create).toEqual(
      expect.arrayContaining([
        '--allow-host-pattern',
        'registry.npmjs.org',
        '--allow-host-pattern',
        '*.github.com',
        '--allow-cidr',
        '10.0.0.0/8',
      ]),
    );
  });

  it('creates a machine without network when asked', async () => {
    const cli = new FakeSmolvm();
    await sandbox(cli, { network: false })._start();
    expect(cli.calls[1]!.args).not.toContain('--net');
  });

  it('reconnects to its running machine and restarts a stopped one', async () => {
    const cli = new FakeSmolvm();
    await sandbox(cli)._start();

    const again = new FakeSmolvm();
    again.machines = cli.machines;
    await sandbox(again)._start();
    expect(again.verbs()).toEqual(['ls', 'exec']);

    again.machines[0]!.state = 'stopped';
    const third = new FakeSmolvm();
    third.machines = again.machines;
    await sandbox(third)._start();
    expect(third.verbs()).toEqual(['ls', 'start', 'exec']);
  });

  it('refuses a machine it did not create', async () => {
    const cli = new FakeSmolvm();
    cli.machines = [{ name: 'mastra-sb1', state: 'running', labels: {} }];
    await expect(sandbox(cli)._start()).rejects.toThrow(/was not created by Mastra sandbox 'sb1'/);
  });

  it('refuses a machine created with a different configuration', async () => {
    const cli = new FakeSmolvm();
    await sandbox(cli, { image: 'alpine' })._start();
    const other = new FakeSmolvm();
    other.machines = cli.machines;
    await expect(sandbox(other, { image: 'node:22-slim' })._start()).rejects.toThrow(/different configuration/);
  });

  it('deletes its machine on destroy, or only stops it when asked to keep it', async () => {
    const cli = new FakeSmolvm();
    const sb = sandbox(cli);
    await sb._start();
    await sb._destroy();
    expect(sb.status).toBe('destroyed');
    expect(cli.machines).toEqual([]);

    const kept = new FakeSmolvm();
    const keep = sandbox(kept, { deleteOnDestroy: false });
    await keep._start();
    await keep._destroy();
    expect(kept.machines[0]!.state).toBe('stopped');
  });

  it('removes a machine that fails to start', async () => {
    const cli = new FakeSmolvm();
    const run = cli.run.bind(cli);
    cli.run = async (args, options) =>
      args[1] === 'start'
        ? { success: false, exitCode: 1, stdout: '', stderr: 'boom', executionTimeMs: 1 }
        : run(args, options);
    await expect(sandbox(cli)._start()).rejects.toThrow(/failed to start machine 'mastra-sb1': boom/);
    expect(cli.machines).toEqual([]);
  });
});

describe('SmolmachinesSandbox commands', () => {
  it('runs a command through the machine with its env, cwd and timeout', async () => {
    const cli = new FakeSmolvm();
    cli.exec = { stdout: 'hi\n' };
    const sb = sandbox(cli, { env: { TOKEN: 'secret-value' } });

    const result = await sb.executeCommand('echo', ['hi there'], { cwd: '/src', timeout: 1500, env: { TASK: '42' } });

    expect(result).toMatchObject({ success: true, exitCode: 0, stdout: 'hi\n', command: "echo 'hi there'" });
    const { args, options } = cli.lastCommand();
    expect(args).toEqual(expect.arrayContaining(['--stream', '-w', '/src', '--timeout', '1500ms']));
    // Values travel in the CLI's environment, never its argument list.
    expect(args).toEqual(expect.arrayContaining(['-e', 'TOKEN', '-e', 'TASK']));
    expect(args.join(' ')).not.toContain('secret-value');
    expect(options.env).toMatchObject({ TOKEN: 'secret-value', TASK: '42' });
    expect(args.at(-1)).toBe("echo 'hi there'");
  });

  it('reports a timeout from the machine and strips its message', async () => {
    const cli = new FakeSmolvm();
    const sb = sandbox(cli);
    await sb._start();
    cli.exec = { exitCode: 124, stderr: 'partial\ncommand timed out after 100ms\n' };
    const result = await sb.executeCommand('sleep 30', [], { timeout: 100 });
    expect(result).toMatchObject({ success: false, exitCode: 124, timedOut: true, killed: true });
    expect(result.stderr).not.toContain('timed out');
  });

  it('reports a timeout the streaming CLI signals by exit code alone', async () => {
    const cli = new FakeSmolvm();
    const sb = sandbox(cli);
    await sb._start();
    cli.exec = { exitCode: 124, stderr: '', executionTimeMs: 1_050 };
    const result = await sb.executeCommand('sleep 30', [], { timeout: 1_000 });
    expect(result.timedOut).toBe(true);
  });

  it('does not mistake a command that exits 124 for a timeout', async () => {
    const cli = new FakeSmolvm();
    const sb = sandbox(cli);
    await sb._start();
    cli.exec = { exitCode: 124, stderr: '' };
    const result = await sb.executeCommand('exit 124');
    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBeUndefined();
  });

  it("ends an aborted command's process group in the machine", async () => {
    const cli = new FakeSmolvm();
    const sb = sandbox(cli);
    await sb._start();
    const controller = new AbortController();
    cli.exec = ({ args, options }) => {
      if (args.includes('mastra-smolmachines')) {
        controller.abort();
        expect(options.abortSignal?.aborted).toBe(true);
        return { exitCode: 143, killed: true };
      }
      return {};
    };

    const result = await sb.executeCommand('sleep 30', [], { abortSignal: controller.signal });

    expect(result.killed).toBe(true);
    const group = cli.calls.find(call => call.args.includes('mastra-smolmachines'))!.args.at(-2)!;
    const kills = cli.calls.filter(call => call.args.at(-1)?.includes(`/tmp/.mastra-smolmachines/${group}`));
    expect(kills.length).toBeGreaterThan(0);
    expect(kills[0]!.args.at(-1)).toContain('kill -TERM -"$p"');
  });

  it('starts the machine on first use', async () => {
    const cli = new FakeSmolvm();
    const sb = sandbox(cli);
    await sb.executeCommand('true');
    expect(sb.status).toBe('running');
    expect(cli.verbs().slice(0, 3)).toEqual(['ls', 'create', 'start']);
  });
});

describe('SmolmachinesSandbox checkpoints', () => {
  it('saves the whole machine and boots the next sandbox from it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolmachines-ckpt-'));
    dirs.push(dir);
    const cli = new FakeSmolvm();
    const first = sandbox(cli, { checkpointName: 'base', checkpointsDirectory: dir });
    expect(first.supportsCheckpoints).toBe(true);
    await first._start();

    await first.snapshot();

    const checkpoint = join(dir, 'base.smolcheckpoint');
    expect(existsSync(checkpoint)).toBe(true);
    const capture = cli.calls.find(call => call.args[1] === 'checkpoint')!.args;
    expect(capture[capture.indexOf('-o') + 1]).not.toBe(checkpoint);

    const next = new FakeSmolvm();
    await new SmolmachinesSandbox({
      id: 'sb2',
      runner: next,
      checkpointName: 'base',
      checkpointsDirectory: dir,
    })._start();
    const create = next.calls.find(call => call.args[1] === 'create')!.args;
    expect(create).toEqual(expect.arrayContaining(['--from', checkpoint]));
    expect(create).not.toContain('--image');
  });

  it('boots from the seed checkpoint until its own exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smolmachines-ckpt-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'warm.smolcheckpoint'), 'checkpoint');
    const cli = new FakeSmolvm();
    await sandbox(cli, { checkpointName: 'session-1', seedCheckpointName: 'warm', checkpointsDirectory: dir })._start();
    const create = cli.calls.find(call => call.args[1] === 'create')!.args;
    expect(create).toEqual(expect.arrayContaining(['--from', join(dir, 'warm.smolcheckpoint')]));
  });

  it('does nothing on snapshot without a checkpoint name', async () => {
    const cli = new FakeSmolvm();
    await sandbox(cli).snapshot();
    expect(cli.calls).toEqual([]);
  });

  it('rejects unsafe checkpoint names', () => {
    expect(() => sandbox(new FakeSmolvm(), { checkpointName: '../escape' })).toThrow(/Invalid checkpoint name/);
  });
});

describe('SmolmachinesSandbox metadata', () => {
  it('describes the machine and its egress limits to agents', () => {
    const instructions = sandbox(new FakeSmolvm(), { allowHosts: ['pypi.org'] }).getInstructions();
    expect(instructions).toContain('microVM');
    expect(instructions).toContain('pypi.org');
    expect(sandbox(new FakeSmolvm(), { instructions: 'custom' }).getInstructions()).toBe('custom');
  });

  it('clones with its configuration and a new id', () => {
    const clone = sandbox(new FakeSmolvm(), { image: 'alpine' }).clone({ id: 'sb9' });
    expect(clone.id).toBe('sb9');
    expect(clone.machineName).toBe('mastra-sb9');
  });

  it('builds sandboxes from editor config', () => {
    const sb = smolmachinesSandboxProvider.createSandbox({ id: 'from-editor', image: 'alpine' });
    expect(sb).toBeInstanceOf(SmolmachinesSandbox);
    expect(smolmachinesSandboxProvider.id).toBe('smolmachines');
  });
});
