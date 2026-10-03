import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 4003);
await buildApp().listen({ port, host: '0.0.0.0' });
