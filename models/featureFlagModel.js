import mongoose from "mongoose";

const flagType = { type: String, enum: ["enabled", "hidden", "disabled"], default: "enabled" };
const flagTypeOff = { type: String, enum: ["enabled", "hidden", "disabled"], default: "disabled" };

const featureFlagSchema = new mongoose.Schema(
  {
    // Navigation / page-level features
    events: flagType,
    inventory: flagType,
    exclusionRules: flagType,
    importEvents: flagType,
    addEvent: flagType,
    orders: flagType,
    exportCsv: flagType,
    purchaseAccounts: flagType,

    // Sub-features within Export CSV
    csvScheduler: flagType,
    csvManualExport: flagType,
    csvDownload: flagType,
    minSeatFilter: flagType,
    lowSeatAutoStop: flagType,

    // Sub-features within Events
    eventEdit: flagType,
    eventExclusions: flagType,

    // Other features
    autoDelete: flagType,
    proxies: flagTypeOff,
  },
  {
    timestamps: true,
  }
);

export const FeatureFlags =
  mongoose.models.FeatureFlags ||
  mongoose.model("FeatureFlags", featureFlagSchema);
