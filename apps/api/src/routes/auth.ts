import { Prisma } from "@prisma/client";
import {
  changePasswordRequestSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  refreshRequestSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailRequestSchema,
  type UserDto,
  type WorkspaceDto
} from "@living-cost-manager/shared";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { normalizeEmail } from "../services/email.js";
import { createToken, expiryFromNow, hashToken, isTokenUsable } from "../services/tokens.js";

type UserRecord = {
  id: string;
  email: string;
  name: string;
  tokenVersion: number;
  emailVerifiedAt: Date | null;
};

function toUserDto(user: UserRecord): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerifiedAt !== null
  };
}

function normalizeAuthBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || !("email" in body)) {
    return body;
  }

  const candidate = body as Record<string, unknown>;

  if (typeof candidate.email !== "string") {
    return body;
  }

  return {
    ...candidate,
    email: normalizeEmail(candidate.email)
  };
}

function parseAuthBody<TSchema extends z.ZodType>(
  app: FastifyInstance,
  schema: TSchema,
  body: unknown
): z.infer<TSchema> {
  const result = schema.safeParse(normalizeAuthBody(body));

  if (!result.success) {
    throw app.httpErrors.badRequest("Invalid request body");
  }

  return result.data;
}

// Tight limit for credential / token endpoints to slow down brute force.
function authRateLimit(app: FastifyInstance) {
  return {
    rateLimit: {
      max: 10,
      timeWindow: "1 minute"
    }
  };
}

async function issueVerificationEmail(app: FastifyInstance, user: { id: string; email: string }) {
  const { raw, hash } = createToken();
  await app.prisma.emailVerificationToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: expiryFromNow(app.appEnv.EMAIL_VERIFICATION_TTL)
    }
  });
  // Root path + query param so the static-export SPA (single / route) can handle it.
  const link = `${app.appEnv.APP_BASE_URL}/?verify_token=${encodeURIComponent(raw)}`;
  await app.email.sendVerification(user.email, link);
}

