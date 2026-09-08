import { bootstrap } from '../../src/app/bootstrap.ts';

const app = await bootstrap({ homeDir: process.argv[2], namespace: 'concurrency', logLevel: 'error' });
try {
  for (let i = 0; i < 30; i++) {
    app.memory.add({ content: `writer ${process.argv[3]} row ${i}` });
    app.memory.add({ content: 'shared exact duplicate' });
    app.memory.search({ query: 'writer' });
  }
} finally { app.close(); }
