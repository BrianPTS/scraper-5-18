import mongoose from "mongoose";

/**
 * RemovalLog — one entry per listing per CSV emit run, documenting
 * exactly why that listing was kept or removed. The audit contract is:
 *
 *   Every listing in the raw input must produce exactly one entry.
 *   Every REMOVED entry must carry a `reason` from the known enum.
 *   If we cannot attribute a removal, the listing gets re-added to the
 *   emit and an entry with reason='UNKNOWN' is written to raise alarms.
 *
 * runId groups every entry from one CSV emit call. lookup by
 * (inventoryId, emittedAt) traces a specific listing across runs.
 * TTL index at 30 days keeps the collection bounded.
 */

const removalLogSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, index: true },
    emittedAt: { type: Date, required: true },
    inventoryId: { type: String, required: true },
    eventId: { type: String, required: true, index: true },
    section: { type: String, default: "" },
    row: { type: String, default: "" },
    quantity: { type: Number, default: 0 },
    customSplit: { type: String, default: "" },
    tags: { type: String, default: "" },
    tier: {
      type: String,
      enum: ["broker", "fan", "standard", "other"],
      default: "other",
    },
    listPrice: { type: Number, default: 0 },
    facePrice: { type: Number, default: 0 },
    outcome: {
      type: String,
      required: true,
      enum: ["KEPT", "REMOVED"],
    },
    reason: {
      type: String,
      required: true,
      enum: [
        // KEPT reasons
        "CLEAN_SURVIVOR",
        "PASSTHROUGH",
        "SYNTHETIC_COVER",
        "SYNTHETIC_COMBINED",
        "RECOVERED_NO_ATTRIBUTION", // re-added because no filter claimed it
        // REMOVED reasons
        "DOMINATED",
        "SECTION_ROW_EXCLUSION",
        "BLOCKED_VENUE_STATE",
        "STANDARD_DROP_HOLD",
        "MIN_SEAT_ROW",
        "MIN_SEAT_SECTION",
        "HOLD_OFFER",
        "PACKAGE_OFFER",
        "MANUAL_REMOVE",
        // Escape hatch: this is the "we don't know" bucket. Any entry
        // here must fire an alert; the corresponding listing should
        // have been re-added to the emit under RECOVERED_NO_ATTRIBUTION.
        "UNKNOWN",
      ],
    },
    detail: { type: String, default: "" },
    dominatorInventoryId: { type: String, default: "" },
  },
  { timestamps: true },
);

removalLogSchema.index({ inventoryId: 1, emittedAt: -1 });
removalLogSchema.index({ runId: 1, eventId: 1 });
// TTL: 30 days
removalLogSchema.index({ emittedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const RemovalLog =
  mongoose.models.RemovalLog ||
  mongoose.model("RemovalLog", removalLogSchema);
