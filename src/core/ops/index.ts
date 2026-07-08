/**
 * Op registry assembly. REAL implementation (architect-owned). Builders add ops by filling
 * their module's `ops` array — this file does not change when ops are added, only when a new
 * module file is introduced (coordinator approval required).
 */
import { registeredOps, registerOps } from "./registry.ts";
import type { OpDefinition } from "./registry.ts";
import { ops as sessionOps } from "./session.ts";
import { ops as mailReadOps } from "./mail_read.ts";
import { ops as mailComposeOps } from "./mail_compose.ts";
import { ops as mailOrganizeOps } from "./mail_organize.ts";
import { ops as calendarOps } from "./calendar.ts";
import { ops as peopleOps } from "./people.ts";
import { ops as blobOps } from "./blobs.ts";
import { ops as notificationOps } from "./notifications.ts";
import { ops as caldavOps } from "./caldav.ts";
import { ops as adminOps } from "./admin.ts";
import { ops as syncOps } from "./sync.ts";
import { ops as rawOps } from "./raw.ts";

let assembled = false;

/**
 * Returns every op in the registry, assembling it on first call. Frontends filter by surface
 * (opsForSurface) and by gating flags (admin.* / sieve.* require config.enableAdminTools;
 * sync.* require config.enableSyncTools).
 */
export function allOps(): OpDefinition[] {
  if (!assembled) {
    registerOps([
      ...sessionOps,
      ...mailReadOps,
      ...mailComposeOps,
      ...mailOrganizeOps,
      ...calendarOps,
      ...peopleOps,
      ...blobOps,
      ...notificationOps,
      ...caldavOps,
      ...adminOps,
      ...syncOps,
      ...rawOps,
    ]);
    assembled = true;
  }
  return registeredOps();
}
