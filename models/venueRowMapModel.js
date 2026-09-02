import mongoose from "mongoose";

/**
 * EventRowMap — permanent per-event cache of Ticketmaster's front-to-back
 * row order for each section, derived from the seat-map API
 * (mapsapi.tmol.io) or from the Discovery API SVG fallback.
 *
 * Keyed by (eventId, section). One successful map fetch per event
 * populates it forever and every subsequent scrape reads from cache
 * without needing another live map call — this keeps the dominated-
 * listings ranker accurate even when TM's map endpoint later returns
 * 403/404 or blocks the request.
 *
 * The `rows` array is stored in the exact front-to-back order Ticketmaster
 * returns it: rows[0] = closest to stage/field, rows[N-1] = worst.
 *
 * Populate paths (in `source`):
 *   mapsapi    — primary, playwright helpers/seatBatch.js after GetMapSeats
 *   discovery  — fallback, playwright lib/tmDiscoveryMapFetcher.js
 *   manual     — reserved for admin overrides
 */

const eventRowMapSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    venue: { type: String, default: "" },
    section: { type: String, required: true },
    rows: { type: [String], default: [] },
    source: {
      type: String,
      enum: ["mapsapi", "discovery", "manual"],
      default: "mapsapi",
    },
    lastFetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

eventRowMapSchema.index({ eventId: 1, section: 1 }, { unique: true });

export const EventRowMap =
  mongoose.models.EventRowMap ||
  mongoose.model("EventRowMap", eventRowMapSchema);

// Back-compat alias — earlier code referenced VenueRowMap.
export const VenueRowMap = EventRowMap;
