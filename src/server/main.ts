import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4173);
if (process.env.NODE_ENV === 'production') {
  const { server } = createApp();
  server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  const { server } = createApp({ devMiddleware: vite.middlewares });
  server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
}
