import { z } from "zod";
import { workspaceDtoSchema } from "./workspace.js";

const idSchema = z.string().min(1);

export const registerRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(80),
});

export const loginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const userDtoSchema = z.object({
  id: idSchema,
  email: z.string().email(),
  name: z.string().min(1),
});

export const authResponseSchema = z.object({
  token: z.string().min(1),
  user: userDtoSchema,
  workspace: workspaceDtoSchema,
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type UserDto = z.infer<typeof userDtoSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
