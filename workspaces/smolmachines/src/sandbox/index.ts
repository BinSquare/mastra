/**
 * smolmachines sandbox provider for Mastra workspaces.
 *
 * Runs each sandbox as a local smolmachines microVM (its own Linux kernel under
 * KVM on Linux or Hypervisor.framework on macOS), driven through the `smolvm`
 * CLI. Machines are found again by their logical `id`, so a sandbox reconnects
 * to its machine across processes. With `checkpointName`, `snapshot()` saves
 * the whole machine (disk, memory and running processes) and a new sandbox
 * boots from that checkpoint.
 */

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { RequestContext } from '@mastra/core/di';
import type {
  CommandResult,
  ExecuteCommandOptions,
  InstructionsOption,
  MastraSandboxOptions,
  ProviderStatus,
  SandboxCloneOptions,
  SandboxInfo,
} from '@mastra/core/workspace';
import { MastraSandbox, ProcessHandle, SandboxExecutionError } from '@mastra/core/workspace';

const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const DEFAULT_IMAGE = 'node:22-slim';
const DEFAULT_WORKING_DIR = '/workspace';
/** Headroom for the CLI itself beyond a command's own timeout. */
const CLI_GRACE_TIMEOUT_MS = 30_000;
/** Lifecycle calls (create pulls the image) get longer than commands. */
const LIFECYCLE_TIMEOUT_MS = 600_000;
const TIMEOUT_EXIT_CODE = 124;
const TIMEOUT_MESSAGE = /^command timed out after \d+ms$/;
/** Where each command records its process group so an abort can end it. */
const PROCESS_GROUP_DIR = '/tmp/.mastra-smolmachines';

/** Result of one `smolvm` CLI invocation. */
export interface SmolvmCliResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  killed?: boolean;
  timedOut?: boolean;
}

/** Options for one `smolvm` CLI invocation. */
export interface SmolvmCommandRunnerOptions {
  timeout?: number;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  maxRetainedBytes?: number;
}

/** Runs the `smolvm` CLI. Replace it to test or to wrap the CLI. */
export interface SmolvmCommandRunner {
  run(args: string[], options?: SmolvmCommandRunnerOptions): Promise<SmolvmCliResult>;
}

/** Runs the `smolvm` binary found on PATH (or the one given). */
export class DefaultSmolvmCommandRunner implements SmolvmCommandRunner {
  constructor(private readonly binary = 'smolvm') {}

  run(args: string[], options: SmolvmCommandRunnerOptions = {}): Promise<SmolvmCliResult> {
    return new SmolvmCliProcess(this.binary, args, options).wait();
  }
}

export interface SmolmachinesSandboxOptions extends Omit<MastraSandboxOptions, 'processes'> {
  /** Logical sandbox id. A sandbox with the same id reconnects to the same machine. */
  id?: string;
  /** Machine name. Defaults to `mastra-<id>`. */
  name?: string;
  /** OCI image the machine boots. @default 'node:22-slim' */
  image?: string;
  /** vCPUs. */
  cpus?: number;
  /** Memory in MiB. */
  memoryMb?: number;
  /** Outbound network access. @default true */
  network?: boolean;
  /**
   * Allow egress only to these hosts. Entries are exact names or `*.domain`
   * wildcards, which don't match the bare domain. Enforced by the machine's
   * host-side network stack. Implies `network`.
   */
  allowHosts?: string[];
  /** Allow egress only to these CIDR ranges. Implies `network`. */
  allowCidrs?: string[];
  /** Host-to-guest mounts (host path -> guest path). */
  volumes?: Record<string, string>;
  /** Published ports (`HOST:GUEST` or `PORT`). */
  ports?: string[];
  /** Environment variables for every command. */
  env?: Record<string, string>;
  /** Working directory for commands, created on start. @default '/workspace' */
  workingDir?: string;
  /** Default command timeout in milliseconds. @default 300000 */
  timeout?: number;
  /** Delete the machine on destroy; otherwise only stop it. @default true */
  deleteOnDestroy?: boolean;
  /** Extra machine labels. */
  labels?: Record<string, string>;
  /**
   * Named checkpoint to boot a new machine from and to save on `snapshot()`.
   * A checkpoint holds the machine's disks, memory and running processes.
   */
  checkpointName?: string;
  /** Checkpoint to boot from when `checkpointName` has none yet. Boot-only. */
  seedCheckpointName?: string;
  /** Where checkpoints are stored. @default '~/.mastra/smolmachines-checkpoints' */
  checkpointsDirectory?: string;
  /** Path to the `smolvm` binary. @default 'smolvm' */
  binary?: string;
  /** Custom CLI runner. */
  runner?: SmolvmCommandRunner;
  /** Custom instructions for agents, replacing or extending the defaults. */
  instructions?: InstructionsOption;
}

