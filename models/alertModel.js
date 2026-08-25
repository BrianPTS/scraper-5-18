import mongoose from "mongoose";

const alertSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, index: true },
    eventName: { type: String, required: true },
    venue: { type: String },
    eventDate: { type: Date },
    eventUrl: { type: String },
    type: {
      type: String,
      required: true,
      enum: ["priceDrop", "undercut", "newStandard", "newLow", "arbitrage"],
      index: true,
    },
    section: { type: String, index: true },
    row: { type: String },
    seats: { type: String },
    seatCount: { type: Number },
    tag: { type: String },
    oldPrice: { type: Number },
    newPrice: { type: Number },
    price: { type: Number },
    sectionLow: { type: Number },
    dropPct: { type: Number },
    undercutPct: { type: Number },
    matchedRuleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "WatchlistRule" }],
    payload: { type: mongoose.Schema.Types.Mixed },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true },
);

alertSchema.index({ eventId: 1, at: -1 });
alertSchema.index({ type: 1, at: -1 });
alertSchema.index({ at: -1 });

export const Alert =
  mongoose.models.Alert || mongoose.model("Alert", alertSchema);
