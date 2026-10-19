import type express from "express";

type AsyncRoute = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => Promise<void>;

export function asyncHandler(handler: AsyncRoute): express.RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

export function getRequestUserId(req: express.Request, res: express.Response) {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }

  return req.userId;
}

export function getRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