interface SmolvmMachine {
  name: string;
  state: string;
  labels?: Record<string, string>;
  cpus?: number;
  memory_mib?: number;
  image?: string | null;
}

/**
 * A Mastra workspace sandbox backed by a smolmachines microVM.
 *
 * @example
 * ```typescript
 * import { Workspace } from '@mastra/core/workspace';
 * import { SmolmachinesSandbox } from '@mastra/smolmachines';
 *
 * const workspace = new Workspace({
 *   sandbox: new SmolmachinesSandbox({ image: 'node:22-slim', allowHosts: ['registry.npmjs.org'] }),
 * });
 * ```
 */
export class SmolmachinesSandbox extends MastraSandbox {
  readonly id: string;
  readonly name = 'SmolmachinesSandbox';
  readonly provider = 'smolmachines';
  status: ProviderStatus = 'pending';
  override readonly supportsCheckpoints = true;

  private readonly _machineName: string;
  private readonly _image: string;
  private readonly _cpus?: number;
  private readonly _memoryMb?: number;
  private readonly _network: boolean;
  private readonly _allowHosts: string[];
  private readonly _allowCidrs: string[];
  private readonly _volumes: Record<string, string>;
  private readonly _ports: string[];
  private readonly _timeout: number;
  private readonly _deleteOnDestroy: boolean;
  private readonly _labels: Record<string, string>;
  private readonly _configHash: string;
  private readonly _checkpointName?: string;
  private readonly _seedCheckpointName?: string;
  private readonly _checkpointsDirectory: string;
  private readonly _runner: SmolvmCommandRunner;
  private readonly _instructionsOverride?: InstructionsOption;
  private readonly _createdAt = new Date();
  private readonly _constructorOptions: SmolmachinesSandboxOptions;
  private _snapshotChain: Promise<void> = Promise.resolve();

  override get workingDirectory(): string {
    return this._workingDirectory!;
  }

  constructor(options: SmolmachinesSandboxOptions = {}) {
    super({ ...options, name: 'SmolmachinesSandbox' });
    this.id = options.id ?? `sandbox-${randomUUID().slice(0, 12)}`;
    this._machineName = sanitizeMachineName(options.name ?? `mastra-${this.id}`);
    this._image = options.image ?? DEFAULT_IMAGE;
    this._cpus = options.cpus;
    this._memoryMb = options.memoryMb;
    this._allowHosts = options.allowHosts ?? [];
    this._allowCidrs = options.allowCidrs ?? [];
    this._network = options.network ?? true;
    this._volumes = options.volumes ?? {};
    this._ports = options.ports ?? [];
    this._timeout = options.timeout ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this._deleteOnDestroy = options.deleteOnDestroy ?? true;
    this._checkpointName = options.checkpointName && validateCheckpointName(options.checkpointName);
    this._seedCheckpointName = options.seedCheckpointName && validateCheckpointName(options.seedCheckpointName);
    this._checkpointsDirectory = options.checkpointsDirectory ?? join(homedir(), '.mastra', 'smolmachines-checkpoints');
    this._runner = options.runner ?? new DefaultSmolvmCommandRunner(options.binary);
    this._instructionsOverride = options.instructions;
    this._constructorOptions = { ...options };
    this.setWorkingDirectory(options.workingDirectory ?? options.workingDir ?? DEFAULT_WORKING_DIR);
    this._configHash = hashConfig({
      image: this._image,
      cpus: this._cpus,
      memoryMb: this._memoryMb,
      network: this._network,
      allowHosts: this._allowHosts,
      allowCidrs: this._allowCidrs,
      volumes: this._volumes,
      ports: this._ports,
    });
    this._labels = {
      ...(options.labels ?? {}),
      'mastra.sandbox': 'true',
      'mastra.sandbox.id': this.id,
      'mastra.sandbox.config-hash': this._configHash,
    };
  }

