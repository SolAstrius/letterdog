import type { ToolExtra } from "../auth.ts";
import { buildActorContext } from "../auth.ts";
import { CalDavClient } from "../caldav.ts";
import type { EnvConfig } from "../config.ts";
import { JmapClient } from "../jmap.ts";

export interface ToolContext {
  config: EnvConfig;
  actor: Awaited<ReturnType<typeof buildActorContext>>;
  jmap: JmapClient;
  caldav: CalDavClient;
}

export async function buildToolContext(config: EnvConfig, extra: ToolExtra): Promise<ToolContext> {
  const actor = await buildActorContext(config, extra);
  return {
    config,
    actor,
    jmap: new JmapClient(config),
    caldav: new CalDavClient(config, actor.auth),
  };
}
