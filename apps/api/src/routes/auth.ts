import { Prisma } from "@prisma/client";
import {
  loginRequestSchema,
  registerRequestSchema,
  type UserDto,
  type WorkspaceDto
} from "@living-cost-manager/shared";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";

function toUserDto(user: { id: string; email: string; name: string }): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name
  };
}

function signUserToken(app: FastifyInstance, userId: string): string {
  return app.jwt.sign({
    sub: userId
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (request, reply) => {
    const body = parseAuthBody(app, registerRequestSchema, request.body);
    const existingUser = await app.prisma.user.findUnique({
      where: {
        email: body.email
      },
      select: {
        id: true
      }
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
          data: {
            name: `${body.name}의 생활비`
          }
        });
        const membership = await tx.workspaceMember.create({
          data: {
            workspaceId: workspace.id,
            userId: user.id,
            role: "owner"
          }
        });

        return {
          user,
          workspace,
          membership
        };
      });
      const workspace: WorkspaceDto = {
        id: result.workspace.id,
        name: result.workspace.name,
        role: result.membership.role
      };

      return reply.code(201).send({
        token: signUserToken(app, result.user.id),
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
  });

  app.post("/auth/login", async (request) => {
    const body = parseAuthBody(app, loginRequestSchema, request.body);
    const user = await app.prisma.user.findUnique({
      where: {
        email: body.email
      }
    });

    if (!user || !(await argon2.verify(user.passwordHash, body.password))) {
      throw app.httpErrors.unauthorized("Invalid credentials");
    }

    return {
      token: signUserToken(app, user.id),
      user: toUserDto(user)
    };
  });

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const user = await app.prisma.user.findUnique({
      where: {
        id: request.user.sub
      }
    });

    if (!user) {
      throw app.httpErrors.unauthorized("Invalid token");
    }

    return {
      user: toUserDto(user)
    };
  });
}
