import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ApiRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
  /**
   * Corps déjà lu par l'adaptateur (objet JSON, texte, Buffer) ou absent :
   * venu du client, toujours à valider (`bodyFields`, `readJsonBody`).
   */
  body: unknown;
  cookies?: Record<string, string>;
  /** X-Request-ID de la requête (serveur de prod seulement), à relayer aux services amont. */
  requestId?: string;
}

export interface ApiResponse extends ServerResponse {
  status(code: number): ApiResponse;
  json(data: unknown): ApiResponse;
  send(data: unknown): ApiResponse;
  redirect(url: string): ApiResponse;
  redirect(status: number, url: string): ApiResponse;
}

export type NodeApiRequest = ApiRequest;
export type NodeApiResponse = ApiResponse;
