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
  emailVerified: z.boolean().optional(),
});

export const authResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  user: userDtoSchema,
  workspace: workspaceDtoSchema.optional(),
});

export const forgotPasswordRequestSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(8),
  newPassword: z.string().min(8),
});

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export const verifyEmailRequestSchema = z.object({
  token: z.string().min(1),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type UserDto = z.infer<typeof userDtoSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