export async function authRoutes(app: FastifyInstance) {
  app.post(
    "/auth/register",
    { config: authRateLimit(app) },
    async (request, reply) => {
      const body = parseAuthBody(app, registerRequestSchema, request.body);
      const existingUser = await app.prisma.user.findUnique({
        where: { email: body.email },
        select: { id: true }
      });

      if (existingUser) {
        throw app.httpErrors.conflict("Email already registered");
      }

      const passwordHash = await argon2.hash(body.password);

      try {
        const result = await app.prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              email: body.email,
              name: body.name,
              passwordHash
            }
          });
          const workspace = await tx.workspace.create({
            data: { name: `${body.name}의 생활비` }
          });
          const membership = await tx.workspaceMember.create({
            data: {
              workspaceId: workspace.id,
              userId: user.id,
              role: "owner"
            }
          });

          return { user, workspace, membership };
        });

        const workspace: WorkspaceDto = {
          id: result.workspace.id,
          name: result.workspace.name,
          role: result.membership.role
        };

        // Email verification is optional: send the mail but do not block login.
        try {
          await issueVerificationEmail(app, result.user);
        } catch (mailError) {
          app.log.error({ err: mailError }, "verification email send failed");
        }

        const tokens = app.signTokens(result.user);
        return reply.code(201).send({
          ...tokens,
          user: toUserDto(result.user),
          workspace
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw app.httpErrors.conflict("Email already registered");
        }

        throw error;
      }
    }
  );

  app.post("/auth/login", { config: authRateLimit(app) }, async (request) => {
    const body = parseAuthBody(app, loginRequestSchema, request.body);
    const user = await app.prisma.user.findUnique({
      where: { email: body.email }
    });

    if (!user || !(await argon2.verify(user.passwordHash, body.password))) {
      throw app.httpErrors.unauthorized("Invalid credentials");
    }

    const tokens = app.signTokens(user);
    return {
      ...tokens,
      user: toUserDto(user)
    };
  });

  app.post("/auth/refresh", { config: authRateLimit(app) }, async (request) => {
    const body = parseAuthBody(app, refreshRequestSchema, request.body);
    const { sub, tokenVersion } = app.verifyRefreshToken(body.refreshToken);

    const user = await app.prisma.user.findUnique({ where: { id: sub } });
    if (!user || user.tokenVersion !== tokenVersion) {
      throw app.httpErrors.unauthorized("Invalid token");
    }

    const tokens = app.signTokens(user);
    return {
      ...tokens,
      user: toUserDto(user)
    };
  });

  app.post("/auth/logout", { preHandler: app.authenticate }, async (request) => {
    // Bump tokenVersion so every previously issued access/refresh token is rejected.
    await app.prisma.user.update({
      where: { id: request.user.sub },
      data: { tokenVersion: { increment: 1 } }
    });
    return { ok: true };
  });

  app.post(
    "/auth/change-password",
    { preHandler: app.authenticate },
    async (request) => {
      const body = parseAuthBody(app, changePasswordRequestSchema, request.body);
      const user = await app.prisma.user.findUnique({ where: { id: request.user.sub } });
      if (!user) {
        throw app.httpErrors.unauthorized("Invalid token");
      }

      if (!(await argon2.verify(user.passwordHash, body.currentPassword))) {
        throw app.httpErrors.unauthorized("Invalid credentials");
      }

      const passwordHash = await argon2.hash(body.newPassword);
      const updated = await app.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash, tokenVersion: { increment: 1 } }
      });

      // Re-issue tokens so the caller stays logged in with the new version.
      const tokens = app.signTokens(updated);
      return { ...tokens, user: toUserDto(updated) };
    }
  );

  app.post(
    "/auth/forgot-password",
    { config: authRateLimit(app) },
    async (request) => {
      const body = parseAuthBody(app, forgotPasswordRequestSchema, request.body);
      const user = await app.prisma.user.findUnique({ where: { email: body.email } });

      // Always respond the same way to avoid leaking which emails are registered.
      if (user) {
        // Invalidate any outstanding reset tokens, then issue a fresh one.
        await app.prisma.passwordResetToken.updateMany({
          where: { userId: user.id, usedAt: null },
          data: { usedAt: new Date() }
        });
        const { raw, hash } = createToken();
        await app.prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash: hash,
            expiresAt: expiryFromNow(app.appEnv.PASSWORD_RESET_TTL)
          }
        });
        const link = `${app.appEnv.APP_BASE_URL}/?reset_token=${encodeURIComponent(raw)}`;
        try {
          await app.email.sendPasswordReset(user.email, link);
        } catch (mailError) {
          app.log.error({ err: mailError }, "password reset email send failed");
        }
      }

      return { ok: true };
    }
  );

  app.post(
    "/auth/reset-password",
    { config: authRateLimit(app) },
    async (request) => {
      const body = parseAuthBody(app, resetPasswordRequestSchema, request.body);
      const record = await app.prisma.passwordResetToken.findUnique({
        where: { tokenHash: hashToken(body.token) }
      });

      if (!record || !isTokenUsable(record)) {
        throw app.httpErrors.badRequest("Invalid or expired token");
      }

      const passwordHash = await argon2.hash(body.password);
      await app.prisma.$transaction([
        app.prisma.user.update({
          where: { id: record.userId },
          data: { passwordHash, tokenVersion: { increment: 1 } }
        }),
        app.prisma.passwordResetToken.update({
          where: { id: record.id },
          data: { usedAt: new Date() }
        })
      ]);

      return { ok: true };
    }
  );

  app.post(
    "/auth/verify-email",
    { config: authRateLimit(app) },
    async (request) => {
      const body = parseAuthBody(app, verifyEmailRequestSchema, request.body);
      const record = await app.prisma.emailVerificationToken.findUnique({
        where: { tokenHash: hashToken(body.token) }
      });

      if (!record || !isTokenUsable(record)) {
        throw app.httpErrors.badRequest("Invalid or expired token");
      }

      await app.prisma.$transaction([
        app.prisma.user.update({
          where: { id: record.userId },
          data: { emailVerifiedAt: new Date() }
        }),
        app.prisma.emailVerificationToken.update({
          where: { id: record.id },
          data: { usedAt: new Date() }
        })
      ]);

      return { ok: true };
    }
  );

  app.post(
    "/auth/resend-verification",
    { preHandler: app.authenticate, config: authRateLimit(app) },
    async (request) => {
      const user = await app.prisma.user.findUnique({ where: { id: request.user.sub } });
      if (!user) {
        throw app.httpErrors.unauthorized("Invalid token");
      }
      if (user.emailVerifiedAt) {
        return { ok: true, alreadyVerified: true };
      }

      // Invalidate outstanding verification tokens before issuing a new one.
      await app.prisma.emailVerificationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() }
      });
      try {
        await issueVerificationEmail(app, user);
      } catch (mailError) {
        app.log.error({ err: mailError }, "verification email resend failed");
        throw app.httpErrors.internalServerError("Failed to send verification email");
      }

      return { ok: true };
    }
  );

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const user = await app.prisma.user.findUnique({
      where: { id: request.user.sub }
    });

    if (!user) {
      throw app.httpErrors.unauthorized("Invalid token");
    }

    return {
      user: toUserDto(user)
    };
  });
}
