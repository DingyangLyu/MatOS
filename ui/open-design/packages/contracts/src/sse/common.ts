export interface SseTransportEvent<Name extends string, Payload> {
  id?: string;
  event: Name;
  data: Payload;
}
