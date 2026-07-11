type HttpMethod = "GET" | "PUT" | "POST" | "DELETE" | "PATCH";

/** A non-successful REST response with server and request context. */
export class ApiStatusError extends Error {
  readonly status: number;
  readonly serverMessage: string | null;
  readonly method: HttpMethod | "UNKNOWN";
  readonly path: string;

  constructor(
    status: number,
    serverMessage?: string | null,
    method: HttpMethod | "UNKNOWN" = "UNKNOWN",
    path = "",
  ) {
    super(serverMessage ?? `${status}`);
    this.name = "ApiStatusError";
    this.status = status;
    this.serverMessage = serverMessage ?? null;
    this.method = method;
    this.path = path;
  }
}
