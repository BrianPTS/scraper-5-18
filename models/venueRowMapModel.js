import mongoose from "mongoose";

/**
 * VenueRowMap — permanent per-venue cache of Ticketmaster's front-to-back
 * row order for each section, derived from the seat-map API
 * (mapsapi.tmol.io) or from the Discovery API SVG fallback.
 *
 * Row order within a section is stable across every event a venue hosts,
 * so a single successful map fetch per (venue, section) is enough forever.
 * Subsequent scrapes read `rowRank` from this cache without needing another
 * live map call — this keeps the dominated-listings ranker accurate even
 * when TM's map endpoint later returns 403/404 or blocks the request.
 *
 * The `rows` array is stored in the exact front-to-back order Ticketmaster
 * returns it: rows[0] = closest to stage/field, rows[N-1] = worst.
 *
 * Populate paths (in `source`):
 *   mapsapi    — primary, playwright helpers/seatBatch.js after GetMapSeats
 *   discovery  — fallback, playwright lib/tmDiscoveryMapFetcher.js
 *   manual     — reserved for admin overrides
 */

const venueRowMapSchema = new mongoose.Schema(
  {
    venue: { type: String, required: true },
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

venueRowMapSchema.index({ venue: 1, section: 1 }, { unique: true });

export const VenueRowMap =
  mongoose.models.VenueRowMap ||
  mongoose.model("VenueRowMap", venueRowMapSchema);
