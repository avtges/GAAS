export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = "error",
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what = "Resource") => new AppError(404, `${what} not found`, "not_found");
export const forbidden = (why = "You do not have access to this resource") => new AppError(403, why, "forbidden");
export const badRequest = (why: string) => new AppError(400, why, "bad_request");