  /**
   * A sibling sandbox with this one's configuration and its own id. No I/O:
   * the clone creates (or reconnects to) its own machine on `start()`.
   */
  clone(options: SandboxCloneOptions = {}): SmolmachinesSandbox {
    const { id: _id, name: _name, ...base } = this._constructorOptions;
    return new SmolmachinesSandbox({
      ...base,
      ...(options.id !== undefined && { id: options.id }),
      ...(options.env !== undefined && { env: options.env as Record<string, string> }),
    });
  }

  /** The smolmachines machine backing this sandbox. */
  get machineName(): string {
    return this._machineName;
  }

  async start(): Promise<void> {
    await this._runLifecycle('starting', 'running', () => this._startMachine());
  }

  async stop(): Promise<void> {
    await this._runLifecycle('stopping', 'stopped', () => this._stopMachine());
  }

  async destroy(): Promise<void> {
    await this._runLifecycle('destroying', 'destroyed', () => this._destroyMachine());
  }

  /**
   * Save the whole machine (disks, memory and running processes) as the
   * `checkpointName` checkpoint, which later sandboxes boot from. No-op
   * without a `checkpointName`. Concurrent calls run one after another.
   */
  override async snapshot(): Promise<void> {
    if (!this._checkpointName) return;
    const name = this._checkpointName;
    const run = this._snapshotChain.then(() => this._captureCheckpoint(name));
    this._snapshotChain = run.catch(() => {});
    return run;
  }

  async executeCommand(
    command: string,
    args: string[] = [],
    options: ExecuteCommandOptions = {},
  ): Promise<CommandResult> {
    await this.ensureRunning();

    const timeout = options.timeout ?? this._timeout;
    const hasTimeout = Number.isFinite(timeout) && timeout > 0;
    const fullCommand = buildShellCommand(command, args);
    const env = envFlags({ ...this.getEnv(), ...options.env });
    const group = randomUUID();
    const cliArgs = [
      'machine',
      'exec',
      '--name',
      this._machineName,
      '--stream',
      ...env.args,
      '-w',
      options.cwd ?? this.workingDirectory,
      ...(hasTimeout ? ['--timeout', `${Math.ceil(timeout)}ms`] : []),
      '--',
      'sh',
      '-c',
      GROUP_WRAPPER,
      'mastra-smolmachines',
      group,
      fullCommand,
    ];

    // Ending the CLI does not end the command in the machine, so an abort
    // ends the command's process group there as well.
    const abort = options.abortSignal;
    const onAbort = () => void this._killGroup(group);
    abort?.addEventListener('abort', onAbort, { once: true });
    let result: SmolvmCliResult;
    try {
      result = await this._runner.run(cliArgs, {
        timeout: hasTimeout ? timeout + CLI_GRACE_TIMEOUT_MS : undefined,
        env: env.env,
        abortSignal: abort,
        onStdout: options.onStdout,
        onStderr: options.onStderr,
        maxRetainedBytes: options.maxRetainedBytes,
      });
    } finally {
      abort?.removeEventListener('abort', onAbort);
    }
    if (result.killed) {
      await this._killGroup(group);
    }

    // A timed-out command exits 124. Streaming prints no message for it, so
    // the deadline tells a timeout from a command that exits 124 itself.
    const timedOut =
      hasTimeout &&
      result.exitCode === TIMEOUT_EXIT_CODE &&
      (hasTimeoutMessage(result.stderr) || result.executionTimeMs >= timeout);
    return {
      ...result,
      stderr: timedOut ? stripTimeoutMessage(result.stderr) : result.stderr,
      ...(timedOut && { timedOut: true, killed: true }),
      command: fullCommand,
      args,
    };
  }

