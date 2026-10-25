import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';

export interface RegisterChatRoutesDeps extends RouteDeps<'db' | 'design' | 'http' | 'chat' | 'agents' | 'validation' | 'lifecycle' | 'paths'> {}

export function registerChatRoutes(app: Express, ctx: RegisterChatRoutesDeps) {
  const { db, design } = ctx;
  const { sendApiError } = ctx.http;
  const { testAgentConnection, getAgentDef, isKnownModel, sanitizeCustomModel } = ctx.agents;

  // ---- Connection tests (single-shot JSON; no SSE) ------------------------
  // Settings dialog uses these to verify the selected local agent works
  // without sending a real chat. Always return HTTP 200 with `ok: false` on
  // agent-caused failures so the web layer can render a categorized inline
  // status without unwrapping nested error envelopes; real 4xx/5xx here mean
  // a malformed request or daemon bug.
  app.post('/api/test/connection', async (req, res) => {
    const controller = new AbortController();
    const abortIfRequestAborted = () => {
      if ((req.aborted || !req.complete) && !res.writableEnded) {
        controller.abort();
      }
    };
    const abortIfResponseClosed = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.on('close', abortIfRequestAborted);
    res.on('close', abortIfResponseClosed);
    const body = req.body || {};
    try {
      if (body.mode === 'agent') {
        if (typeof body.agentId !== 'string' || !body.agentId.trim()) {
          return sendApiError(res, 400, 'BAD_REQUEST', 'agentId is required');
        }
        try {
          const def = getAgentDef(body.agentId);
          const testStart = Date.now();
          const safeModel =
            def && typeof body.model === 'string'
              ? isKnownModel(def, body.model)
                ? body.model
                : sanitizeCustomModel(body.model)
              : undefined;
          if (def && typeof body.model === 'string' && body.model.trim() && !safeModel) {
            return res.json({
              ok: false,
              kind: 'invalid_model_id',
              latencyMs: Date.now() - testStart,
              model: body.model.trim(),
              agentName: def.name,
              detail: 'Invalid custom model id. Use a model id that starts with a letter or number and contains no spaces.',
            });
          }
          const safeReasoning =
            def &&
            typeof body.reasoning === 'string' &&
            Array.isArray(def.reasoningOptions)
              ? (def.reasoningOptions.find((r: any) => r.id === body.reasoning)?.id ?? undefined)
              : undefined;
          const result = await testAgentConnection({
            agentId: body.agentId,
            model: safeModel ?? undefined,
            reasoning: safeReasoning,
            agentCliEnv:
              body.agentCliEnv && typeof body.agentCliEnv === 'object'
                ? body.agentCliEnv
                : undefined,
            signal: controller.signal,
          });
          return res.json(result);
        } catch (err: any) {
          console.warn(
            `[test:agent] uncaught: ${err instanceof Error ? err.message : String(err)}`,
          );
          return sendApiError(res, 500, 'INTERNAL', 'Agent test failed');
        }
      }

      return sendApiError(
        res,
        400,
        'BAD_REQUEST',
        'mode must be agent',
      );
    } finally {
      req.off('close', abortIfRequestAborted);
      res.off('close', abortIfResponseClosed);
    }
  });

}
