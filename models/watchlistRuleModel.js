import mongoose from "mongoose";

/**
 * Watchlist rule — a user-defined subscription that surfaces alerts.
 *
 * Every scraped event feeds the alert engine; this rule decides which
 * alerts reach a user and via which channel.
 *
 * Scopes:
 *   event   — one specific eventId
 *   team    — every event with this team as home or visitor
 *   venue   — every event at this venue
 *   any     — global (all NFL, or all events matching taxonomy/type)
 *
 * Two built-in rule types are auto-attached to every watched event and
 * cannot be scope-limited:
 *   getInLow — fires on every new event floor
 *   arbitrage — fires on ticket-count arbitrage opportunities
 */

const watchlistRuleSchema = new mongoose.Schema(
  {
    userId: { type: String, index: true },
    label: { type: String, default: "" },

    scope: {
      type: String,
      required: true,
      enum: ["event", "team", "venue", "any"],
      default: "event",
    },
    scopeValue: { type: String }, // eventId | team slug | venue name | "" for any
    taxonomy: { type: String }, // optional: nfl, nba, nhl, mlb (only for scope=any)

    // Match criteria
    alertType: {
      type: String,
      enum: [
        "",
        "priceDrop",
        "undercut",
        "newStandard",
        "newLow",
        "arbitrage",
      ],
      default: "",
    },
    sectionPattern: { type: String, default: "" }, // "101", "C1**", "M,H,412", ""=any
    minDropPct: { type: Number },
    minUndercutPct: { type: Number },
    minArbSpreadPct: { type: Number },

    // Notification channels
    channels: {
      email: { type: Boolean, default: true },
      discord: { type: Boolean, default: false },
      sms: { type: Boolean, default: false }, // scaffold only, needs Twilio
      voice: { type: Boolean, default: false }, // scaffold only, needs Twilio
    },
    critical: { type: Boolean, default: false }, // enables voice/SMS if configured

    // Auto-attached built-ins — user cannot delete these, only toggle
    autoAttached: { type: Boolean, default: false },
    autoType: {
      type: String,
      enum: ["", "getInLow", "arbitrage"],
      default: "",
    },

    active: { type: Boolean, default: true },
    lastFiredAt: { type: Date },
    fireCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

watchlistRuleSchema.index({ scope: 1, scopeValue: 1, active: 1 });
watchlistRuleSchema.index({ userId: 1, active: 1 });

export const WatchlistRule =
  mongoose.models.WatchlistRule ||
  mongoose.model("WatchlistRule", watchlistRuleSchema);
