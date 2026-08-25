import mongoose from "mongoose";

/**
 * Per-event inventory snapshot, written every ~15 min per event.
 *
 * Powers the sold-out projection curve, the time-of-day heatmap, the
 * "sold since baseline" tile, and any other historical time-series view.
 *
 * Retention: raw 15-min points kept for 90 days (TTL index below), then
 * a daily aggregation job (not in this commit) rolls older data into
 * one-per-day rows in the same collection.
 */

const inventorySnapshotSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, index: true },
    snapshotAt: { type: Date, required: true, default: Date.now, index: true },

    totalListings: { type: Number, required: true },
    totalSeats: { type: Number },

    minPrice: { type: Number },
    medianPrice: { type: Number },
    avgPrice: { type: Number },
    maxPrice: { type: Number },

    // Cheapest listing details (get-in tracker source)
    getInPrice: { type: Number },
    getInSection: { type: String },
    getInRow: { type: String },
    getInQty: { type: Number },

    byInventoryType: { type: mongoose.Schema.Types.Mixed },
    byTag: { type: mongoose.Schema.Types.Mixed },
    bySection: [
      {
        _id: false,
        section: String,
        count: Number,
        minPrice: Number,
        avgPrice: Number,
      },
    ],
  },
  { timestamps: false },
);

// Compound index for time-series reads per event
inventorySnapshotSchema.index({ eventId: 1, snapshotAt: 1 });

// TTL: drop raw snapshots after 90 days. Downsampled daily aggregates
// live in a sibling collection (or a separate flag once we add it).
inventorySnapshotSchema.index(
  { snapshotAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 90 },
);

export const InventorySnapshot =
  mongoose.models.InventorySnapshot ||
  mongoose.model("InventorySnapshot", inventorySnapshotSchema);
