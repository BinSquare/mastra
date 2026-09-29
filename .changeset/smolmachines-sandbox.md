---
'@mastra/smolmachines': minor
---

Added `@mastra/smolmachines`, a workspace sandbox that runs commands in local microVMs, each with its own Linux kernel, through the smolmachines `smolvm` CLI. It supports egress allow lists enforced outside the machine, reconnecting to a machine by sandbox ID, and checkpoints that save the whole machine (disks, memory and running processes) for new sandboxes to boot from.

```typescript
import { Workspace } from '@mastra/core/workspace';
import { SmolmachinesSandbox } from '@mastra/smolmachines';

const workspace = new Workspace({
  sandbox: new SmolmachinesSandbox({
    image: 'node:22-slim',
    allowHosts: ['registry.npmjs.org'],
    checkpointName: 'node-deps',
  }),
});
```
