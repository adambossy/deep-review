import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 3001);

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`deep-review server listening on http://localhost:${info.port}`);
});
