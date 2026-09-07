import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ApiRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
  body: any;
  cookies?: Record<string, string>;
}

export interface ApiResponse extends ServerResponse {
  status(code: number): ApiResponse;
  json(data: any): ApiResponse;
  send(data: any): ApiResponse;
  redirect(url: string): ApiResponse;
  redirect(status: number, url: string): ApiResponse;
}

export type NodeApiRequest = ApiRequest;
export type NodeApiResponse = ApiResponse;
