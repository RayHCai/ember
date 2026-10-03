import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 4006);
await buildApp().listen({ port, host: '0.0.0.0' });
