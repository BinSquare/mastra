/**
 * smolmachines sandbox provider descriptor for MastraEditor.
 */

import type { SandboxProvider } from '@mastra/core/editor';
import { SmolmachinesSandbox } from './sandbox';
import type { SmolmachinesSandboxOptions } from './sandbox';

export type SmolmachinesProviderConfig = Pick<
  SmolmachinesSandboxOptions,
  | 'id'
  | 'image'
  | 'name'
  | 'cpus'
  | 'memoryMb'
  | 'network'
  | 'allowHosts'
  | 'allowCidrs'
  | 'volumes'
  | 'ports'
  | 'env'
  | 'workingDir'
  | 'timeout'
  | 'deleteOnDestroy'
  | 'labels'
  | 'checkpointName'
  | 'seedCheckpointName'
  | 'checkpointsDirectory'
  | 'binary'
>;

export const smolmachinesSandboxProvider: SandboxProvider<SmolmachinesProviderConfig> = {
  id: 'smolmachines',
  name: 'smolmachines Sandbox',
  description: 'Local microVM sandbox with its own Linux kernel, powered by smolmachines',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', description: 'Stable sandbox ID used for reconnecting to the same machine.' },
      image: { type: 'string', description: 'OCI image the machine boots', default: 'node:22-slim' },
      name: { type: 'string', description: 'Machine name. Defaults to mastra-<id>.' },
      cpus: { type: 'number', description: 'Number of vCPUs' },
      memoryMb: { type: 'number', description: 'Memory in MiB' },
      network: { type: 'boolean', description: 'Outbound network access', default: true },
      allowHosts: {
        type: 'array',
        description: 'Allow egress only to these hosts (exact names or *.domain wildcards)',
        items: { type: 'string' },
      },
      allowCidrs: {
        type: 'array',
        description: 'Allow egress only to these CIDR ranges',
        items: { type: 'string' },
      },
      volumes: {
        type: 'object',
        description: 'Host-to-guest mounts (host path -> guest path)',
        additionalProperties: { type: 'string' },
      },
      ports: { type: 'array', description: 'Published ports (HOST:GUEST or PORT)', items: { type: 'string' } },
      env: { type: 'object', description: 'Environment variables', additionalProperties: { type: 'string' } },
      workingDir: { type: 'string', description: 'Working directory for commands', default: '/workspace' },
      timeout: { type: 'number', description: 'Default command timeout in milliseconds', default: 300_000 },
      deleteOnDestroy: { type: 'boolean', description: 'Delete the machine on destroy', default: true },
      labels: { type: 'object', description: 'Machine labels', additionalProperties: { type: 'string' } },
      checkpointName: {
        type: 'string',
        description: 'Checkpoint to boot a new machine from and to save on snapshot (disks, memory and processes)',
      },
      seedCheckpointName: {
        type: 'string',
        description: 'Checkpoint to boot from when checkpointName has none yet',
      },
      checkpointsDirectory: { type: 'string', description: 'Where checkpoints are stored' },
      binary: { type: 'string', description: 'Path to the smolvm CLI', default: 'smolvm' },
    },
  },
  createSandbox: config => new SmolmachinesSandbox({ ...config }),
};
