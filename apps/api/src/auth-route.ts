import type { FastifyInstance } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";
import { authUiLocation } from "./auth-ui-location.js";
import { config } from "./config.js";

export function registerAuthRoute(app: FastifyInstance) {
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const url = new URL(
        request.url,
        `http://${request.headers.host ?? "localhost"}`,
      );
      const response = await auth.handler(
        new Request(url, {
          method: request.method,
          headers: fromNodeHeaders(request.headers),
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }),
      );

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== "set-cookie")
          reply.header(key, key === "location" ? authUiLocation(value, config.WEB_URL) : value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header("set-cookie", cookies);

      return reply.send(response.body ? await response.text() : null);
    },
  });
}
