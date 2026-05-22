import type { FastifyInstance } from "fastify";

import { listUserWorkspaces } from "../services/membership.js";

export async function workspaceRoutes(app: FastifyInstance) {
  app.get("/workspaces", { preHandler: app.authenticate }, async (request) => {
    return listUserWorkspaces(app.prisma, request.user.sub);
  });
}
