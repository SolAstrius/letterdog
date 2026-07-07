import type { McpServer } from "@mcp/server/mcp";
import type { EnvConfig } from "../config.ts";
import { registerAdminTools } from "./admin.ts";
import { registerCalendarTools } from "./calendar.ts";
import { registerCalDavTools } from "./caldav.ts";
import { registerNotificationTools } from "./notifications.ts";
import { registerPrincipalTools } from "./principal.ts";
import { registerRawTools } from "./raw.ts";
import { registerSessionTools } from "./session.ts";

export function registerAllTools(server: McpServer, config: EnvConfig): void {
  registerSessionTools(server, config);
  registerCalendarTools(server, config);
  registerPrincipalTools(server, config);
  registerNotificationTools(server, config);
  registerCalDavTools(server, config);
  registerRawTools(server, config);
  registerAdminTools(server, config);
}
