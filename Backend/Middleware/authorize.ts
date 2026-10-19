import { NextFunction, Request, Response } from "express";
import { createSupabaseClient } from "../client";
import { prisma } from "../db";

const client = createSupabaseClient();
export async function authorize(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : undefined;

  if (!token) {
    return res.status(401).json({ error: "Missing authorization token" });
  }

  const data = await client.auth.getUser(token);
  const authUser = data.data.user;
  const userId = authUser?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const email = authUser.email;
  if (!email) {
    return res.status(400).json({ error: "Authenticated user email is missing" });
  }

  if (userId) {
    try {
      const provider =
        authUser.app_metadata.provider === "google" ? "GOOGLE" : "GITHUB";

      const dbUser = await prisma.user.upsert({
        where: {
          email,
        },
        create: {
          supabaseId: userId,
          email,
          provider,
          name: authUser.user_metadata.full_name,
        },
        update: {
          supabaseId: userId,
          provider,
          name: authUser.user_metadata.full_name,
        },
      });
      req.userId = dbUser.id;
    } catch (error) {
      console.error("Failed to sync authenticated user", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  }
  next();
}
