# @mastra/smolmachines

smolmachines microVM sandbox provider for [Mastra](https://mastra.ai) workspaces.

Implements the `WorkspaceSandbox` interface with the [smolmachines](https://smolmachines.com) `smolvm` CLI. Each sandbox is a local microVM with its own Linux kernel, booted from an OCI image, and workspace commands run through `smolvm machine exec`. Egress can be limited to named hosts, and `snapshot()` saves the whole machine (disks, memory and running processes) for new sandboxes to boot from.

## Installation

Install the `smolvm` CLI (Linux with KVM, or macOS on Apple silicon), then the provider:

```bash
curl -sSL https://smolmachines.com/install.sh | bash
npm install @mastra/smolmachines
```

## Usage

```typescript
import { Workspace } from '@mastra/core/workspace';
import { SmolmachinesSandbox } from '@mastra/smolmachines';

const sandbox = new SmolmachinesSandbox({
  image: 'node:22-slim',
  allowHosts: ['registry.npmjs.org'],
});

const workspace = new Workspace({ sandbox });
await workspace.init();

const result = await workspace.sandbox?.executeCommand?.('node', ['--version']);
console.log(result?.stdout);

await workspace.destroy();
```

## Documentation

- [smolmachines integration guide](https://mastra.ai/integrations/sandboxes/smolmachines)
- [Workspace documentation](https://mastra.ai/docs/mastra-platform/workspaces)

## Changelog

See the [package changelog](https://github.com/mastra-ai/mastra/blob/main/workspaces/smolmachines/CHANGELOG.md) for version history and release notes.

## Support

We have an [open community Discord](https://discord.gg/mastra-ai). Come and say hello and let us know if you have any questions or need any help getting things running.
