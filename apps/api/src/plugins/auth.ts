import jwt from "@fastify/jwt";
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const jwtIssuer = "living-cost-manager-api";
const jwtAudience = "living-cost-manager";

const accessPayloadSchema = z.object({
  sub: z.string().min(1),
  tokenVersion: z.number().int().nonnegative(),
  type: z.literal("access"),
  exp: z.number().int().positive(),
  iat: z.number().int().positive(),
  iss: z.literal(jwtIssuer),
  aud: z.literal(jwtAudience)
});

const refreshPayloadSchema = accessPayloadSchema.extend({
  type: z.literal("refresh")
});

type AccessJwtPayload = z.infer<typeof accessPayloadSchema>;

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
};

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      tokenVersion: number;
      type: "access" | "refresh";
    };
    user: AccessJwtPayload;
  }
}

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
    signTokens: (user: { id: string; tokenVersion: number }) => IssuedTokens;
    verifyRefreshToken: (token: string) => { sub: string; tokenVersion: number };
  }
}

type AuthPluginOptions = {
  secret: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
};

export const authPlugin = fp<AuthPluginOptions>(async (app, options) => {
  await app.register(jwt, {
    secret: options.secret,
    verify: {
      allowedIss: jwtIssuer,
      allowedAud: jwtAudience,
      requiredClaims: ["sub", "exp", "iat", "iss", "aud"]
    }
  });

  // Per-call sign options replace the plugin defaults entirely in fast-jwt, so
  // iss/aud must be passed on every sign call alongside expiresIn.
  app.decorate("signTokens", (user: { id: string; tokenVersion: number }): IssuedTokens => {
    const base = { sub: user.id, tokenVersion: user.tokenVersion };
    return {
      accessToken: app.jwt.sign(
        { ...base, type: "access" },
        { expiresIn: options.accessTtlSeconds, iss: jwtIssuer, aud: jwtAudience }
      ),
      refreshToken: app.jwt.sign(
        { ...base, type: "refresh" },
        { expiresIn: options.refreshTtlSeconds, iss: jwtIssuer, aud: jwtAudience }
      )
    };
  });

  app.decorate("verifyRefreshToken", (token: string): { sub: string; tokenVersion: number } => {
    let decoded: unknown;
    try {
      decoded = app.jwt.verify(token);
    } catch {
      throw app.httpErrors.unauthorized("Invalid token");
    }

    const parsed = refreshPayloadSchema.safeParse(decoded);
    if (!parsed.success) {
      throw app.httpErrors.unauthorized("Invalid token");
    }

    return { sub: parsed.data.sub, tokenVersion: parsed.data.tokenVersion };
  });

  app.decorate("authenticate", async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized("Invalid token");
    }

    const parsedPayload = accessPayloadSchema.safeParse(request.user);

    if (!parsedPayload.success) {
      throw app.httpErrors.unauthorized("Invalid token");
    }

    // tokenVersion must still match the user's current version (logout / password
    // change bumps it to invalidate all previously issued tokens).
    const user = await app.prisma.user.findUnique({
      where: { id: parsedPayload.data.sub },
      select: { tokenVersion: true }
    });

    if (!user || user.tokenVersion !== parsedPayload.data.tokenVersion) {
      throw app.httpErrors.unauthorized("Invalid token");
    }

    request.user = parsedPayload.data;
  });
});

export function isFastifyInstance(value: unknown): value is FastifyInstance {
  return typeof value === "object" && value !== null && "jwt" in value;
}
