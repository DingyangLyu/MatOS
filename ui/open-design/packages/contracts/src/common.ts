export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type BoundedJsonValue =
  | JsonPrimitive
  | BoundedJsonValue[]
  | { [key: string]: BoundedJsonValue };

export interface BoundedJsonObject {
  [key: string]: BoundedJsonValue;
}

export interface OkResponse {
  ok: true;
}
