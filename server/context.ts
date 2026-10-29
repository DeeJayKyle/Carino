import type { Db, Row } from './db/index.ts';
import type { Config } from './config.ts';
import type { ProviderRegistry } from './ai/providers.ts';
import type { SearchService } from './services/search.ts';
import type { PushService } from './services/push.ts';

export interface Services {
  db: Db;
  config: Config;
  providers: ProviderRegistry;
  search: SearchService;
  push: PushService;
  /** Injectable clock so scheduler and date parsing are testable. */
  now: () => Date;
  /** Fetch used for connected apps (MCP); tests may replace it. */
  mcpFetch?: typeof fetch;
  /** Fetch used for other outbound services (place search, messaging channels); tests may replace it. */
  netFetch?: typeof fetch;
  /** Phone app only: holds the session token, since in-app API calls carry no cookies. */
  deviceSession?: { get(): string | undefined; set(token: string | null): void };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

export type AppEnv = {
  Variables: {
    services: Services;
    user: SessionUser;
    sessionId: string;
  };
};

export type { Row };

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what = 'Item') => new HttpError(404, `${what} not found`, 'not_found');
export const badRequest = (msg: string) => new HttpError(400, msg, 'bad_request');
