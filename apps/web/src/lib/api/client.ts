import type { paths } from "@/lib/contracts/rest.generated";
import { apiBase } from "@/lib/desktopRuntime";
import { ApiStatusError } from "./errors";

export { ApiStatusError } from "./errors";

type Method = "get" | "put" | "post" | "delete" | "patch";
type UpperMethod = Uppercase<Method>;
type PathFor<M extends Method> = {
  [P in keyof paths]: paths[P][M] extends undefined ? never : P;
}[keyof paths];
type Operation<P extends keyof paths, M extends Method> = NonNullable<
  paths[P][M]
>;
type Parameters<O> = O extends { parameters: infer V } ? V : never;
type ParameterOption<O, K extends "path" | "query"> =
  Parameters<O> extends infer P
    ? K extends keyof P
      ? [NonNullable<P[K]>] extends [never]
        ? { [N in K]?: never }
        : Pick<P, K> extends Required<Pick<P, K>>
          ? { [N in K]: P[K] }
          : { [N in K]?: NonNullable<P[K]> }
      : { [N in K]?: never }
    : { [N in K]?: never };
type BodyOption<O> = O extends {
  requestBody: { content: { "application/json": infer B } };
}
  ? { body: B; serializedBody?: string }
  : { body?: never; serializedBody?: never };
type RequestOptions<O> = ParameterOption<O, "path"> &
  ParameterOption<O, "query"> &
  BodyOption<O>;
type SuccessKey<R> = {
  [S in keyof R]: `${S & (string | number)}` extends `2${string}` ? S : never;
}[keyof R];
type JsonContent<R> = R extends {
  content: { "application/json": infer B };
}
  ? B
  : undefined;
type Result<O> = O extends { responses: infer R }
  ? JsonContent<R[SuccessKey<R>]>
  : never;

const BASE = apiBase();

async function apiErrorMessage(response: Response): Promise<string | null> {
  if (typeof response.json !== "function") return null;
  try {
    const payload = (await response.json()) as { message?: unknown };
    return typeof payload.message === "string" ? payload.message : null;
  } catch {
    return null;
  }
}

function buildUrl(
  template: string,
  path: Record<string, unknown> | undefined,
  query: Record<string, unknown> | undefined,
): { fetchUrl: string; requestPath: string } {
  let requestPath = template;
  for (const [name, value] of Object.entries(path ?? {})) {
    // Path params are user-controlled (branch names, theme ids); encode
    // here so no caller has to remember to.
    requestPath = requestPath.replace(
      `{${name}}`,
      encodeURIComponent(String(value)),
    );
  }
  if (query) {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) params.set(name, String(value));
    }
    requestPath += `?${params.toString()}`;
  }
  return { fetchUrl: `${BASE}${requestPath.slice(4)}`, requestPath };
}

async function request<U extends UpperMethod, P extends PathFor<Lowercase<U>>>(
  method: U,
  template: P,
  options: RequestOptions<Operation<P, Lowercase<U>>>,
): Promise<Response> {
  const values = options as {
    path?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: unknown;
    serializedBody?: string;
  };
  const { fetchUrl, requestPath } = buildUrl(
    template,
    values.path,
    values.query,
  );
  const init =
    method === "GET"
      ? undefined
      : {
          method,
          ...(values.body === undefined
            ? {}
            : {
                headers: { "Content-Type": "application/json" },
                body: values.serializedBody ?? JSON.stringify(values.body),
              }),
        };
  const response = init ? await fetch(fetchUrl, init) : await fetch(fetchUrl);
  if (!response.ok) {
    throw new ApiStatusError(
      response.status,
      await apiErrorMessage(response),
      method,
      requestPath,
    );
  }
  return response;
}

export async function requestJson<
  U extends UpperMethod,
  P extends PathFor<Lowercase<U>>,
>(
  method: U,
  path: P,
  options: RequestOptions<Operation<P, Lowercase<U>>>,
): Promise<Result<Operation<P, Lowercase<U>>>> {
  return (await request(method, path, options)).json();
}

export async function requestVoid<
  U extends UpperMethod,
  P extends PathFor<Lowercase<U>>,
>(
  method: U,
  path: P,
  options: RequestOptions<Operation<P, Lowercase<U>>>,
): Promise<void> {
  await request(method, path, options);
}

export type RequestBody<P extends keyof paths, M extends Method> =
  Operation<P, M> extends {
    requestBody: { content: { "application/json": infer B } };
  }
    ? B
    : never;
