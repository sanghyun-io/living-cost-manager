import jwt from "@fastify/jwt";
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
    };
    user: {
      sub: string;
    };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}

type AuthPluginOptions = {
  secret: string;
};

export const authPlugin = fp<AuthPluginOptions>(async (app, options) => {
  await app.register(jwt, {
    secret: options.secret
  });

  app.decorate("authenticate", async (request: FastifyRequest) => {
    await request.jwtVerify();
  });
});
