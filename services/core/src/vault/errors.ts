export class HttpError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : "Request validation failed");
    this.status = status;
    this.detail = detail;
  }
}
