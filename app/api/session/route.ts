// Tells the UI what this browser may do: owner (all models, no limits) or public visitor.
import { MODELS } from "@/app/lib/models";
import {
  PUBLIC_MAX_MESSAGE_CHARS,
  PUBLIC_MODEL_ID,
  PUBLIC_REQUESTS_PER_WINDOW,
  OWNER_MAX_MESSAGE_CHARS,
  clientIp,
  isOwner,
  peekPublicRemaining,
} from "@/app/lib/access";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const owner = isOwner(req);
  const body = owner
    ? {
        owner: true,
        models: MODELS.map(({ id, name }) => ({ id, name })),
        maxMessageChars: OWNER_MAX_MESSAGE_CHARS,
        remaining: null,
        dailyLimit: null,
      }
    : {
        owner: false,
        models: MODELS.filter((m) => m.id === PUBLIC_MODEL_ID).map(({ id, name }) => ({ id, name })),
        maxMessageChars: PUBLIC_MAX_MESSAGE_CHARS,
        remaining: await peekPublicRemaining(clientIp(req)),
        dailyLimit: PUBLIC_REQUESTS_PER_WINDOW,
      };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
}
