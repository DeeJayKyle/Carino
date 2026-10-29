import type { Services } from '../../context.ts';
import type { ToolSpec } from '../../ai/types.ts';
import { z } from 'zod';
import { getSettings } from '../settings.ts';
import { connectedProviders } from './accounts.ts';
import type { AppToolDef } from './common.ts';
import { GOOGLE_TOOLS } from './google.ts';
import { MICROSOFT_TOOLS } from './microsoft.ts';
import { SOCIAL_TOOLS } from './social.ts';

export const APP_TOOLS: AppToolDef[] = [...GOOGLE_TOOLS, ...MICROSOFT_TOOLS, ...SOCIAL_TOOLS];
export const APP_TOOL_MAP = new Map(APP_TOOLS.map((t) => [t.name, t]));

/** A My apps tool, only while its app is connected. */
export function findAppTool(services: Services, userId: string, name: string): AppToolDef | undefined {
  const t = APP_TOOL_MAP.get(name);
  return t && connectedProviders(services, userId).has(t.provider) ? t : undefined;
}

/** Tool specs for the apps the user has connected, minus tools they switched off. */
export function appToolSpecs(services: Services, userId: string): ToolSpec[] {
  const connected = connectedProviders(services, userId);
  if (!connected.size) return [];
  const modes = getSettings(services.db, userId).permissions.tools;
  return APP_TOOLS.filter((t) => connected.has(t.provider) && modes[t.name] !== 'off').map((t) => {
    const schema = z.toJSONSchema(t.input, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
    delete schema.$schema;
    const queued = t.risk === 'consequential' || (t.risk !== 'read' && modes[t.name] !== 'auto');
    return { name: t.name, description: `${t.description}${queued ? ' (Queued for the user to approve — not executed immediately.)' : ''}`, input_schema: schema };
  });
}

export { AppError } from './accounts.ts';
