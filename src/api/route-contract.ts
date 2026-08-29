/**
 * Runtime-safe HTTP contract metadata shared by routing, validation, and OpenAPI generation.
 *
 * Keep this module dependency-free so documentation scripts can import the same contracts the
 * Worker uses without pulling database or Cloudflare runtime code into Node.
 */

export type JsonSchemaScalarType =
  | "array"
  | "boolean"
  | "integer"
  | "null"
  | "number"
  | "object"
  | "string";

export interface JsonSchema {
  $ref?: string;
  type?: JsonSchemaScalarType | readonly JsonSchemaScalarType[];
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
}

export type QueryNormalization = "nfkc-space";

/** One accepted query-string parameter and the constraints enforced before parsing. */
export interface QueryParameterContract {
  name: string;
  type: "boolean" | "integer" | "string";
  description: string;
  required?: boolean;
  repeatable?: boolean;
  commaSeparated?: boolean;
  maxLength?: number;
  normalizedMaxLength?: number;
  normalize?: QueryNormalization;
  enum?: readonly string[];
  maxDigits?: number;
  minimum?: number;
  maximum?: number;
  maximumError?: string;
}

export interface RouteResponseContract {
  description: string;
  schema?: JsonSchema;
  contentType?: string;
}

export interface RouteContract {
  id: string;
  method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  path: string;
  summary: string;
  description?: string;
  tags?: readonly string[];
  query?: readonly QueryParameterContract[];
  responses: Readonly<Record<number, RouteResponseContract>>;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: string;
    version: string;
    description?: string;
  };
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas: Readonly<Record<string, JsonSchema>>;
  };
}

export function defineRoute<const T extends RouteContract>(route: T): T {
  return route;
}

export function normalizeQueryValue(value: string, normalization: QueryNormalization): string {
  if (normalization === "nfkc-space") {
    return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  }
  return value;
}

function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * Validate only constraints represented by contract metadata.
 *
 * Unknown parameters are rejected deliberately so arbitrary cache-buster keys cannot force new
 * edge-cache entries and D1 work for otherwise identical requests.
 */
export function validateQueryContract(
  url: URL,
  parameters: readonly QueryParameterContract[],
): string | null {
  const params = url.searchParams;
  const acceptedNames = new Set(parameters.map((parameter) => parameter.name));
  for (const key of params.keys()) {
    if (!acceptedNames.has(key)) return "parameter_unknown";
  }

  for (const parameter of parameters) {
    const values = params.getAll(parameter.name);
    if (!parameter.repeatable && values.length > 1) return `${parameter.name}_repeated`;
  }

  for (const parameter of parameters) {
    for (const value of params.getAll(parameter.name)) {
      if (parameter.maxLength != null && codePointLength(value) > parameter.maxLength) {
        return `${parameter.name}_too_long`;
      }
      if (parameter.normalize && parameter.normalizedMaxLength != null) {
        const normalized = normalizeQueryValue(value, parameter.normalize);
        if (codePointLength(normalized) > parameter.normalizedMaxLength) {
          return `${parameter.name}_too_long`;
        }
      }
    }
  }

  for (const parameter of parameters) {
    if (parameter.type !== "integer") continue;
    const value = params.get(parameter.name);
    if (value == null) continue;
    const maxDigits = parameter.maxDigits ?? 12;
    if (!new RegExp(`^\\d{1,${maxDigits}}$`, "u").test(value)) {
      return `${parameter.name}_invalid`;
    }
    const parsed = Number(value);
    if (parameter.minimum != null && parsed < parameter.minimum) {
      return `${parameter.name}_invalid`;
    }
    if (parameter.maximum != null && parsed > parameter.maximum) {
      return parameter.maximumError ?? `${parameter.name}_invalid`;
    }
  }

  for (const parameter of parameters) {
    if (parameter.type !== "boolean") continue;
    const value = params.get(parameter.name);
    if (value != null && value !== "true" && value !== "false") {
      return `${parameter.name}_invalid`;
    }
  }

  for (const parameter of parameters) {
    if (!parameter.enum) continue;
    const values = params
      .getAll(parameter.name)
      .flatMap((value) => (parameter.commaSeparated ? value.split(",") : [value]))
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.some((value) => !parameter.enum?.includes(value))) {
      return `${parameter.name}_invalid`;
    }
  }

  return null;
}

export function routeMatches(
  contract: RouteContract,
  request: Request,
  url = new URL(request.url),
): boolean {
  return request.method === contract.method && url.pathname === contract.path;
}

function scalarParameterSchema(parameter: QueryParameterContract): JsonSchema {
  const schema: JsonSchema = {
    type: parameter.type,
    description: parameter.description,
  };
  if (parameter.enum) schema.enum = parameter.enum;
  if (parameter.maxLength != null && parameter.type === "string") {
    schema.maxLength = parameter.maxLength;
  }
  if (parameter.minimum != null && parameter.type === "integer") {
    schema.minimum = parameter.minimum;
  }
  if (parameter.maximum != null && parameter.type === "integer") {
    schema.maximum = parameter.maximum;
  }
  return schema;
}

export function openApiQueryParameter(parameter: QueryParameterContract): Record<string, unknown> {
  const scalarSchema = scalarParameterSchema(parameter);
  const arrayLike = parameter.repeatable || parameter.commaSeparated;
  return {
    name: parameter.name,
    in: "query",
    required: parameter.required ?? false,
    description: parameter.description,
    ...(arrayLike ? { style: "form", explode: Boolean(parameter.repeatable) } : {}),
    schema: arrayLike ? { type: "array", items: scalarSchema } : scalarSchema,
  };
}

/** Generate an OpenAPI 3.1 document directly from the runtime route contracts. */
export function buildOpenApiDocument(
  routes: readonly RouteContract[],
  options: {
    title: string;
    version: string;
    description?: string;
    schemas?: Readonly<Record<string, JsonSchema>>;
  },
): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const pathItem = paths[route.path] ?? {};
    pathItem[route.method.toLowerCase()] = {
      operationId: route.id,
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      ...(route.tags ? { tags: route.tags } : {}),
      ...(route.query?.length
        ? { parameters: route.query.map((parameter) => openApiQueryParameter(parameter)) }
        : {}),
      responses: Object.fromEntries(
        Object.entries(route.responses).map(([status, response]) => [
          status,
          {
            description: response.description,
            ...(response.schema
              ? {
                  content: {
                    [response.contentType ?? "application/json"]: { schema: response.schema },
                  },
                }
              : {}),
          },
        ]),
      ),
    };
    paths[route.path] = pathItem;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options.title,
      version: options.version,
      ...(options.description ? { description: options.description } : {}),
    },
    paths,
    ...(options.schemas ? { components: { schemas: options.schemas } } : {}),
  };
}