  async getInfo(): Promise<SandboxInfo> {
    const machine = await this._findMachine();
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: this._createdAt,
      resources: machine
        ? {
            cpuCores: machine.cpus,
            memoryMB: machine.memory_mib,
          }
        : undefined,
      metadata: {
        machine: this._machineName,
        image: this._image,
        network: this._network,
        ...(this._allowHosts.length > 0 && { allowHosts: this._allowHosts }),
        ...(this._allowCidrs.length > 0 && { allowCidrs: this._allowCidrs }),
        ...(this._checkpointName && { checkpointName: this._checkpointName }),
      },
    };
  }

  getInstructions(opts?: { requestContext?: RequestContext }): string {
    const defaultInstructions = this._buildDefaultInstructions();
    if (typeof this._instructionsOverride === 'string') return this._instructionsOverride;
    if (typeof this._instructionsOverride === 'function') {
      return this._instructionsOverride({ defaultInstructions, requestContext: opts?.requestContext });
    }
    return defaultInstructions;
  }

  // ---------------------------------------------------------------------------
  // Machine lifecycle
  // ---------------------------------------------------------------------------

  private async _startMachine(): Promise<void> {
    const existing = await this._findMachine();
    if (existing) {
      this._assertOwned(existing);
      if (existing.state !== 'running') {
        this._assertSuccess(await this._cli(['machine', 'start', '--name', this._machineName]), 'start machine');
      }
    } else {
      await this._createMachine();
    }
    // A direct exec: executeCommand() would wait for this very start.
    const made = await this._cli(
      ['machine', 'exec', '--name', this._machineName, '-w', '/', '--', 'mkdir', '-p', this.workingDirectory],
      60_000,
    );
    this._assertSuccess(made, `create working directory ${this.workingDirectory} in`);
  }

  private async _createMachine(): Promise<void> {
    const labels = Object.entries(this._labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    const seed = this._bootCheckpoint();
    const args = seed
      ? ['machine', 'create', '--name', this._machineName, '--from', seed, ...labels]
      : ['machine', 'create', '--name', this._machineName, '--image', this._image, ...labels, ...this._resourceArgs()];
    this._assertSuccess(await this._cli(args, LIFECYCLE_TIMEOUT_MS), 'create machine');
    const started = await this._cli(['machine', 'start', '--name', this._machineName], LIFECYCLE_TIMEOUT_MS);
    if (!started.success) {
      if (this._deleteOnDestroy) {
        await this._cli(['machine', 'delete', '--name', this._machineName, '-f']);
      }
      this._assertSuccess(started, 'start machine');
    }
  }

  private _resourceArgs(): string[] {
    const args: string[] = [];
    if (this._cpus !== undefined) args.push('--cpus', String(this._cpus));
    if (this._memoryMb !== undefined) args.push('--mem', String(this._memoryMb));
    const restricted = this._allowHosts.length > 0 || this._allowCidrs.length > 0;
    if (this._network || restricted) args.push('--net');
    for (const host of this._allowHosts) args.push('--allow-host-pattern', host);
    for (const cidr of this._allowCidrs) args.push('--allow-cidr', cidr);
    for (const [host, guest] of Object.entries(this._volumes)) args.push('-v', `${host}:${guest}`);
    for (const port of this._ports) args.push('-p', port);
    return args;
  }

  private async _stopMachine(): Promise<void> {
    const existing = await this._findMachine();
    if (!existing || existing.state !== 'running') return;
    this._assertOwned(existing);
    this._assertSuccess(await this._cli(['machine', 'stop', '--name', this._machineName]), 'stop machine');
  }

  private async _destroyMachine(): Promise<void> {
    if (!this._deleteOnDestroy) {
      await this._stopMachine();
      return;
    }
    const existing = await this._findMachine();
    if (!existing) return;
    this._assertOwned(existing);
    const result = await this._cli(['machine', 'delete', '--name', this._machineName, '-f']);
    if (!result.success && !isMissingMachine(result.stderr)) {
      this._assertSuccess(result, 'delete machine');
    }
  }

  private async _findMachine(): Promise<SmolvmMachine | undefined> {
    const result = await this._cli(['machine', 'ls', '--json']);
    this._assertSuccess(result, 'list machines');
    const parsed = JSON.parse(result.stdout || '[]') as SmolvmMachine[] | { machines?: SmolvmMachine[] };
    const machines = Array.isArray(parsed) ? parsed : (parsed.machines ?? []);
    return machines.find(machine => machine.name === this._machineName);
  }

  /** Refuse to adopt a machine this sandbox didn't create, or created differently. */
  private _assertOwned(machine: SmolvmMachine): void {
    const labels = machine.labels ?? {};
    if (labels['mastra.sandbox'] !== 'true' || labels['mastra.sandbox.id'] !== this.id) {
      throw new Error(
        `smolmachines machine '${this._machineName}' exists but was not created by Mastra sandbox '${this.id}'`,
      );
    }
    const hash = labels['mastra.sandbox.config-hash'];
    if (hash && hash !== this._configHash && !this._bootCheckpoint()) {
      throw new Error(
        `smolmachines machine '${this._machineName}' was created with a different configuration; destroy it or use another sandbox id`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  private _checkpointPath(name: string): string {
    return join(this._checkpointsDirectory, `${name}.smolcheckpoint`);
  }

  /** The checkpoint a new machine boots from, if one is saved. */
  private _bootCheckpoint(): string | undefined {
    for (const name of [this._checkpointName, this._seedCheckpointName]) {
      if (name && existsSync(this._checkpointPath(name))) return this._checkpointPath(name);
    }
    return undefined;
  }

  private async _captureCheckpoint(name: string): Promise<void> {
    await this.ensureRunning();
    await mkdir(this._checkpointsDirectory, { recursive: true });
    const target = this._checkpointPath(name);
    // The CLI never overwrites; publish the new checkpoint by rename so a
    // concurrent boot always reads a complete one.
    const partial = join(this._checkpointsDirectory, `.${name}.${randomUUID()}.smolcheckpoint`);
    try {
      this._assertSuccess(
        await this._cli(['machine', 'checkpoint', '--name', this._machineName, '-o', partial], LIFECYCLE_TIMEOUT_MS),
        'checkpoint machine',
      );
      await rename(partial, target);
    } finally {
      await rm(partial, { force: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** End a command's process group in the machine. Best effort. */
  private async _killGroup(group: string): Promise<void> {
    const file = `${PROCESS_GROUP_DIR}/${group}`;
    const script = `p=$(cat ${file} 2>/dev/null) || exit 0; kill -TERM -"$p" "$p" 2>/dev/null; sleep 1; kill -KILL -"$p" "$p" 2>/dev/null; rm -f ${file}; true`;
    await this._cli(['machine', 'exec', '--name', this._machineName, '--', 'sh', '-c', script], 30_000).catch(
      () => undefined,
    );
  }

  private _buildDefaultInstructions(): string {
    const parts = [
      `smolmachines sandbox: commands run inside a local microVM (its own Linux kernel) booted from image ${this._image}.`,
      `Working directory: ${this.workingDirectory}.`,
    ];
    if (this._allowHosts.length > 0 || this._allowCidrs.length > 0) {
      parts.push(
        `Outbound network is limited to: ${[...this._allowHosts, ...this._allowCidrs].join(', ')}; other hosts are blocked.`,
      );
    } else if (!this._network) {
      parts.push('There is no outbound network access.');
    }
    if (this._timeout > 0) parts.push(`Default command timeout: ${Math.ceil(this._timeout / 1000)}s.`);
    return parts.join(' ');
  }

  private async _runLifecycle(
    active: ProviderStatus,
    settled: ProviderStatus,
    action: () => Promise<void>,
  ): Promise<void> {
    this.status = active;
    try {
      await action();
      this.status = settled;
    } catch (error) {
      this.status = 'error';
      throw error;
    }
  }

  private _cli(args: string[], timeout = this._timeout): Promise<SmolvmCliResult> {
    return this._runner.run(args, { timeout });
  }

  private _assertSuccess(result: SmolvmCliResult, action: string): void {
    if (!result.success) {
      const detail = (result.stderr || result.stdout).trim();
      throw new SandboxExecutionError(
        `smolmachines failed to ${action} '${this._machineName}'${detail ? `: ${detail}` : ''}`,
        result.exitCode,
        result.stdout,
        result.stderr,
      );
    }
  }
}

/**
 * Runs `$2` in its own session and records the session's process group, so an
 * aborted command can be ended with everything it started. `$1` names the
 * record. Falls back to a plain child where the image lacks `setsid`.
 */
const GROUP_WRAPPER = [
  `d=${PROCESS_GROUP_DIR}; mkdir -p "$d" 2>/dev/null; f="$d/$1"`,
  'if command -v setsid >/dev/null 2>&1; then setsid sh -c "$2" & else sh -c "$2" & fi',
  'child=$!; echo "$child" > "$f" 2>/dev/null',
  'wait "$child"; code=$?',
  'rm -f "$f"',
  'exit "$code"',
].join('; ');

class SmolvmCliProcess extends ProcessHandle {
  readonly pid: string;
  exitCode: number | undefined;

  private readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private readonly waitPromise: Promise<SmolvmCliResult>;
  private readonly startedAt = Date.now();
  private killed = false;
  private timedOut = false;
  private forceKillTimeout: NodeJS.Timeout | undefined;

  constructor(binary: string, args: string[], options: SmolvmCommandRunnerOptions = {}) {
    super({ maxRetainedBytes: options.maxRetainedBytes, onStdout: options.onStdout, onStderr: options.onStderr });
    this.child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    this.pid = this.child.pid ? String(this.child.pid) : `${binary}:${args[0] ?? ''}`;

    const stdoutDecoder = new StringDecoder();
    const stderrDecoder = new StringDecoder();
    let timeout: NodeJS.Timeout | undefined;
    const onAbort = (): void => void this.kill();
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (this.forceKillTimeout) clearTimeout(this.forceKillTimeout);
      options.abortSignal?.removeEventListener('abort', onAbort);
    };
    const flush = (): void => {
      const out = stdoutDecoder.end();
      if (out) this.emitStdout(out);
      const err = stderrDecoder.end();
      if (err) this.emitStderr(err);
    };

    this.waitPromise = new Promise((resolve, reject) => {
      let settled = false;
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        flush();
        callback();
      };
      this.child.stdout.on('data', (chunk: Buffer) => {
        const data = stdoutDecoder.write(chunk);
        if (data) this.emitStdout(data);
      });
      this.child.stderr.on('data', (chunk: Buffer) => {
        const data = stderrDecoder.write(chunk);
        if (data) this.emitStderr(data);
      });
      this.child.on('error', error => {
        settle(() =>
          reject(
            'code' in error && error.code === 'ENOENT'
              ? new SandboxExecutionError(
                  `smolvm CLI not found: ${binary}. Install smolmachines: https://smolmachines.com`,
                  127,
                  this.stdout,
                  error.message,
                )
              : error,
          ),
        );
      });
      this.child.on('close', code => {
        settle(() => {
          const exitCode = code ?? (this.killed ? 137 : 1);
          this.exitCode = exitCode;
          resolve({
            success: exitCode === 0,
            exitCode,
            stdout: this.stdout,
            stderr: this.stderr,
            executionTimeMs: Date.now() - this.startedAt,
            killed: this.killed,
            timedOut: this.timedOut,
          });
        });
      });
    });

    if (options.timeout && options.timeout > 0) {
      timeout = setTimeout(() => {
        this.timedOut = true;
        void this.kill();
      }, options.timeout);
    }
    if (options.abortSignal?.aborted) {
      void this.kill();
    } else {
      options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    }
  }

  async wait(): Promise<SmolvmCliResult> {
    return this.waitPromise;
  }

  async kill(): Promise<boolean> {
    if (this.exitCode !== undefined || this.child.killed) return false;
    this.killed = true;
    this.child.kill('SIGTERM');
    this.forceKillTimeout = setTimeout(() => {
      if (this.exitCode === undefined && this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill('SIGKILL');
      }
    }, 1000);
    this.forceKillTimeout.unref();
    return true;
  }

  async sendStdin(): Promise<void> {
    throw new Error('The smolvm CLI runner does not support stdin');
  }
}

function sanitizeMachineName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized.slice(0, 63) || 'mastra-sandbox';
}

function validateCheckpointName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    throw new Error(`Invalid checkpoint name: ${name}`);
  }
  return name;
}

function buildShellCommand(command: string, args: string[]): string {
  return args.length > 0 ? [command, ...args].map(shellQuote).join(' ') : command;
}

function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9._\-/=:@]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Pass env by name only (`-e KEY`), with values in the CLI's own environment,
 * so values never appear in the host's process list.
 */
function envFlags(env: Record<string, string | undefined>): { args: string[]; env: Record<string, string> } {
  const args: string[] = [];
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name for a smolmachines command: ${key}`);
    }
    args.push('-e', key);
    childEnv[key] = value;
  }
  return { args, env: childEnv };
}

function hasTimeoutMessage(stderr: string): boolean {
  return stderr.split('\n').some(line => TIMEOUT_MESSAGE.test(line.trim()));
}

function stripTimeoutMessage(stderr: string): string {
  return stderr
    .split('\n')
    .filter(line => !TIMEOUT_MESSAGE.test(line.trim()))
    .join('\n');
}

function isMissingMachine(message: string): boolean {
  return /not found|no such|does not exist/i.test(message);
}

function hashConfig(config: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
