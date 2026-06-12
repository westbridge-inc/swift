import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AiService } from './ai.service';

// Convenience endpoints only — the app is fully functional when these
// return { available: false }. Nothing here ever touches order/money state.

const searchIntentSchema = z.object({
  query: z.string().trim().min(3).max(300),
});

const menuPolishSchema = z.object({
  text: z.string().trim().min(3).max(1000),
});

export async function aiRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const ai = new AiService();

  /** POST /search-intent — NL query -> structured filters the app applies itself. */
  app.post('/search-intent', auth, async (request) => {
    const { query } = searchIntentSchema.parse(request.body);
    const intent = await ai.searchIntent(query);
    return {
      success: true,
      data: intent
        ? { available: true, intent }
        : { available: false, intent: null }, // graceful: client falls back to plain search
    };
  });

  /** POST /menu-polish — vendor menu-text cleanup suggestion. */
  app.post('/menu-polish', auth, async (request) => {
    const { text } = menuPolishSchema.parse(request.body);
    const polished = await ai.polishMenuText(text);
    return {
      success: true,
      data: polished
        ? { available: true, polished }
        : { available: false, polished: null },
    };
  });
}
