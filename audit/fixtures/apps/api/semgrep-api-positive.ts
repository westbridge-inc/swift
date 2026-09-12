declare const app: any;

// ruleid: swift-math-random-server
const sample = Math.random();

// ruleid: swift-fastify-route-without-schema
app.post('/unsafe', async () => ({ sample }));

// ok: swift-fastify-route-without-schema
app.post('/validated', { schema: { body: { type: 'object' } } }, async () => ({ sample }));
