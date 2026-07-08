/**
 * Stalwart provider adapter — the first (and currently only) Provider.
 * CONTRACT STUB — TODO(builder: B6-provider). Bodies throw.
 *
 * Responsibilities:
 * - normalize.*: fold the v0.16 hybrid (participants: sendTo map OR calendarAddress string;
 *   events: replyTo map OR organizerCalendarAddress string) into the canonical shapes in
 *   provider/types.ts. Tolerate unknown role keys ("required"). Re-verify on Stalwart upgrades.
 * - extensions: x:* admin ops (settings get/update) and sieve specifics, exposed to
 *   ops/admin.ts. Gate nothing here — gating (ENABLE_ADMIN_TOOLS) is the frontends' job.
 * - quirks: expandRequiresBounds=true, hybridSchedulingShapes=true, etc.
 *
 * The core MUST compile without this module being "special": a Fastmail/Cyrus account should
 * work by pointing the session URL at it with a generic provider.
 */
import type { Provider } from "./types.ts";

export function stalwartProvider(): Provider {
  throw new Error("not implemented: core/provider/stalwart stalwartProvider");
}

/**
 * Spec-conservative fallback provider: identity normalizers that only bridge the hybrid
 * unions (no server-specific extensions, no quirks beyond spec defaults).
 */
export function genericProvider(): Provider {
  throw new Error("not implemented: core/provider/stalwart genericProvider");
}
