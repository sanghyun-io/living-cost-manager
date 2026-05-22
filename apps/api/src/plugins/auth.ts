import jwt from "@fastify/jwt";
import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

const jwtIssuer = "living-cost-manager-api";
const jwtAudience = "living-cost-manager";

const jwtPayloadSchema = z.object({
  sub: z.string().min(1),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  iss: z.literal(jwtIssuer),
  aud: z.literal(jwtAudience)
});

type AuthenticatedJwtPayload = z.infer<typeof jwtPayloadSchema>;

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
    };
    user: AuthenticatedJwtPayload;
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
    secret: options.secret,
    sign: {
      expiresIn: "7d",
      iss: jwtIssuer,
      aud: jwtAudience
    },
    verify: {
      allowedIss: jwtIssuer,
      allowedAud: jwtAudience,
      requiredClaims: ["sub", "exp", "iat", "iss", "aud"]
    }
  });

  app.decorate("authenticate", async (request: FastifyRequest) => {
    await request.jwtVerify();
    const parsedPayload = jwtPayloadSchema.safeParse(request.user);

    if (!parsedPayload.success) {
      throw app.httpErrors.unauthorized("Invalid token");
    }

    request.user = parsedPayload.data;
  });
});
